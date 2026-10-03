// Folders end to end: the real worker against a fake R2 and per-user D1 databases (see harness.ts).

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';
import { USER_MIGRATIONS } from '../src/schema.ts';
import { DOCX, world, type World } from './harness.ts';

let w: World;
beforeEach(() => {
  w = world();
});
afterEach(() => w.restore());

const call = (method: string, path: string, body?: unknown) =>
  w.call('dev@example.com', method, path, body === undefined ? {} : { body: JSON.stringify(body), type: 'application/json' });
const id = () => crypto.randomUUID();
const folder = async (name: string, parentId: string | null = null) => {
  const fid = id();
  const res = await call('PUT', `/api/folders/${fid}`, { name, parentId });
  assert.equal(res.status, 201);
  return fid;
};
const create = async (query = '') =>
  (await (await w.call('dev@example.com', 'POST', `/api/documents?name=Doc.docx${query}`, { body: new Uint8Array([1, 2, 3]), type: DOCX })).json()) as any;

test('migration 3 adds folders and a document’s folder', () => {
  const db = new DatabaseSync(':memory:');
  for (const statements of USER_MIGRATIONS) for (const sql of statements) db.exec(sql);
  assert.ok((db.prepare('PRAGMA table_info(documents)').all() as { name: string }[]).some((c) => c.name === 'folder_id'));
  assert.ok((db.prepare('PRAGMA table_info(folders)').all() as { name: string }[]).some((c) => c.name === 'parent_id'));
});

test('folders are created, renamed, moved and listed', async () => {
  const a = await folder('A');
  const b = await folder('B', a);
  assert.equal(((await (await call('GET', '/api/folders')).json()) as any[]).length, 2);
  const renamed = await call('PUT', `/api/folders/${b}`, { name: '  Bee ', parentId: null });
  assert.equal(renamed.status, 200);
  assert.deepEqual(
    ((await (await call('GET', '/api/folders')).json()) as any[]).map((f) => [f.name, f.parentId]),
    [['A', null], ['Bee', null]],
  );
});

test('an update keeps the name or parent it leaves out', async () => {
  const a = await folder('A');
  const b = await folder('B');
  // Moved on one screen, renamed on another that still had the old parent: neither undoes the other.
  assert.equal((await call('PUT', `/api/folders/${b}`, { parentId: a })).status, 200);
  assert.equal((await call('PUT', `/api/folders/${b}`, { name: 'Bee' })).status, 200);
  assert.deepEqual(
    ((await (await call('GET', '/api/folders')).json()) as any[]).map((f) => [f.name, f.parentId]),
    [['A', null], ['Bee', a]],
  );
  assert.equal((await call('PUT', '/api/folders', { folders: [{ id: b, parentId: null }] })).status, 200);
  assert.deepEqual(((await (await call('GET', '/api/folders')).json()) as any[]).find((f) => f.id === b).parentId, null);
  // A new folder still needs its name.
  assert.equal((await call('PUT', `/api/folders/${id()}`, { parentId: null })).status, 400);
});

test('a folder cannot go inside itself or its own subfolder, or into a missing folder', async () => {
  const a = await folder('A');
  const b = await folder('B', a);
  assert.equal((await call('PUT', `/api/folders/${a}`, { name: 'A', parentId: a })).status, 400);
  assert.equal((await call('PUT', `/api/folders/${a}`, { name: 'A', parentId: b })).status, 400);
  assert.equal((await call('PUT', `/api/folders/${a}`, { name: 'A', parentId: id() })).status, 400);
  assert.equal((await call('PUT', `/api/folders/${a}`, { name: '   ', parentId: null })).status, 400);
});

test('documents are created in, and moved between, folders', async () => {
  const a = await folder('A');
  const doc = await create(`&folder=${a}`);
  assert.equal(doc.folderId, a);
  assert.equal((await create()).folderId, null);
  assert.equal((await w.call('dev@example.com', 'POST', `/api/documents?folder=${id()}`, { body: new Uint8Array([1]), type: DOCX })).status, 400);

  const moved = await call('PATCH', `/api/documents/${doc.id}`, { folderId: null });
  assert.equal(moved.status, 200);
  assert.equal(((await moved.json()) as any).folderId, null);
  assert.equal((await call('PATCH', `/api/documents/${doc.id}`, { folderId: id() })).status, 400);
  assert.equal((await call('PATCH', `/api/documents/${doc.id}`, {})).status, 400);
  assert.equal(((await (await call('GET', '/api/documents')).json()) as any[]).find((d) => d.id === doc.id).folderId, null);
});

