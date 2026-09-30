// Polar webhooks: signature checking, keeping the latest subscription per user, and what the user sees.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { verifyPolarSignature } from '../src/subscriptions.ts';
import { world, type World } from './harness.ts';

const SECRET = 'polar_whs_test';
let w: World;
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
  const alice = await w.signUp('alice@example.com');
  assert.equal((await post(event(alice))).status, 202);
  const r = await w.call('alice@example.com', 'GET', '/api/subscription');
  const s = (await r.json()) as any;
  assert.equal(s.active, true);
  assert.equal(s.status, 'active');
  assert.equal(s.cancelAtPeriodEnd, false);
});

test('a user with no subscription is not active', async () => {
  await w.signUp('alice@example.com');
  const s = (await (await w.call('alice@example.com', 'GET', '/api/subscription')).json()) as any;
  assert.deepEqual(s, { status: 'none', active: false, currentPeriodEnd: null, cancelAtPeriodEnd: false });
  assert.equal((await w.call(null, 'GET', '/api/subscription')).status, 401);
});

test('unsigned, wrongly signed, tampered and stale webhooks are refused and change nothing', async () => {
  const alice = await w.signUp('alice@example.com');
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
  const alice = await w.signUp('alice@example.com');
  await post(event(alice, { status: 'canceled', modified_at: '2026-09-20T00:00:00Z' }, 'subscription.canceled'));
  await post(event(alice, { status: 'active', modified_at: '2026-09-10T00:00:00Z' }));
  const s = (await (await w.call('alice@example.com', 'GET', '/api/subscription')).json()) as any;
  assert.equal(s.status, 'canceled');
  assert.equal(s.active, false);
});

test('a canceled subscription is paid until the period ends, and says so', async () => {
  const alice = await w.signUp('alice@example.com');
  await post(event(alice, { cancel_at_period_end: true }, 'subscription.canceled'));
  const s = (await (await w.call('alice@example.com', 'GET', '/api/subscription')).json()) as any;
  assert.equal(s.active, true);
  assert.equal(s.cancelAtPeriodEnd, true);
});

test('a lapsed period is not paid even if the "ended" webhook never came', async () => {
  const alice = await w.signUp('alice@example.com');
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
