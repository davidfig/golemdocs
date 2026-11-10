// Where the person is in each book: kept in the account, latest reading wins, for people with sync.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { world, type World } from './harness.ts';

let w: World;
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const BOOK = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

beforeEach(async () => {
  w = world();
  for (const email of [ALICE, BOB]) await w.signUp(email, email.split('@')[0]);
});
afterEach(() => w.restore());

type Answer = { place: string | null; readAt: number | null; now: number };
const put = async (as: string | null, body: unknown) => w.call(as, 'PUT', '/api/reading', { body: JSON.stringify(body), type: 'application/json' });
const get = async (as: string | null, book = BOOK) => (await (await w.call(as, 'GET', `/api/reading?book=${book}`)).json()) as Answer;

test('a book never read has no place; a place is kept and read back, with the server’s time', async () => {
  const empty = await get(ALICE);
  assert.equal(empty.place, null);
  assert.equal(empty.readAt, null);
  assert.equal(typeof empty.now, 'number');
  const before = Date.now();
  const saved = await put(ALICE, { book: BOOK, place: '{"place":[12,40]}', age: 0 });
  assert.equal(saved.status, 200);
  const answer = (await saved.json()) as Answer;
  assert.equal(answer.place, '{"place":[12,40]}');
  assert.ok(answer.readAt! >= before && answer.readAt! <= answer.now);
  assert.equal((await get(ALICE)).place, '{"place":[12,40]}');
  assert.equal((await get(ALICE, OTHER)).place, null);
  assert.equal((await get(BOB)).place, null); // people keep their own
});

test('the latest reading wins, even when it is further back in the book', async () => {
  await put(ALICE, { book: BOOK, place: 'page 90', age: 60_000 });
  await put(ALICE, { book: BOOK, place: 'page 40', age: 0 });
  assert.equal((await get(ALICE)).place, 'page 40');
  // A device that was offline sends an older reading: it is told of the later one, which is kept.
  const stale = (await (await put(ALICE, { book: BOOK, place: 'page 10', age: 30_000 })).json()) as Answer;
  assert.equal(stale.place, 'page 40');
  assert.equal((await get(ALICE)).place, 'page 40');
});

test('an age can never put a reading in the future', async () => {
  const before = Date.now();
  await put(ALICE, { book: BOOK, place: 'x', age: -10 * 365 * 86_400_000 });
  const kept = await get(ALICE);
  assert.ok(kept.readAt! >= before && kept.readAt! <= kept.now);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await put(ALICE, { book: BOOK, place: 'now', age: 0 });
  assert.equal((await get(ALICE)).place, 'now');
});

test('saving needs sync; signed-out requests are refused', async () => {
  w.env.REQUIRE_SUBSCRIPTION = 'true';
  assert.equal((await put(BOB, { book: BOOK, place: 'x', age: 0 })).status, 402);
  assert.equal((await w.call(null, 'GET', `/api/reading?book=${BOOK}`)).status, 401);
  assert.equal((await put(null, { book: BOOK, place: 'x', age: 0 })).status, 401);
});

test('bad requests are refused', async () => {
  assert.equal((await w.call(ALICE, 'GET', '/api/reading')).status, 400);
  assert.equal((await w.call(ALICE, 'GET', '/api/reading?book=nothex')).status, 400);
  assert.equal((await put(ALICE, { book: 'short', place: 'x' })).status, 400);
  assert.equal((await put(ALICE, { book: BOOK })).status, 400);
  assert.equal((await put(ALICE, { book: BOOK, place: 5 })).status, 400);
  assert.equal((await put(ALICE, { book: BOOK, place: 'x'.repeat(1001) })).status, 413);
  assert.equal((await w.call(ALICE, 'DELETE', '/api/reading')).status, 405);
});