test('deleting a folder moves what was in it up a level, and keeps the documents', async () => {
  const a = await folder('A');
  const b = await folder('B', a);
  const inB = await create(`&folder=${b}`);
  const inA = await create(`&folder=${a}`);
  assert.equal((await call('DELETE', `/api/folders/${b}`)).status, 204);
  const docs = (await (await call('GET', '/api/documents')).json()) as any[];
  assert.equal(docs.find((d) => d.id === inB.id).folderId, a);
  assert.equal(docs.find((d) => d.id === inA.id).folderId, a);

  const c = await folder('C', a);
  assert.equal((await call('DELETE', `/api/folders/${a}`)).status, 204);
  assert.equal(((await (await call('GET', '/api/folders')).json()) as any[]).find((f) => f.id === c).parentId, null);
  assert.equal(((await (await call('GET', '/api/documents')).json()) as any[]).find((d) => d.id === inB.id).folderId, null);
  assert.equal((await call('DELETE', `/api/folders/${a}`)).status, 404);
});

test('other people do not see where a shared document is kept', async () => {
  const friend = 'friend@example.com';
  await w.signUp(friend, 'Friend', { subscribed: true });
  const a = await folder('Private');
  const doc = await create(`&folder=${a}`);
  assert.equal((await call('PUT', `/api/documents/${doc.id}/shares`, { email: friend, role: 'viewer' })).status, 200);
  const shared = (await (await w.call(friend, 'GET', '/api/shared')).json()) as any[];
  assert.equal(shared[0].folderId, null);
  assert.equal((await w.call(friend, 'PATCH', `/api/documents/${doc.id}`, { body: JSON.stringify({ folderId: null }), type: 'application/json' })).status, 403);
});

test('several documents are moved and deleted in one request, each reported on its own', async () => {
  const f = await folder('F');
  const [a, b, c] = [await create(), await create(), await create()];
  const missing = id();
  const moved = (await (await call('PATCH', '/api/documents', { ids: [a.id, b.id, missing], folderId: f })).json()) as any;
  assert.deepEqual(moved.ok.sort(), [a.id, b.id].sort());
  assert.deepEqual(moved.failed, [{ id: missing, error: 'not found' }]);
  const listed = (await (await call('GET', '/api/documents')).json()) as any[];
  assert.deepEqual(listed.filter((d) => d.folderId === f).map((d) => d.id).sort(), [a.id, b.id].sort());
  const bad = (await (await call('PATCH', '/api/documents', { ids: [c.id], folderId: id() })).json()) as any;
  assert.equal(bad.failed[0].error, 'no such folder');

  const deleted = (await (await call('DELETE', '/api/documents', { ids: [a.id, c.id, missing] })).json()) as any;
  assert.deepEqual(deleted.ok.sort(), [a.id, c.id].sort());
  assert.equal(deleted.failed.length, 1);
  assert.deepEqual(((await (await call('GET', '/api/documents')).json()) as any[]).map((d) => d.id), [b.id]);
  assert.equal((await call('DELETE', '/api/documents', { ids: 'nope' })).status, 400);
});

test('several folders are made and deleted in one request', async () => {
  const [a, b, c] = [id(), id(), id()];
  const made = (await (await call('PUT', '/api/folders', { folders: [{ id: a, name: 'A', parentId: null }, { id: b, name: 'B', parentId: a }, { id: c, name: '', parentId: null }] })).json()) as any;
  assert.deepEqual(made.ok.map((f: any) => f.id), [a, b]);
  assert.equal(made.failed[0].id, c);
  const doc = await create(`&folder=${b}`);
  const gone = (await (await call('DELETE', '/api/folders', { ids: [b, a, id()] })).json()) as any;
  assert.deepEqual(gone.ok, [b, a]);
  assert.equal(gone.failed.length, 1);
  assert.equal(((await (await call('GET', '/api/documents')).json()) as any[]).find((d) => d.id === doc.id).folderId, null);
});

