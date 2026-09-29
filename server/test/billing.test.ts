// The admin billing summary: configuration checks, Cloudflare errors, totals by service, and the cache.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { Env } from '../src/cf.ts';
import { billingSummary } from '../src/billing.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const env = (over: Record<string, string> = {}) => ({ CF_API_TOKEN: 'token', CF_ACCOUNT_ID: 'acct', ...over }) as unknown as Env;
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const stub = (response: () => Response) => {
  const calls: { url: string; auth: string | null }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
    return response();
  }) as typeof fetch;
  return calls;
};
const status = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);

// The summary is cached for minutes, so tests that expect a fetch fail before the one that succeeds.
test('an account with no Cloudflare credentials, or the placeholder id, is not configured', async () => {
  const calls = stub(() => reply({}));
  assert.equal(await status(billingSummary(env({ CF_API_TOKEN: '' }))), 503);
  assert.equal(await status(billingSummary(env({ CF_ACCOUNT_ID: '' }))), 503);
  assert.equal(await status(billingSummary(env({ CF_ACCOUNT_ID: 'REPLACE_ME' }))), 503);
  assert.equal(calls.length, 0, 'nothing is sent without credentials');
});

test('a Cloudflare error is reported with its reason, and is not cached', async () => {
  stub(() => reply({ success: false, errors: [{ message: 'no access' }, { message: 'again' }] }, 403));
  await assert.rejects(billingSummary(env()), (e: { status: number; message: string }) => e.status === 502 && /no access; again/.test(e.message) && /Billing Read/.test(e.message));
  stub(() => new Response('<html>gateway</html>', { status: 500 }));
  await assert.rejects(billingSummary(env()), (e: { status: number; message: string }) => e.status === 502 && /status 500/.test(e.message));
});

test('charges are totaled by service, biggest first, from the start of this month', async () => {
  const calls = stub(() =>
    reply({
      success: true,
      result: [
        { ServiceName: 'Workers', BilledCost: 1.5, BillingCurrency: 'EUR' },
        { ServiceName: 'R2', EffectiveCost: 4 },
        { ServiceName: 'Workers', ContractedCost: 0.5 },
        { BilledCost: 0.25 },
        { ServiceName: 'D1' },
      ],
    }),
  );
  const summary = await billingSummary(env());
  assert.equal(summary.currency, 'EUR');
  assert.equal(summary.total, 6.25);
  assert.deepEqual(summary.services, [
    { name: 'R2', cost: 4 },
    { name: 'Workers', cost: 2 },
    { name: 'Other', cost: 0.25 },
    { name: 'D1', cost: 0 },
  ]);
  assert.equal(new Date(summary.from).getUTCDate(), 1);
  assert.match(calls[0].url, /\/accounts\/acct\/billable-usage\?/);
  assert.equal(calls[0].auth, 'Bearer token');
});

test('a second request within minutes is answered from the cache', async () => {
  const calls = stub(() => reply({ success: true, result: [] }));
  const summary = await billingSummary(env());
  assert.equal(calls.length, 0);
  assert.equal(summary.total, 6.25);
});
