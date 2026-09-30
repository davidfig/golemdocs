// Paid sync subscriptions, sold through Polar (a merchant of record). Polar tells us about every
// change with a signed webhook (the Standard Webhooks scheme); we keep the latest state per user.
//
// A user is linked to their subscription by `external_customer_id`: checkout is created with our
// user id there, and it comes back as `customer.external_id`. The customer's email is never used
// to link, since anyone can type any email at checkout.

import type { Env } from './cf.ts';
import { constantTimeEqual } from './crypto.ts';
import { HttpError } from './http.ts';

/** Webhooks older or newer than this are refused, which stops a captured one being replayed later. */
const TOLERANCE_MS = 5 * 60 * 1000;

/** Statuses that entitle the user to sync. A canceled subscription stays `active` until its period ends. */
const PAID = new Set(['active', 'trialing']);

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

async function hmacBase64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Whether the request really came from Polar. It signs `<id>.<timestamp>.<body>` with HMAC-SHA256
 * and sends `v1,<base64>` (possibly several, space-separated, while a secret is being rotated).
 * Polar's docs and SDK use the secret string's own UTF-8 bytes as the key, not a decoded form.
 */
export async function verifyPolarSignature(secret: string, headers: Headers, body: string, now = Date.now()): Promise<boolean> {
  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signatures = headers.get('webhook-signature');
  if (!id || !timestamp || !signatures) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now - seconds * 1000) > TOLERANCE_MS) return false;
  const expected = await hmacBase64(secret, `${id}.${timestamp}.${body}`);
  return signatures.split(' ').some((entry) => {
    const [version, signature] = entry.split(',');
    return version === 'v1' && !!signature && constantTimeEqual(signature, expected);
  });
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
  await env.DIRECTORY.prepare(
    `INSERT INTO subscriptions (user_id, polar_id, status, current_period_end, cancel_at_period_end, modified_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET polar_id = excluded.polar_id, status = excluded.status,
       current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
       modified_at = excluded.modified_at, updated_at = excluded.updated_at
     WHERE excluded.modified_at >= subscriptions.modified_at`,
  )
    .bind(userId, sub.id, sub.status, ms(sub.current_period_end), sub.cancel_at_period_end ? 1 : 0, modifiedAt, now)
    .run();
}

/** POST /api/webhooks/polar. No session: the signature is the authentication. */
export async function handlePolarWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.POLAR_WEBHOOK_SECRET) throw new HttpError(503, 'payments are not configured');
  const body = await request.text();
  if (!(await verifyPolarSignature(env.POLAR_WEBHOOK_SECRET, request.headers, body))) throw new HttpError(401, 'bad signature');
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

/** The user's subscription, or null if they never had one. */
export async function subscriptionFor(env: Env, userId: string, now = Date.now()): Promise<Subscription | null> {
  const row = await env.DIRECTORY.prepare('SELECT status, current_period_end, cancel_at_period_end FROM subscriptions WHERE user_id = ?')
    .bind(userId)
    .first<{ status: string; current_period_end: number | null; cancel_at_period_end: number }>();
  if (!row) return null;
  // A missed "period ended" webhook must not leave someone paid for ever.
  const lapsed = row.current_period_end !== null && row.current_period_end < now - TOLERANCE_MS;
  return { status: row.status, active: PAID.has(row.status) && !lapsed, currentPeriodEnd: row.current_period_end, cancelAtPeriodEnd: !!row.cancel_at_period_end };
}
