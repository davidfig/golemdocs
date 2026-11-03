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

// --- The viewer's address of a view-only share -------------------------------------------------

/** The grantee's viewer address of a document, from their "shared with me" list. */
async function viewTokenOf(id: string, as = ALICE): Promise<string | undefined> {
  const listed = (await (await w.call(as, 'GET', '/api/shared')).json()) as { id: string; viewToken?: string }[];
  return listed.find((d) => d.id === id)?.viewToken;
}

test('a view-only share has a random address of its own, which opens the document for its grantee only', async () => {
  const id = await create();
  await share(id, ALICE, 'viewer');
  await share(id, BOB, 'viewer');
  const token = (await viewTokenOf(id))!;
  assert.match(token, /^[A-Za-z0-9_-]{32}$/, '24 random bytes, base64url');
  assert.ok(!token.includes(id) && !id.includes(token));
  assert.notEqual(await viewTokenOf(id, BOB), token, 'each share has its own');

  const info = await w.call(ALICE, 'GET', `/api/view/${token}`);
  assert.equal(info.status, 200);
  assert.deepEqual(Object.keys((await info.json()) as object).sort(), ['name', 'updatedAt']);
  const file = await w.call(ALICE, 'GET', `/api/view/${token}/file`);
  assert.equal(file.status, 200);
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]);
  const unchanged = await w.call(ALICE, 'GET', `/api/view/${token}/file`, { headers: { 'if-none-match': file.headers.get('etag')! } });
  assert.equal(unchanged.status, 304);
  // Nothing the viewer is answered names the document.
  for (const response of [info, file, unchanged]) for (const [, value] of response.headers) assert.ok(!value.includes(id), value);

  // Not a bearer token: anyone else, the owner and the other viewer included, gets 404, the same as for no such token.
  for (const who of [BOB, OWNER]) assert.equal((await w.call(who, 'GET', `/api/view/${token}/file`)).status, 404, who);
  assert.equal((await w.call(null, 'GET', `/api/view/${token}/file`)).status, 401);
  for (const method of ['PUT', 'POST', 'DELETE']) assert.equal((await w.call(ALICE, method, `/api/view/${token}/file`, { body: bytes(9), type: DOCX })).status, 405, method);
});

test('the document\'s id opens nothing on the viewer\'s routes, and an editor\'s share has no viewer address', async () => {
  const id = await create();
  await share(id, ALICE, 'viewer');
  await share(id, BOB, 'editor');
  for (const path of [`/api/view/${id}`, `/api/view/${id}/file`]) {
    for (const who of [ALICE, BOB, OWNER]) assert.equal((await w.call(who, 'GET', path)).status, 404, `${who} ${path}`);
  }
  assert.equal(await viewTokenOf(id, BOB), undefined);
  assert.equal((await w.call(ALICE, 'GET', '/api/view/short')).status, 404);
});

test('unsharing, or making the person an editor, kills the address (404, not 403), and sharing view-only again makes a new one', async () => {
  const id = await create();
  await share(id, ALICE, 'viewer');
  const first = (await viewTokenOf(id))!;
  await share(id, ALICE, 'viewer');
  assert.equal(await viewTokenOf(id), first, 'sharing again with the same role keeps it');

  await share(id, ALICE, 'editor');
  assert.equal(await viewTokenOf(id), undefined);
  assert.equal((await w.call(ALICE, 'GET', `/api/view/${first}/file`)).status, 404);
  await share(id, ALICE, 'viewer');
  const second = (await viewTokenOf(id))!;
  assert.ok(second && second !== first);
  assert.equal((await w.call(ALICE, 'GET', `/api/view/${second}/file`)).status, 200);

  const { userIdFor } = await import('../src/auth.ts');
  assert.equal((await w.call(OWNER, 'DELETE', `/api/documents/${id}/shares/${await userIdFor(ALICE)}`)).status, 204);
  assert.equal((await w.call(ALICE, 'GET', `/api/view/${second}/file`)).status, 404);
  assert.equal((await w.call(ALICE, 'GET', `/api/view/${second}`)).status, 404);
  await share(id, ALICE, 'viewer');
  const third = (await viewTokenOf(id))!;
  assert.ok(third !== first && third !== second);
});

