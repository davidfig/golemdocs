// Polar webhooks: signature checking, keeping the latest subscription per user, and what the user sees.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { verifyPolarSignature } from '../src/subscriptions.ts';
import { world, type World } from './harness.ts';

const SECRET = 'polar_whs_test';
let w: World;
// These tests are about how a subscription starts and ends, so nobody has one until a webhook says so.
const unsubscribed = (email: string) => w.signUp(email);
beforeEach(() => {
  w = world();
  w.env.POLAR_WEBHOOK_SECRET = SECRET;
});
afterEach(() => w.restore());

async function sign(body: string, id = 'msg_1', seconds = Math.floor(Date.now() / 1000), secret = SECRET) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${seconds}.${body}`)));
  return { 'webhook-id': id, 'webhook-timestamp': String(seconds), 'webhook-signature': `v1,${btoa(String.fromCharCode(...mac))}` };
}

const event = (userId: string | null, over: Record<string, unknown> = {}, type = 'subscription.active') =>
  JSON.stringify({
    type,
    data: {
      id: 'sub_1',
      status: 'active',
      current_period_end: new Date(Date.now() + 30 * 86400_000).toISOString(),
      cancel_at_period_end: false,
      created_at: '2026-09-01T00:00:00Z',
      modified_at: '2026-09-01T00:00:00Z',
      customer: { external_id: userId },
      ...over,
    },
  });

const post = async (body: string, headers?: Record<string, string>) =>
  w.call(null, 'POST', '/api/webhooks/polar', { body, type: 'application/json', headers: headers ?? (await sign(body)) });

test('a correctly signed subscription event is recorded and the user sees it', async () => {
  const alice = await unsubscribed('alice@example.com');
  assert.equal((await post(event(alice))).status, 202);
  const r = await w.call('alice@example.com', 'GET', '/api/subscription');
  const s = (await r.json()) as any;
  assert.equal(s.active, true);
  assert.equal(s.status, 'active');
  assert.equal(s.cancelAtPeriodEnd, false);
});

test('a user with no subscription is not active, and has no sync once it is required', async () => {
  await unsubscribed('alice@example.com');
  const status = async () => (await (await w.call('alice@example.com', 'GET', '/api/subscription')).json()) as any;
  assert.deepEqual(await status(), { status: 'none', active: false, currentPeriodEnd: null, cancelAtPeriodEnd: false, sync: true }, 'free while the requirement is off');
  w.env.REQUIRE_SUBSCRIPTION = 'true';
  assert.deepEqual(await status(), { status: 'none', active: false, currentPeriodEnd: null, cancelAtPeriodEnd: false, sync: false });
  assert.equal((await w.call(null, 'GET', '/api/subscription')).status, 401);
});

test('unsigned, wrongly signed, tampered and stale webhooks are refused and change nothing', async () => {
  const alice = await unsubscribed('alice@example.com');
  const body = event(alice);
  assert.equal((await post(body, {})).status, 401);
  assert.equal((await post(body, await sign(body, 'm', undefined, 'other-secret'))).status, 401);
  assert.equal((await post(body.replace('active', 'trialing'), await sign(body))).status, 401);
  assert.equal((await post(body, await sign(body, 'm', Math.floor(Date.now() / 1000) - 3600))).status, 401);
  assert.equal(w.directory.prepare('SELECT COUNT(*) AS n FROM subscriptions').get()!.n, 0);
});

test('without a configured secret the endpoint is off', async () => {
  delete w.env.POLAR_WEBHOOK_SECRET;
  assert.equal((await post(event('x'))).status, 503);
});

test('a rotated secret sends two signatures, and either one passes', async () => {
  const body = '{}';
  const good = (await sign(body))['webhook-signature'];
  const headers = new Headers({ ...(await sign(body)), 'webhook-signature': `v1,AAAA ${good}` });
  assert.equal(await verifyPolarSignature(SECRET, headers, body), true);
});

test('an older event arriving late does not undo a newer one', async () => {
  const alice = await unsubscribed('alice@example.com');
  await post(event(alice, { status: 'canceled', modified_at: '2026-09-20T00:00:00Z' }, 'subscription.canceled'));
  await post(event(alice, { status: 'active', modified_at: '2026-09-10T00:00:00Z' }));
  const s = (await (await w.call('alice@example.com', 'GET', '/api/subscription')).json()) as any;
  assert.equal(s.status, 'canceled');
  assert.equal(s.active, false);
});

test('a canceled subscription is paid until the period ends, and says so', async () => {
  const alice = await unsubscribed('alice@example.com');
  await post(event(alice, { cancel_at_period_end: true }, 'subscription.canceled'));
  const s = (await (await w.call('alice@example.com', 'GET', '/api/subscription')).json()) as any;
  assert.equal(s.active, true);
  assert.equal(s.cancelAtPeriodEnd, true);
});

test('a lapsed period is not paid even if the "ended" webhook never came', async () => {
  const alice = await unsubscribed('alice@example.com');
  await post(event(alice, { current_period_end: new Date(Date.now() - 86400_000).toISOString() }));
  const s = (await (await w.call('alice@example.com', 'GET', '/api/subscription')).json()) as any;
  assert.equal(s.status, 'active');
  assert.equal(s.active, false);
});

test('events we cannot place, or that are not about subscriptions, are acknowledged and ignored', async () => {
  assert.equal((await post(event(null))).status, 202);
  assert.equal((await post(JSON.stringify({ type: 'order.created', data: { id: 'o' } }))).status, 202);
  assert.equal((await post('not json', await sign('not json'))).status, 400);
  assert.equal(w.directory.prepare('SELECT COUNT(*) AS n FROM subscriptions').get()!.n, 0);
});

// --- Checkout and portal (Polar's API is stubbed) ---

interface PolarCall { url: string; auth: string | null; body: any }
function stubPolar(reply: () => Response): PolarCall[] {
  const calls: PolarCall[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (!url.startsWith('https://api.polar.sh')) return inner(input, init);
    calls.push({ url, auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(init.body) });
    return reply();
  }) as typeof fetch;
  return calls;
}
const configured = () => {
  w.env.POLAR_ACCESS_TOKEN = 'polar_oat_test';
  w.env.POLAR_PRODUCT_ID = 'prod_1';
};
const ALICE = 'alice@example.com';

test('checkout asks Polar for a session tied to the user, and returns its address', async () => {
  configured();
  const alice = await unsubscribed(ALICE);
  const calls = stubPolar(() => Response.json({ url: 'https://buy.polar.sh/c/1' }));
  const r = await w.call(ALICE, 'POST', '/api/checkout');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { url: 'https://buy.polar.sh/c/1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://api.polar.sh/v1/checkouts/');
  assert.equal(calls[0]!.auth, 'Bearer polar_oat_test');
  assert.deepEqual(calls[0]!.body, { products: ['prod_1'], external_customer_id: alice, customer_email: ALICE, success_url: 'https://app.example.com/?subscribed=1' });
});

test('checkout needs a signed-in user, and payments to be configured', async () => {
  await unsubscribed(ALICE);
  const calls = stubPolar(() => Response.json({ url: 'x' }));
  assert.equal((await w.call(null, 'POST', '/api/checkout')).status, 401);
  assert.equal((await w.call(ALICE, 'POST', '/api/checkout')).status, 503, 'no product or token');
  w.env.POLAR_PRODUCT_ID = 'prod_1';
  assert.equal((await w.call(ALICE, 'POST', '/api/checkout')).status, 503, 'no token');
  assert.equal(calls.length, 0);
});

test('someone who already has sync is not sent to pay again', async () => {
  configured();
  const alice = await unsubscribed(ALICE);
  await post(event(alice));
  const calls = stubPolar(() => Response.json({ url: 'x' }));
  assert.equal((await w.call(ALICE, 'POST', '/api/checkout')).status, 409);
  assert.equal(calls.length, 0);
});

test('a lapsed subscriber can subscribe again', async () => {
  configured();
  const alice = await unsubscribed(ALICE);
  await post(event(alice, { status: 'canceled' }, 'subscription.canceled'));
  stubPolar(() => Response.json({ url: 'https://buy.polar.sh/c/2' }));
  assert.equal((await w.call(ALICE, 'POST', '/api/checkout')).status, 200);
});

test('a Polar failure is reported as a bad gateway, not a crash', async () => {
  configured();
  await unsubscribed(ALICE);
  stubPolar(() => new Response('nope', { status: 500 }));
  assert.equal((await w.call(ALICE, 'POST', '/api/checkout')).status, 502);
  stubPolar(() => Response.json({}));
  assert.equal((await w.call(ALICE, 'POST', '/api/checkout')).status, 502, 'a reply with no address');
});

test('the portal is for people who have a subscription, and opens their own', async () => {
  configured();
  const alice = await unsubscribed(ALICE);
  const calls = stubPolar(() => Response.json({ customer_portal_url: 'https://polar.sh/portal/1' }));
  assert.equal((await w.call(ALICE, 'POST', '/api/portal')).status, 404, 'never subscribed');
  await post(event(alice));
  const r = await w.call(ALICE, 'POST', '/api/portal');
  assert.deepEqual(await r.json(), { url: 'https://polar.sh/portal/1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://api.polar.sh/v1/customer-sessions/');
  assert.deepEqual(calls[0]!.body, { external_customer_id: alice });
});

test('a sandbox address can be configured', async () => {
  configured();
  w.env.POLAR_API_URL = 'https://sandbox-api.polar.sh';
  await unsubscribed(ALICE);
  let seen = '';
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    if (String(input).startsWith('https://sandbox-api.polar.sh')) {
      seen = String(input);
      return Response.json({ url: 'https://sandbox.polar.sh/c/1' });
    }
    return inner(input, init);
  }) as typeof fetch;
  assert.equal((await w.call(ALICE, 'POST', '/api/checkout')).status, 200);
  assert.equal(seen, 'https://sandbox-api.polar.sh/v1/checkouts/');
});