test('one delete request removes folders with everything inside them, and documents beside them', async () => {
  const a = await folder('A');
  const b = await folder('B', a);
  const other = await folder('Other');
  const [inA, inB, loose, kept] = [await create(`&folder=${a}`), await create(`&folder=${b}`), await create(), await create(`&folder=${other}`)];
  const gone = (await (await call('DELETE', '/api/documents', { ids: [loose.id], folders: [a, id()] })).json()) as any;
  assert.deepEqual(gone.ok.sort(), [loose.id, a].sort());
  assert.equal(gone.failed.length, 1);
  assert.deepEqual(((await (await call('GET', '/api/documents')).json()) as any[]).map((d) => d.id), [kept.id]);
  assert.deepEqual(((await (await call('GET', '/api/folders')).json()) as any[]).map((f) => f.id), [other]);
  void inA, inB, b;
  assert.equal((await call('DELETE', '/api/documents', {})).status, 400);
});

/** Counts the requests to Cloudflare's REST API (each one counts against its rate limit) made by `work`. */
async function requestsFor(work: () => Promise<unknown>): Promise<number> {
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => (requests++, realFetch(...args))) as typeof fetch;
  try {
    await work();
  } finally {
    globalThis.fetch = realFetch;
  }
  return requests;
}

test('a batch of folders, nested inside each other, takes two requests to Cloudflare', async () => {
  const top = await folder('Top');
  const ids = Array.from({ length: 20 }, id);
  // Each inside the one before it (made earlier in the same batch), with one bad item along the way.
  const items = [...ids.map((fid, i) => ({ id: fid, name: `F${i}`, parentId: i === 0 ? top : ids[i - 1] })), { id: id(), name: 'Lost', parentId: id() }];
  let result: any;
  const requests = await requestsFor(async () => (result = await (await call('PUT', '/api/folders', { folders: items })).json()));
  assert.equal(requests, 2, 'one read of the folders and one write of them all');
  assert.equal(result.ok.length, 20);
  assert.deepEqual(result.failed.map((f: any) => f.error), ['no such folder']);
  const listed = (await (await call('GET', '/api/folders')).json()) as any[];
  assert.equal(listed.find((f) => f.id === ids[19]).parentId, ids[18]);
  // A cycle through folders made in the same batch is still refused.
  const cycle = await (await call('PUT', '/api/folders', { folders: [{ id: top, name: 'Top', parentId: ids[19] }] })).json() as any;
  assert.deepEqual(cycle.failed.map((f: any) => f.error), ['a folder cannot go inside itself']);
});

test('moving many documents takes few requests to Cloudflare, and a missing one is reported', async () => {
  const to = await folder('To');
  const docs = [];
  for (let i = 0; i < 5; i++) docs.push((await create()).id);
  const missing = id();
  let result: any;
  const requests = await requestsFor(async () => (result = await (await call('PATCH', '/api/documents', { ids: [...docs, missing], folderId: to })).json()));
  assert.equal(requests, 3, 'the documents read, the folder checked, and one update for all of them');
  assert.deepEqual(result.ok, docs);
  assert.deepEqual(result.failed, [{ id: missing, error: 'not found' }]);
  const listed = (await (await call('GET', '/api/documents')).json()) as any[];
  assert.ok(listed.every((d) => d.folderId === to));
  const bad = (await (await call('PATCH', '/api/documents', { ids: docs, folderId: id() })).json()) as any;
  assert.deepEqual(bad.failed.map((f: any) => f.error), docs.map(() => 'no such folder'));
});

test('deleting folders takes two requests to Cloudflare however many, and nested ones move things up twice', async () => {
  const a = await folder('A');
  const b = await folder('B', a);
  const c = await folder('C', b);
  const doc = (await create(`&folder=${b}`)).id;
  let result: any;
  const requests = await requestsFor(async () => (result = await (await call('DELETE', '/api/folders', { ids: [b, a] })).json()));
  assert.equal(requests, 2);
  assert.deepEqual(result.ok, [b, a]);
  const listed = (await (await call('GET', '/api/folders')).json()) as any[];
  assert.deepEqual(listed.map((f) => [f.id, f.parentId]), [[c, null]]);
  assert.equal(((await (await call('GET', '/api/documents')).json()) as any[]).find((d) => d.id === doc).folderId, null);
  assert.equal(await requestsFor(async () => assert.equal((await call('DELETE', `/api/folders/${c}`)).status, 204)), 2);
  assert.equal((await call('DELETE', `/api/folders/${c}`)).status, 404);
});
