// Paid sync subscriptions, sold through Polar (a merchant of record). Polar tells us about every
// change with a signed webhook (the Standard Webhooks scheme); we keep the latest state per user.
//
// A user is linked to their subscription by `external_customer_id`: checkout is created with our
// user id there, and it comes back as `customer.external_id`. The customer's email is never used
// to link, since anyone can type any email at checkout.

import { isAdmin } from './accounts.ts';
import type { Env } from './cf.ts';
import { constantTimeEqual } from './crypto.ts';
import { HttpError } from './http.ts';

/** Webhooks older or newer than this are refused, which stops a captured one being replayed later. */
const TOLERANCE_MS = 5 * 60 * 1000;

/** Statuses that entitle the user to sync. A canceled subscription stays `active` until its period ends. */
const PAID = new Set(['active', 'trialing']);
const PAID_SQL = [...PAID].map((status) => `'${status}'`).join(', ');

/** The subscription object inside Polar's `subscription.*` events (only what we read). */
interface PolarSubscription {
  id: string;
  status: string;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  created_at?: string;
  modified_at?: string | null;
  customer?: { external_id?: string | null };
}

export interface Subscription {
  status: string;
  /** Whether the user currently has sync. */
  active: boolean;
  currentPeriodEnd: number | null;
  /** Canceled, but paid up until `currentPeriodEnd`. */
  cancelAtPeriodEnd: boolean;
}

async function hmacBase64(keyBytes: Uint8Array, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The keys a Polar signing secret (`polar_whs_<base64>`) can mean. Polar signs with the base64-decoded
 * part after the prefix, as the Standard Webhooks scheme does, which a real webhook confirmed; the
 * secret's own UTF-8 bytes are also tried. Both come from the one secret, so trying either is no weaker.
 */
function signingKeys(secret: string): Uint8Array[] {
  const keys = [new TextEncoder().encode(secret)];
  try {
    keys.unshift(Uint8Array.from(atob(secret.replace(/^[a-z]+_[a-z]+_|^whsec_/, '')), (c) => c.charCodeAt(0)));
  } catch {
    // Not base64: only the plain bytes apply.
  }
  return keys;
}

/**
 * Whether the request really came from Polar. It signs `<id>.<timestamp>.<body>` with HMAC-SHA256
 * and sends `v1,<base64>` (possibly several, space-separated, while a secret is being rotated).
 */
export async function verifyPolarSignature(secret: string, headers: Headers, body: string, now = Date.now()): Promise<boolean> {
  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signatures = headers.get('webhook-signature');
  if (!id || !timestamp || !signatures) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now - seconds * 1000) > TOLERANCE_MS) return false;
  const message = `${id}.${timestamp}.${body}`;
  const sent = signatures.split(' ').flatMap((entry) => {
    const [version, signature] = entry.split(',');
    return version === 'v1' && signature ? [signature] : [];
  });
  for (const key of signingKeys(secret)) {
    const expected = await hmacBase64(key, message);
    if (sent.some((signature) => constantTimeEqual(signature, expected))) return true;
  }
  return false;
}

const ms = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};

/** Records one `subscription.*` event. Events about anything else, or a customer we can't place, are ignored. */
export async function recordPolarEvent(env: Env, event: { type?: string; data?: PolarSubscription }, now = Date.now()): Promise<void> {
  const sub = event.data;
  if (!event.type?.startsWith('subscription.') || !sub?.id || !sub.status) return;
  const userId = sub.customer?.external_id;
  if (!userId) return;
  const modifiedAt = ms(sub.modified_at) ?? ms(sub.created_at) ?? now;
  // Events can arrive out of order (and Polar retries): only a newer state replaces the stored one.
  // Someone can have more than one subscription (a new one bought while an old one was past due):
  // news about a different subscription that isn't paid never replaces one that is.
  await env.DIRECTORY.prepare(
    `INSERT INTO subscriptions (user_id, polar_id, status, current_period_end, cancel_at_period_end, modified_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET polar_id = excluded.polar_id, status = excluded.status,
       current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
       modified_at = excluded.modified_at, updated_at = excluded.updated_at
     WHERE excluded.modified_at >= subscriptions.modified_at
       AND (excluded.polar_id = subscriptions.polar_id OR excluded.status IN (${PAID_SQL}) OR subscriptions.status NOT IN (${PAID_SQL}))`,
  )
    .bind(userId, sub.id, sub.status, ms(sub.current_period_end), sub.cancel_at_period_end ? 1 : 0, modifiedAt, now)
    .run();
}

