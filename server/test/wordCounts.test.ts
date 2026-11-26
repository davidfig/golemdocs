// A document's word history (src/wordCounts.ts): its count at the end of each day, kept with the document in the owner's
// account, added to by anyone who can edit it, and the count of a kept version for filling in the days before.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { MAX_DAYS_PER_REQUEST } from '../src/wordCounts.ts';
import { DOCX, world, type World } from './harness.ts';

let w: World;
const OWNER = 'owner@example.com';
const EDITOR = 'editor@example.com';
const VIEWER = 'viewer@example.com';
const realNow = Date.now;
let clock = realNow.call(Date);
let ownerId = '';

beforeEach(async () => {
  w = world();
  clock = realNow.call(Date);
  Date.now = () => clock;
  ownerId = '';
  for (const email of [OWNER, EDITOR, VIEWER]) {
    const id = await w.signUp(email, email.split('@')[0]);
    if (email === OWNER) ownerId = id;
  }
});
afterEach(() => {
  Date.now = realNow;
  w.restore();
});

type Row = { day: string; words: number; start: number | null };
const call = (as: string | null, method: string, path: string, init: { body?: BodyInit; type?: string } = {}) => w.call(as, method, path, init);
const json = (body: unknown) => ({ body: JSON.stringify(body), type: 'application/json' });
const text = (s: string) => new TextEncoder().encode(s);
const create = async (data = text('one two')) => ((await (await call(OWNER, 'POST', '/api/documents?name=Doc.txt', { body: data, type: DOCX })).json()) as { id: string; updatedAt: number });
const put = (as: string | null, id: string, body: unknown) => call(as, 'PUT', `/api/documents/${id}/words`, json(body));
const days = async (id: string, as = OWNER) => ((await (await call(as, 'GET', `/api/documents/${id}/words`)).json()) as { days: Row[] }).days;
const share = (id: string, email: string, role: string) => call(OWNER, 'PUT', `/api/documents/${id}/shares`, json({ email, role }));

test('a document has no history until a day is kept; days come back oldest first', async () => {
  const doc = await create();
  assert.deepEqual(await days(doc.id), []);
  assert.equal((await put(OWNER, doc.id, { days: [{ day: '2026-11-25', words: 120, start: 0 }, { day: '2026-11-24', words: 50 }] })).status, 200);
  assert.deepEqual(await days(doc.id), [
    { day: '2026-11-24', words: 50, start: null },
    { day: '2026-11-25', words: 120, start: 0 },
  ]);
});

test('a later count of a day replaces it, and the day keeps the start it was first given', async () => {
  const doc = await create();
  await put(OWNER, doc.id, { days: [{ day: '2026-11-26', words: 100, start: 90 }] });
  await put(OWNER, doc.id, { days: [{ day: '2026-11-26', words: 140, start: 130 }] });
  assert.deepEqual(await days(doc.id), [{ day: '2026-11-26', words: 140, start: 90 }]);
});

test('filling in (from versions) never replaces a day already kept', async () => {
  const doc = await create();
  await put(OWNER, doc.id, { days: [{ day: '2026-11-26', words: 140, start: 90 }] });
  await put(OWNER, doc.id, { days: [{ day: '2026-11-26', words: 5 }, { day: '2026-11-20', words: 30 }], fill: true });
  assert.deepEqual(await days(doc.id), [
    { day: '2026-11-20', words: 30, start: null },
    { day: '2026-11-26', words: 140, start: 90 },
  ]);
});

test('a shared document has one history: editors add to it, viewers only read it, strangers see nothing', async () => {
  const doc = await create();
  await share(doc.id, EDITOR, 'editor');
  await share(doc.id, VIEWER, 'viewer');
  assert.equal((await put(EDITOR, doc.id, { days: [{ day: '2026-11-26', words: 10 }] })).status, 200);
  assert.deepEqual(await days(doc.id), [{ day: '2026-11-26', words: 10, start: null }], 'kept with the owner’s document');
  assert.deepEqual(await days(doc.id, VIEWER), [{ day: '2026-11-26', words: 10, start: null }]);
  assert.equal((await put(VIEWER, doc.id, { days: [{ day: '2026-11-26', words: 99 }] })).status, 403);
  assert.equal((await call('stranger@example.com', 'GET', `/api/documents/${doc.id}/words`)).status, 404);
  assert.equal((await call(null, 'GET', `/api/documents/${doc.id}/words`)).status, 401);
});

test('keeping needs the owner’s sync', async () => {
  const doc = await create();
  w.env.REQUIRE_SUBSCRIPTION = 'true';
  assert.equal((await put(OWNER, doc.id, { days: [{ day: '2026-11-26', words: 10 }] })).status, 402);
});

test('bad days are refused', async () => {
  const doc = await create();
  for (const body of [
    {},
    { days: 'x' },
    { days: [{ day: '2026-13-01', words: 1 }] },
    { days: [{ day: '26-11-2026', words: 1 }] },
    { days: [{ day: '2026-11-26', words: -1 }] },
    { days: [{ day: '2026-11-26', words: 1.5 }] },
    { days: [{ day: '2026-11-26', words: 1, start: 'x' }] },
    { days: Array.from({ length: MAX_DAYS_PER_REQUEST + 1 }, () => ({ day: '2026-11-26', words: 1 })) },
  ]) {
    assert.equal((await put(OWNER, doc.id, body)).status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal((await call(OWNER, 'DELETE', `/api/documents/${doc.id}/words`)).status, 405);
});

test('many days at once go in, more than one statement takes', async () => {
  const doc = await create();
  const many = Array.from({ length: 45 }, (_, i) => ({ day: `2026-10-${String((i % 31) + 1).padStart(2, '0')}`, words: i }));
  const unique = [...new Map(many.map((d) => [d.day, d])).values()];
  assert.equal((await put(OWNER, doc.id, { days: unique })).status, 200);
  assert.equal((await days(doc.id)).length, unique.length);
});

test('a kept version is counted, for anyone who can open the document', async () => {
  const doc = await create(text('one two three'));
  clock += 60_000;
  const saved = await call(OWNER, 'PUT', `/api/documents/${doc.id}?base=${doc.updatedAt}`, { body: text('one two three four five'), type: DOCX });
  assert.equal(saved.status, 200);
  await share(doc.id, VIEWER, 'viewer');
  const counted = await call(VIEWER, 'GET', `/api/documents/${doc.id}/versions/${doc.updatedAt}/words`);
  assert.equal(counted.status, 200);
  assert.deepEqual(await counted.json(), { words: 3 });
  assert.equal((await call(OWNER, 'GET', `/api/documents/${doc.id}/versions/1/words`)).status, 404);
});

test('a document deleted for good takes its history with it', async () => {
  const doc = await create();
  await put(OWNER, doc.id, { days: [{ day: '2026-11-26', words: 10 }] });
  assert.equal((await call(OWNER, 'DELETE', `/api/documents/${doc.id}`)).status, 204);
  assert.equal((await call(OWNER, 'DELETE', `/api/trash/${doc.id}`)).status, 204);
  const left = w.userDatabase(ownerId).prepare('SELECT * FROM word_counts').all();
  assert.deepEqual(left, []);
});
