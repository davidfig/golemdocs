// Interface settings kept in the account: per profile, for people with sync, and bounded.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { userIdFor } from '../src/auth.ts';
import { world, type World } from './harness.ts';

let w: World;
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

beforeEach(async () => {
  w = world();
  for (const email of [ALICE, BOB]) await w.signUp(email, email.split('@')[0]);
});
afterEach(() => w.restore());

const put = (as: string | null, body: unknown) => w.call(as, 'PUT', '/api/preferences', { body: JSON.stringify(body), type: 'application/json' });
const get = async (as: string | null, profile = 'desktop') => ((await (await w.call(as, 'GET', `/api/preferences?profile=${profile}`)).json()) as any).prefs;
const hasDatabase = async (email: string) => (w.directory.prepare('SELECT COUNT(*) AS n FROM users WHERE user_id = ?').get(await userIdFor(email)) as { n: number }).n > 0;

test('settings are saved, read back with when they changed, and a null puts one back to its default', async () => {
  assert.deepEqual(await get(ALICE), {});
  const first = await put(ALICE, { profile: 'desktop', prefs: { 'golem.appearance': 'dark', 'word.footer': 'off' } });
  assert.equal(first.status, 200);
  let prefs = await get(ALICE);
  assert.equal(prefs['golem.appearance'].value, 'dark');
  assert.equal(prefs['word.footer'].value, 'off');
  assert.equal(typeof prefs['word.footer'].updatedAt, 'number');
  await put(ALICE, { profile: 'desktop', prefs: { 'word.footer': null } });
  prefs = await get(ALICE);
  assert.equal(prefs['golem.appearance'].value, 'dark'); // not named: kept
  assert.equal(prefs['word.footer'].value, null);
});

test('a phone and a computer keep separate settings, and people keep their own', async () => {
  await put(ALICE, { profile: 'desktop', prefs: { 'word.viewMode': 'print' } });
  await put(ALICE, { profile: 'mobile', prefs: { 'word.viewMode': 'flow' } });
  assert.equal((await get(ALICE, 'desktop'))['word.viewMode'].value, 'print');
  assert.equal((await get(ALICE, 'mobile'))['word.viewMode'].value, 'flow');
  assert.deepEqual(await get(BOB), {});
});

test('reading settings makes no database for someone without one; saving needs sync', async () => {
  assert.deepEqual(await get(BOB), {});
  assert.equal(await hasDatabase(BOB), false);
  w.env.REQUIRE_SUBSCRIPTION = 'true';
  const refused = await put(BOB, { profile: 'desktop', prefs: { 'word.footer': 'off' } });
  assert.equal(refused.status, 402);
  assert.equal(await hasDatabase(BOB), false);
  assert.deepEqual(await get(BOB), {});
});

test('signed-out requests are refused', async () => {
  assert.equal((await w.call(null, 'GET', '/api/preferences?profile=desktop')).status, 401);
  assert.equal((await put(null, { profile: 'desktop', prefs: {} })).status, 401);
});

test('bad requests are refused', async () => {
  assert.equal((await w.call(ALICE, 'GET', '/api/preferences')).status, 400);
  assert.equal((await w.call(ALICE, 'GET', '/api/preferences?profile=tablet')).status, 400);
  assert.equal((await put(ALICE, { profile: 'tablet', prefs: {} })).status, 400);
  assert.equal((await put(ALICE, { profile: 'desktop', prefs: [] })).status, 400);
  assert.equal((await put(ALICE, { profile: 'desktop', prefs: { 'bad key!': 'x' } })).status, 400);
  assert.equal((await put(ALICE, { profile: 'desktop', prefs: { a: 5 } })).status, 400);
  assert.equal((await put(ALICE, { profile: 'desktop', prefs: { a: 'x'.repeat(200_001) } })).status, 413);
  const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']));
  assert.equal((await put(ALICE, { profile: 'desktop', prefs: many })).status, 400);
  assert.equal((await w.call(ALICE, 'DELETE', '/api/preferences')).status, 405);
});

test('a profile holds a bounded number of settings', async () => {
  for (let batch = 0; batch < 5; batch++) {
    const prefs = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${batch}-${i}`, 'v']));
    assert.equal((await put(ALICE, { profile: 'desktop', prefs })).status, 200);
  }
  assert.equal((await put(ALICE, { profile: 'desktop', prefs: { extra: 'v' } })).status, 413);
  assert.equal((await put(ALICE, { profile: 'desktop', prefs: { 'k0-0': 'changed' } })).status, 200); // one it has: fine
});
