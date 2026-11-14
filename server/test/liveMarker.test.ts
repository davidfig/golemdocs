// How far a person's devices have kept live blocks up to date (docs/live-blocks.md §6, *Updates in the background*).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { world, type World } from './harness.ts';

let w: World;
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

interface Marker {
  kept: boolean;
  workedTo: number | null;
  deferred: string[];
  now: number;
}

beforeEach(async () => {
  w = world();
  for (const email of [ALICE, BOB]) await w.signUp(email, email.split('@')[0]);
  // Their own databases, made by a first change.
  for (const email of [ALICE, BOB]) await w.call(email, 'PUT', '/api/reading', { body: JSON.stringify({ book: 'a'.repeat(64), place: 'x', age: 0 }), type: 'application/json' });
});
afterEach(() => w.restore());

const get = async (as: string): Promise<Marker> => (await (await w.call(as, 'GET', '/api/live-marker')).json()) as Marker;
const post = async (as: string, body: unknown): Promise<Response> => w.call(as, 'POST', '/api/live-marker', { body: JSON.stringify(body), type: 'application/json' });

test('the marker starts unset, only moves on, and is each person’s own', async () => {
  const first = await get(ALICE);
  assert.equal(first.kept, true);
  assert.equal(first.workedTo, null);
  assert.deepEqual(first.deferred, []);
  assert.equal((await post(ALICE, { workedTo: 1000 })).status, 200);
  assert.equal((await get(ALICE)).workedTo, 1000);
  await post(ALICE, { workedTo: 500 }); // another device, behind: the marker stays
  assert.equal((await get(ALICE)).workedTo, 1000);
  await post(ALICE, { workedTo: 2000 });
  assert.equal((await get(ALICE)).workedTo, 2000);
  // Never past the server's now.
  await post(ALICE, { workedTo: Date.now() + 86_400_000 });
  assert.ok((await get(ALICE)).workedTo! <= Date.now());
  assert.equal((await get(BOB)).workedTo, null);
});

test('documents too large for a device are deferred until one does them', async () => {
  await post(ALICE, { workedTo: 1000, defer: ['doc-a', 'doc-b'] });
  await post(ALICE, { defer: ['doc-b', 'doc-c'] });
  const marker = await get(ALICE);
  assert.deepEqual(marker.deferred, ['doc-a', 'doc-b', 'doc-c']);
  assert.equal(marker.workedTo, 1000);
  await post(ALICE, { done: ['doc-b'] });
  assert.deepEqual((await get(ALICE)).deferred, ['doc-a', 'doc-c']);
});

test('bad input is refused', async () => {
  assert.equal((await post(ALICE, { workedTo: 'soon' })).status, 400);
  assert.equal((await post(ALICE, { defer: [1, 2] })).status, 400);
  assert.equal((await post(ALICE, { defer: 'x' })).status, 400);
  assert.equal((await w.call(ALICE, 'DELETE', '/api/live-marker')).status, 405);
  assert.equal((await w.call(null, 'GET', '/api/live-marker')).status, 401);
});

test('two devices posting at once keep each other’s deferred documents', async () => {
  await post(ALICE, { defer: ['a'] });
  await Promise.all([post(ALICE, { defer: ['b'] }), post(ALICE, { defer: ['c'], done: ['a'] })]);
  assert.deepEqual([...(await get(ALICE)).deferred].sort(), ['b', 'c']);
  await post(ALICE, { defer: ['b', 'd'] });
  assert.deepEqual((await get(ALICE)).deferred.slice(-1), ['d']);
});
