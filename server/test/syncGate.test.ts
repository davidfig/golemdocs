// Cloud sync is for subscribers: uploading, sharing and editing together. The app in the browser
// stays free, and so does opening what a subscriber shares.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { userIdFor } from '../src/auth.ts';
import { DOCX, world, type World } from './harness.ts';

let w: World;
const OWNER = 'owner@example.com';
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

beforeEach(async () => {
  w = world();
  w.env.REQUIRE_SUBSCRIPTION = 'true';
  for (const email of [OWNER, ALICE, BOB]) await w.signUp(email, email.split('@')[0]);
});
afterEach(() => w.restore());

/** Gives someone a subscription in this status, or changes the one they have. */
async function plan(email: string, status: string): Promise<void> {
  w.directory
    .prepare(
      `INSERT INTO subscriptions (user_id, polar_id, status, current_period_end, cancel_at_period_end, modified_at, updated_at)
       VALUES (?, 'sub', ?, ?, 0, 0, 0) ON CONFLICT(user_id) DO UPDATE SET status = excluded.status`,
    )
    .run(await userIdFor(email), status, Date.now() + 30 * 86400_000);
}
const bytes = (...values: number[]) => new Uint8Array(values);
const upload = (as: string) => w.call(as, 'POST', '/api/documents?name=Doc.docx', { body: bytes(1, 2, 3), type: DOCX });
async function create(as = OWNER): Promise<string> {
  return ((await (await upload(as)).json()) as any).id;
}
const share = (id: string, email: string, role: string, as = OWNER) =>
  w.call(as, 'PUT', `/api/documents/${id}/shares`, { body: JSON.stringify({ email, role }), type: 'application/json' });
const hasDatabase = async (email: string) => (w.directory.prepare('SELECT COUNT(*) AS n FROM users WHERE user_id = ?').get(await userIdFor(email)) as { n: number }).n > 0;
const refusedForSubscription = async (r: Response, status = 402) => {
  assert.equal(r.status, status);
  assert.equal(((await r.json()) as any).code, 'subscription');
};

test('while the requirement is off, everyone signed in has sync', async () => {
  delete w.env.REQUIRE_SUBSCRIPTION;
  assert.equal((await upload(ALICE)).status, 201);
});

test('without a subscription nothing can be uploaded, and no database is made for them', async () => {
  await refusedForSubscription(await upload(ALICE));
  assert.deepEqual(await (await w.call(ALICE, 'GET', '/api/documents')).json(), []);
  assert.deepEqual(await (await w.call(ALICE, 'GET', '/api/shared')).json(), []);
  assert.equal(await hasDatabase(ALICE), false);
});

test('a subscriber can upload, and a trial counts', async () => {
  await plan(OWNER, 'active');
  assert.equal((await upload(OWNER)).status, 201);
  await plan(ALICE, 'trialing');
  assert.equal((await upload(ALICE)).status, 201);
});

test('admins have sync without paying', async () => {
  w.env.ADMIN_EMAILS = ALICE;
  assert.equal((await upload(ALICE)).status, 201);
  assert.equal((await upload(BOB)).status, 402, 'others still need one');
});

test('when a subscription ends, the documents can still be read, downloaded and deleted but not changed', async () => {
  await plan(OWNER, 'active');
  const id = await create();
  await plan(OWNER, 'canceled');

  assert.equal(((await (await w.call(OWNER, 'GET', '/api/documents')).json()) as any[]).length, 1);
  assert.deepEqual([...new Uint8Array(await (await w.call(OWNER, 'GET', `/api/documents/${id}`)).arrayBuffer())], [1, 2, 3]);
  await refusedForSubscription(await upload(OWNER));
  await refusedForSubscription(await w.call(OWNER, 'PUT', `/api/documents/${id}`, { body: bytes(9), type: DOCX }));
  await refusedForSubscription(await w.call(OWNER, 'PUT', `/api/documents/${id}/thumbnail`, { body: bytes(1), type: 'image/png' }));
  await refusedForSubscription(await share(id, ALICE, 'viewer'));
  assert.equal((await w.call(OWNER, 'DELETE', `/api/documents/${id}`)).status, 204);
});

test('someone with no subscription can open, and edit if allowed, what a subscriber shares, with no database of their own', async () => {
  await plan(OWNER, 'active');
  const id = await create();
  await share(id, ALICE, 'editor');
  await share(id, BOB, 'viewer');

  const listed = (await (await w.call(ALICE, 'GET', '/api/shared')).json()) as any[];
  assert.deepEqual(listed.map((d) => [d.id, d.role]), [[id, 'editor']]);
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${id}`)).status, 200);
  assert.equal((await w.call(ALICE, 'PUT', `/api/documents/${id}`, { body: bytes(7), type: DOCX })).status, 200);
  assert.equal((await w.call(BOB, 'PUT', `/api/documents/${id}`, { body: bytes(8), type: DOCX })).status, 403, 'a viewer still can’t write');
  await refusedForSubscription(await upload(ALICE));
  assert.equal(await hasDatabase(ALICE), false);
  assert.equal(await hasDatabase(BOB), false);
});

test('a share lasts while its owner has sync: then it is hidden and refused, and the recipient can still leave', async () => {
  await plan(OWNER, 'active');
  const id = await create();
  await share(id, ALICE, 'editor');
  await plan(OWNER, 'canceled');

  assert.deepEqual(await (await w.call(ALICE, 'GET', '/api/shared')).json(), []);
  await refusedForSubscription(await w.call(ALICE, 'GET', `/api/documents/${id}`), 403);
  await refusedForSubscription(await w.call(ALICE, 'PUT', `/api/documents/${id}`, { body: bytes(7), type: DOCX }), 403);
  const alice = await userIdFor(ALICE);
  assert.equal((await w.call(ALICE, 'DELETE', `/api/documents/${id}/shares/${alice}`)).status, 204);

  await plan(OWNER, 'active');
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${id}`)).status, 404, 'gone once they left');
});

test('rooms need the owner to have sync, for the owner and for everyone they shared with', async () => {
  await plan(OWNER, 'active');
  const id = await create();
  await share(id, ALICE, 'editor');
  assert.equal((await w.call(OWNER, 'GET', `/api/rooms/${id}`)).status, 204);
  assert.equal((await w.call(ALICE, 'GET', `/api/rooms/${id}`)).status, 204);

  await plan(OWNER, 'canceled');
  await refusedForSubscription(await w.call(OWNER, 'GET', `/api/rooms/${id}`), 402);
  await refusedForSubscription(await w.call(ALICE, 'GET', `/api/rooms/${id}`), 403);
});

test('the status says whether they have sync', async () => {
  const sync = async (email: string) => ((await (await w.call(email, 'GET', '/api/subscription')).json()) as any).sync;
  assert.equal(await sync(ALICE), false);
  await plan(ALICE, 'active');
  assert.equal(await sync(ALICE), true);
  w.env.ADMIN_EMAILS = BOB;
  assert.equal(await sync(BOB), true);
});
