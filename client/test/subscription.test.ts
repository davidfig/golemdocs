// The page's side of the paid subscription: asking the server, and waiting for a payment to arrive.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { checkoutUrl, fetchSubscription, portalUrl, sellsSubscriptions, SubscriptionError, waitForSubscription } from '../src/subscription.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const stub = (respond: (url: string, method: string) => Response) => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return respond(url, init?.method ?? 'GET');
  }) as typeof fetch;
  return calls;
};
const plan = (active: boolean) => ({ status: active ? 'active' : 'none', active, currentPeriodEnd: null, cancelAtPeriodEnd: false });

test('the subscription is what the server says, and null when it can\'t be asked', async () => {
  stub(() => Response.json(plan(true)));
  assert.equal((await fetchSubscription())?.active, true);
  stub(() => new Response('no', { status: 401 }));
  assert.equal(await fetchSubscription(), null);
  globalThis.fetch = (async () => {
    throw new TypeError('offline');
  }) as typeof fetch;
  assert.equal(await fetchSubscription(), null);
});

test('checkout and the portal each post to the server and return the address it gives', async () => {
  const calls = stub((url) => Response.json({ url: `https://polar.example${url}` }));
  assert.equal(await checkoutUrl(), 'https://polar.example/api/checkout');
  assert.equal(await portalUrl(), 'https://polar.example/api/portal');
  assert.deepEqual(calls, ['POST /api/checkout', 'POST /api/portal']);
});

test('a refusal carries the server\'s status and reason', async () => {
  stub(() => Response.json({ error: 'already subscribed' }, { status: 409 }));
  await assert.rejects(checkoutUrl(), (e: unknown) => e instanceof SubscriptionError && e.status === 409 && e.message === 'already subscribed');
  stub(() => new Response('<html>', { status: 502 }));
  await assert.rejects(portalUrl(), (e: unknown) => e instanceof SubscriptionError && e.status === 502 && /502/.test(e.message));
});

test('waiting for a payment stops as soon as the subscription is active', async () => {
  let asked = 0;
  stub(() => Response.json(plan(++asked >= 3)));
  const found = await waitForSubscription({ attempts: 10, delayMs: 1 });
  assert.equal(found?.active, true);
  assert.equal(asked, 3);
});

test('waiting gives up after the attempts it was given', async () => {
  let asked = 0;
  stub(() => {
    asked++;
    return Response.json(plan(false));
  });
  assert.equal(await waitForSubscription({ attempts: 4, delayMs: 1 }), null);
  assert.equal(asked, 4);
});

test('the subscription is sold on the website and in the desktop app, never in the phone apps', () => {
  const g = globalThis as Record<string, unknown>;
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const as = (userAgent: string, shell: boolean) => {
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent, platform: 'iPhone', maxTouchPoints: 5 }, configurable: true });
    if (shell) g.__TAURI__ = { core: { invoke: async () => undefined } };
    else delete g.__TAURI__;
    return sellsSubscriptions();
  };
  try {
    assert.equal(as('Mozilla/5.0 (iPhone)', false), true, 'the website on a phone');
    assert.equal(as('Mozilla/5.0 (iPhone)', true), false, 'the iOS app');
    assert.equal(as('Mozilla/5.0 (Linux; Android 15)', true), false, 'the Android app');
  } finally {
    delete g.__TAURI__;
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  }
});