test('a view-only share from before viewer addresses gets one when it is first listed', async () => {
  const id = await create();
  await share(id, ALICE, 'viewer');
  // As the migration leaves an older share: no address yet.
  w.directory.prepare('UPDATE shares SET view_token = NULL').run();
  const token = (await viewTokenOf(id))!;
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(await viewTokenOf(id), token, 'and keeps it');
  assert.equal((await w.call(ALICE, 'GET', `/api/view/${token}/file`)).status, 200);
});

// --- A document's public link -------------------------------------------------------------------

const link = (id: string, method: string, as = OWNER) => w.call(as, method, `/api/documents/${id}/link`);
const tokenOf = async (response: Response) => ((await response.json()) as { token: string | null }).token;

test('a public link opens the document read-only for anyone, signed in or not, and names nothing', async () => {
  const id = await create();
  assert.equal(await tokenOf(await link(id, 'GET')), null, 'none until made');
  const token = (await tokenOf(await link(id, 'PUT')))!;
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(!token.includes(id));
  assert.equal(await tokenOf(await link(id, 'PUT')), token, 'making it again keeps it');
  assert.equal(await tokenOf(await link(id, 'GET')), token);

  for (const who of [null, BOB, OWNER]) {
    const info = await w.call(who, 'GET', `/api/public/${token}`);
    assert.equal(info.status, 200, String(who));
    assert.deepEqual(Object.keys((await info.json()) as object).sort(), ['name', 'updatedAt']);
    const file = await w.call(who, 'GET', `/api/public/${token}/file`);
    assert.equal(file.status, 200);
    assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]);
    for (const response of [info, file]) for (const [, value] of response.headers) assert.ok(!value.includes(id), value);
    const unchanged = await w.call(who, 'GET', `/api/public/${token}/file`, { headers: { 'if-none-match': file.headers.get('etag')! } });
    assert.equal(unchanged.status, 304);
  }

  // Read-only: the link opens nothing else, and the document's id opens nothing on its routes.
  for (const method of ['PUT', 'POST', 'DELETE']) assert.equal((await w.call(null, method, `/api/public/${token}/file`, { body: bytes(9), type: DOCX })).status, 405, method);
  assert.equal((await w.call(null, 'GET', `/api/documents/${id}`)).status, 401);
  assert.equal((await w.call(BOB, 'GET', `/api/documents/${id}`)).status, 404);
  for (const path of [`/api/public/${id}`, `/api/public/${id}/file`, '/api/public/short']) assert.equal((await w.call(null, 'GET', path)).status, 404, path);
});

test('only the owner sees or changes the public link', async () => {
  const id = await create();
  await share(id, ALICE, 'editor');
  await share(id, BOB, 'viewer');
  for (const who of [ALICE, BOB]) for (const method of ['GET', 'PUT', 'POST', 'DELETE']) assert.equal((await link(id, method, who)).status, 403, `${who} ${method}`);
  assert.equal((await link(id, 'GET', null)).status, 401);
});

test('resetting the link kills the old one; turning it off or deleting the document kills it (404)', async () => {
  const id = await create();
  const first = (await tokenOf(await link(id, 'PUT')))!;
  const second = (await tokenOf(await link(id, 'POST')))!;
  assert.ok(second && second !== first);
  assert.equal((await w.call(null, 'GET', `/api/public/${first}/file`)).status, 404);
  assert.equal((await w.call(null, 'GET', `/api/public/${second}/file`)).status, 200);

  assert.equal((await link(id, 'DELETE')).status, 204);
  assert.equal(await tokenOf(await link(id, 'GET')), null);
  assert.equal((await w.call(null, 'GET', `/api/public/${second}`)).status, 404);
  const third = (await tokenOf(await link(id, 'PUT')))!;
  assert.ok(third !== first && third !== second, 'turning it on again makes a new one');

  assert.equal((await w.call(OWNER, 'DELETE', `/api/documents/${id}`)).status, 204);
  await Promise.all(w.background);
  assert.equal((await w.call(null, 'GET', `/api/public/${third}/file`)).status, 404);
});

test('a public link lasts only while its owner has sync', async () => {
  const id = await create();
  const token = (await tokenOf(await link(id, 'PUT')))!;
  w.env.REQUIRE_SUBSCRIPTION = 'true';
  assert.equal((await w.call(null, 'GET', `/api/public/${token}/file`)).status, 404);
  assert.equal((await link(id, 'POST')).status, 402, 'and none can be made without it');
});