/** POST /api/webhooks/polar. No session: the signature is the authentication. */
export async function handlePolarWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.POLAR_WEBHOOK_SECRET) throw new HttpError(503, 'payments are not configured');
  const body = await request.text();
  if (!(await verifyPolarSignature(env.POLAR_WEBHOOK_SECRET, request.headers, body))) {
    // Never the secret or the signatures themselves: only what tells a stale timestamp from a wrong secret.
    const seconds = Number(request.headers.get('webhook-timestamp'));
    console.error('polar webhook refused', { ageSeconds: Number.isFinite(seconds) ? Math.round(Date.now() / 1000 - seconds) : null, bodyLength: body.length });
    throw new HttpError(401, 'bad signature');
  }
  let event: { type?: string; data?: PolarSubscription };
  try {
    event = JSON.parse(body);
  } catch {
    throw new HttpError(400, 'bad json');
  }
  await recordPolarEvent(env, event);
  // Anything but 2xx makes Polar retry, so even events we ignore are acknowledged.
  return new Response(null, { status: 202 });
}

/** Whether a stored subscription entitles its user to sync now: a paid status that has not run out (a missed "period ended" webhook must not leave someone paid for ever). */
export function isPaid(row: { status: string; current_period_end: number | null }, now = Date.now()): boolean {
  return PAID.has(row.status) && !(row.current_period_end !== null && row.current_period_end < now - TOLERANCE_MS);
}

/** The user's subscription, or null if they never had one. */
export async function subscriptionFor(env: Env, userId: string, now = Date.now()): Promise<Subscription | null> {
  const row = await env.DIRECTORY.prepare('SELECT status, current_period_end, cancel_at_period_end FROM subscriptions WHERE user_id = ?')
    .bind(userId)
    .first<{ status: string; current_period_end: number | null; cancel_at_period_end: number }>();
  if (!row) return null;
  return { status: row.status, active: isPaid({ status: row.status, current_period_end: row.current_period_end }, now), currentPeriodEnd: row.current_period_end, cancelAtPeriodEnd: !!row.cancel_at_period_end };
}

async function polar<T>(env: Env, path: string, body: unknown): Promise<T> {
  if (!env.POLAR_ACCESS_TOKEN) throw new HttpError(503, 'payments are not configured');
  const response = await fetch(`${env.POLAR_API_URL || 'https://api.polar.sh'}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const reply = (await response.json().catch(() => null)) as T | null;
  if (!response.ok || !reply) throw new HttpError(502, `Polar refused the request (status ${response.status})`);
  return reply;
}

/**
 * Where to send the user to pay: a Polar checkout for the monthly sync product, tied to their
 * account by `external_customer_id`. Someone who already has sync is refused rather than billed twice.
 */
export async function startCheckout(env: Env, userId: string, returnTo: string): Promise<{ url: string }> {
  if (!env.POLAR_PRODUCT_ID) throw new HttpError(503, 'payments are not configured');
  if ((await subscriptionFor(env, userId))?.active) throw new HttpError(409, 'already subscribed');
  // Their verified sign-in email saves typing it; it is only a convenience, never how we link them.
  const known = await env.DIRECTORY.prepare('SELECT email FROM identities WHERE user_id = ? AND email_verified = 1 AND email IS NOT NULL LIMIT 1')
    .bind(userId)
    .first<{ email: string }>();
  const checkout = await polar<{ url?: string }>(env, '/v1/checkouts/', {
    products: [env.POLAR_PRODUCT_ID],
    external_customer_id: userId,
    ...(known ? { customer_email: known.email } : {}),
    success_url: returnTo,
  });
  if (!checkout.url) throw new HttpError(502, 'Polar sent no checkout address');
  return { url: checkout.url };
}

/** Where the user manages their subscription (cancel, change card, invoices): Polar's customer portal. */
export async function startPortal(env: Env, userId: string): Promise<{ url: string }> {
  if (!(await subscriptionFor(env, userId))) throw new HttpError(404, 'no subscription');
  const session = await polar<{ customer_portal_url?: string }>(env, '/v1/customer-sessions/', { external_customer_id: userId });
  if (!session.customer_portal_url) throw new HttpError(502, 'Polar sent no portal address');
  return { url: session.customer_portal_url };
}

/**
 * Whether the account may keep documents in the cloud (upload, share, edit together): a subscriber
 * (a trial counts) or an admin. Anyone, while `REQUIRE_SUBSCRIPTION` is off (the rollout switch) or
 * when running locally, where there is no Polar to ask.
 * Everything else stays free: the app in the browser, and opening what a subscriber shares.
 */
export async function hasSync(env: Env, userId: string): Promise<boolean> {
  if (env.ENVIRONMENT === 'local' || env.REQUIRE_SUBSCRIPTION !== 'true') return true;
  if ((await subscriptionFor(env, userId))?.active) return true;
  return isAdmin(env, userId);
}

/** The refusal for someone who needs a subscription to do this: 402, with a code the page recognises. */
export const subscriptionRequired = (message = 'sync is for subscribers'): HttpError => new HttpError(402, message, 'subscription');
