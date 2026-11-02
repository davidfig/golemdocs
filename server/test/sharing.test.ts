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
  // Their open room connections are sent to reconnect with the new role, once.
  assert.deepEqual(
    w.roomCalls.filter((c) => c.path === '/rejoin').map((c) => c.doc),
    [id],
  );
  await share(id, ALICE, 'editor');
  assert.equal(w.roomCalls.filter((c) => c.path === '/rejoin').length, 1, 'not when the role is unchanged');

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

test('a shared document deleted with its folder is gone for the people it was shared with at once, before the cleanup', async () => {
  w.restore();
  w = world({ background: true });
  for (const email of [OWNER, ALICE]) await w.signUp(email, email.split('@')[0]);
  const folder = crypto.randomUUID();
  await w.call(OWNER, 'PUT', `/api/folders/${folder}`, { body: JSON.stringify({ name: 'F', parentId: null }), type: 'application/json' });
  const r = await w.call(OWNER, 'POST', `/api/documents?name=Doc.docx&folder=${folder}`, { body: bytes(1, 2, 3), type: DOCX });
  const id = ((await r.json()) as any).id;
  await share(id, ALICE, 'viewer');
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${id}`)).status, 200);
  await w.call(OWNER, 'DELETE', '/api/documents', { body: JSON.stringify({ folders: [folder] }), type: 'application/json' });
  assert.equal(w.objects.size, 1, 'the file is still in R2 until the cleanup');
  assert.equal((await w.call(ALICE, 'GET', `/api/documents/${id}`)).status, 404);
  assert.deepEqual(await (await w.call(ALICE, 'GET', '/api/shared')).json(), []);
  await Promise.all(w.background);
});

test('a view-only share changes nothing by any route: save, delta, rename, move, thumbnail, history, room pictures, shares, delete', async () => {
  const id = await create();
  await share(id, ALICE, 'viewer');
  // A save first, so there is a version in the history to try to change.
  await w.call(OWNER, 'PUT', `/api/documents/${id}`, { body: bytes(4, 5, 6), type: DOCX });
  const version = ((await (await w.call(OWNER, 'GET', `/api/documents/${id}/versions`)).json()) as { version: number }[])[0]!.version;
  const json = (body: unknown) => ({ body: JSON.stringify(body), type: 'application/json' });
  const attempts: [string, string, Parameters<World['call']>[3]?][] = [
    ['PUT', `/api/documents/${id}`, { body: bytes(9), type: DOCX }],
    ['PUT', `/api/documents/${id}?name=Renamed.docx`, { body: bytes(9), type: DOCX }],
    ['PUT', `/api/documents/${id}`, { body: bytes(0, 0, 0, 2, 123, 125), type: 'application/vnd.golemdocs.delta' }],
    ['PATCH', `/api/documents/${id}`, json({ name: 'Renamed.docx' })],
    ['PATCH', `/api/documents/${id}`, json({ folderId: null })],
    ['PUT', `/api/documents/${id}/thumbnail`, { body: bytes(1), type: 'image/png' }],
    ['POST', `/api/documents/${id}/versions`, json({})],
    ['PATCH', `/api/documents/${id}/versions/${version}`, json({ name: 'Mine' })],
    ['DELETE', `/api/documents/${id}/versions/${version}`],
    ['PUT', `/api/documents/${id}/shares`, json({ email: BOB, role: 'editor' })],
    ['PUT', `/api/documents/${id}/shares`, json({ email: ALICE, role: 'editor' })],
    ['PUT', `/api/rooms/${id}/media/${'a'.repeat(64)}`, { body: bytes(1), type: 'application/octet-stream' }],
    ['DELETE', `/api/documents/${id}`],
  ];
  for (const [method, path, init] of attempts) {
    const status = (await w.call(ALICE, method, path, init)).status;
    assert.ok(status >= 400 && status < 500, `${method} ${path} answered ${status}`);
  }
  // A bulk move or delete by id skips documents that aren't the caller's.
  const bulk = (await (await w.call(ALICE, 'DELETE', '/api/documents', json({ ids: [id] }))).json()) as { ok: string[] };
  assert.deepEqual(bulk.ok, []);
  // The document is as the owner left it, and still shared view-only.
  assert.deepEqual([...new Uint8Array(await (await w.call(ALICE, 'GET', `/api/documents/${id}`)).arrayBuffer())], [4, 5, 6]);
  const listed = (await (await w.call(ALICE, 'GET', '/api/shared')).json()) as { id: string; role: string; name: string }[];
  assert.deepEqual(listed.map((d) => [d.id, d.role, d.name]), [[id, 'viewer', 'Doc.docx']]);
  // Leaving is the one change a viewer may make.
  const { userIdFor } = await import('../src/auth.ts');
  assert.equal((await w.call(ALICE, 'DELETE', `/api/documents/${id}/shares/${await userIdFor(ALICE)}`)).status, 204);
});

test('a reader checking for a newer save gets 304 while the file is unchanged, and the new file once it is saved', async () => {
  const id = await create();
  await share(id, ALICE, 'viewer');
  const first = await w.call(ALICE, 'GET', `/api/documents/${id}`);
  const etag = first.headers.get('etag')!;
  assert.ok(etag);
  const again = await w.call(ALICE, 'GET', `/api/documents/${id}`, { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get('etag'), etag);
  await w.call(OWNER, 'PUT', `/api/documents/${id}`, { body: bytes(7, 7), type: DOCX });
  const changed = await w.call(ALICE, 'GET', `/api/documents/${id}`, { headers: { 'if-none-match': etag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
  assert.deepEqual([...new Uint8Array(await changed.arrayBuffer())], [7, 7]);
  // Someone with no access learns nothing from the check either.
  assert.equal((await w.call(BOB, 'GET', `/api/documents/${id}`, { headers: { 'if-none-match': etag } })).status, 404);
});
