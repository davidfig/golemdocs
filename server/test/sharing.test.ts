// Sharing: who can open, edit, delete and manage a document.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { DOCX, world, type World } from './harness.ts';

let w: World;
const OWNER = 'owner@example.com';
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

beforeEach(async () => {
  w = world();
  for (const email of [OWNER, ALICE, BOB]) await w.signUp(email, email.split('@')[0]);
});
afterEach(() => w.restore());

const bytes = (...values: number[]) => new Uint8Array(values);
async function create(): Promise<string> {
  const r = await w.call(OWNER, 'POST', '/api/documents?name=Doc.docx', { body: bytes(1, 2, 3), type: DOCX });
  return ((await r.json()) as any).id;
}
const share = (id: string, email: string, role: string, as = OWNER) =>
  w.call(as, 'PUT', `/api/documents/${id}/shares`, { body: JSON.stringify({ email, role }), type: 'application/json' });

test('nobody but the owner can open a document until it is shared', async () => {
  const id = await create();
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${id}`)).status, 404);
  assert.equal((await share(id, ALICE, 'viewer')).status, 200);
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${id}`)).status, 200);
  assert.equal((await w.call(BOB, 'GET', `/api/documents/${id}`)).status, 404, 'others still can’t');
});

test('a viewer can read but not write; an editor can write but not delete or manage', async () => {
  const id = await create();
  await share(id, ALICE, 'viewer');
  await share(id, BOB, 'editor');

  const put = (as: string) => w.call(as, 'PUT', `/api/documents/${id}`, { body: bytes(9, 9), type: DOCX });
  assert.equal((await put(ALICE)).status, 403);
  assert.equal((await put(BOB)).status, 200);
  assert.deepEqual([...new Uint8Array(await (await w.call(ALICE, 'GET', `/api/documents/${id}`)).arrayBuffer())], [9, 9]);

  assert.equal((await w.call(BOB, 'DELETE', `/api/documents/${id}`)).status, 403);
  assert.equal((await share(id, ALICE, 'editor', BOB)).status, 403);
  assert.equal((await w.call(BOB, 'GET', `/api/documents/${id}/shares`)).status, 403);
  assert.equal((await w.call(ALICE, 'PUT', `/api/documents/${id}/thumbnail`, { body: bytes(1), type: 'image/png' })).status, 403);
  assert.equal((await w.call(BOB, 'PUT', `/api/documents/${id}/thumbnail`, { body: bytes(1), type: 'image/png' })).status, 200);
});

test('shared documents are listed for the grantee, with their role and owner', async () => {
  const id = await create();
  await share(id, ALICE, 'viewer');
  const shared = (await (await w.call(ALICE, 'GET', '/api/shared')).json()) as any[];
  assert.equal(shared.length, 1);
  assert.equal(shared[0].id, id);
  assert.equal(shared[0].role, 'viewer');
  assert.equal(shared[0].owner.email, OWNER);
  assert.deepEqual(await (await w.call(ALICE, 'GET', '/api/documents')).json(), [], 'not mixed into their own documents');
});

test('changing a role replaces it; removing access (by the owner, or by the grantee) revokes it', async () => {
  const id = await create();
  await share(id, ALICE, 'viewer');
  await share(id, ALICE, 'editor');
  const list = (await (await w.call(OWNER, 'GET', `/api/documents/${id}/shares`)).json()) as any[];
  assert.equal(list.length, 1);
  assert.equal(list[0].role, 'editor');

  assert.equal((await w.call(BOB, 'DELETE', `/api/documents/${id}/shares/${list[0].userId}`)).status, 404);
  assert.equal((await w.call(OWNER, 'DELETE', `/api/documents/${id}/shares/${list[0].userId}`)).status, 204);
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${id}`)).status, 404);

  await share(id, ALICE, 'viewer');
  assert.equal((await w.call(ALICE, 'DELETE', `/api/documents/${id}/shares/${list[0].userId}`)).status, 204, 'leaving');
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${id}`)).status, 404);
});

test('sharing needs an existing account and a valid role', async () => {
  const id = await create();
  assert.equal((await share(id, 'stranger@example.com', 'viewer')).status, 404);
  assert.equal((await share(id, ALICE, 'owner')).status, 400);
  assert.equal((await share(id, OWNER, 'editor')).status, 400);
});

test('deleting a document ends its shares', async () => {
  const id = await create();
  await share(id, ALICE, 'editor');
  assert.equal((await w.call(OWNER, 'DELETE', `/api/documents/${id}`)).status, 204);
  assert.deepEqual(await (await w.call(ALICE, 'GET', '/api/shared')).json(), []);
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${id}`)).status, 404);
});

test('documents from before sharing are claimed by their owner when listed', async () => {
  const id = await create();
  w.directory.exec('DELETE FROM document_owners');
  assert.equal((await w.call(OWNER, 'GET', `/api/documents/${id}`)).status, 200, 'the owner still finds it');
  w.directory.exec('DELETE FROM document_owners');
  await w.call(OWNER, 'GET', '/api/documents');
  assert.equal((await share(id, ALICE, 'viewer')).status, 200);
});
