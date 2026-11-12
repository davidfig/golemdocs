// Scheduled script runs: each run is claimed by one of a person's devices, once (docs/live-blocks.md §8).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { CLAIM_MS } from '../src/scriptClaims.ts';
import { world, type World } from './harness.ts';

let w: World;
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const RUN = 'Scripts/daily.ts@2026-11-11T06:00';

beforeEach(async () => {
  w = world();
  for (const email of [ALICE, BOB]) await w.signUp(email, email.split('@')[0]);
  // Their own databases, made by a first change.
  for (const email of [ALICE, BOB]) await w.call(email, 'PUT', '/api/reading', { body: JSON.stringify({ book: 'a'.repeat(64), place: 'x', age: 0 }), type: 'application/json' });
});
afterEach(() => w.restore());

const claim = async (as: string | null, body: unknown) => w.call(as, 'POST', '/api/script-claims', { body: JSON.stringify(body), type: 'application/json' });
const claimed = async (as: string, device: string, run = RUN) => ((await (await claim(as, { run, device })).json()) as { claimed: boolean }).claimed;

test('the first device to claim a run gets it, once; another person’s runs are their own', async () => {
  assert.equal(await claimed(ALICE, 'laptop'), true);
  assert.equal(await claimed(ALICE, 'phone'), false);
  assert.equal(await claimed(ALICE, 'laptop'), false); // asking again doesn't run it twice
  assert.equal(await claimed(BOB, 'phone'), true);
  assert.equal(await claimed(ALICE, 'phone', 'Scripts/daily.ts@2026-11-12T06:00'), true);
});

test('a claim not done in time goes to the next device; a done one never does', async () => {
  const realNow = Date.now;
  try {
    assert.equal(await claimed(ALICE, 'laptop'), true);
    assert.equal(await claimed(ALICE, 'laptop', 'other'), true);
    assert.equal((await claim(ALICE, { run: 'other', device: 'laptop', done: true })).status, 200);
    const later = realNow() + CLAIM_MS + 1000;
    Date.now = () => later;
    assert.equal(await claimed(ALICE, 'phone'), true);
    assert.equal(await claimed(ALICE, 'phone', 'other'), false);
  } finally {
    Date.now = realNow;
  }
});

test('bad requests and signed-out ones are refused', async () => {
  assert.equal((await claim(null, { run: RUN, device: 'x' })).status, 401);
  assert.equal((await claim(ALICE, { run: RUN })).status, 400);
  assert.equal((await claim(ALICE, { run: 'x'.repeat(601), device: 'x' })).status, 400);
  assert.equal((await w.call(ALICE, 'GET', '/api/script-claims')).status, 405);
});
