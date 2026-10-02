// The document API's thumbnails end to end: the real worker against a fake R2 and per-user D1
// databases (see harness.ts).

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

const call = (method: string, path: string, init: { body?: BodyInit; type?: string } = {}) => w.call('dev@example.com', method, path, init);

const create = async () => (await (await call('POST', '/api/documents?name=Doc.docx', { body: new Uint8Array([1, 2, 3]), type: DOCX })).json()) as any;

test('migration 2 adds thumb_at', () => {
  const db = new DatabaseSync(':memory:');
  for (const statements of USER_MIGRATIONS) for (const sql of statements) db.exec(sql);
  assert.ok((db.prepare('PRAGMA table_info(documents)').all() as { name: string }[]).some((c) => c.name === 'thumb_at'));
});

test('a new document has no thumbnail until one is uploaded', async () => {
  const doc = await create();
  assert.equal(doc.thumbAt, null);
  assert.equal((await call('GET', `/api/documents/${doc.id}/thumbnail`)).status, 404);
  assert.equal((await (await call('GET', '/api/documents')).json() as any[])[0].thumbAt, null);
});

test('uploading a thumbnail records when, and serves it back with a long cache for versioned URLs', async () => {
  const doc = await create();
  const image = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
  const put = await call('PUT', `/api/documents/${doc.id}/thumbnail`, { body: image, type: 'image/webp' });
  assert.equal(put.status, 200);
  const updated = (await put.json()) as any;
  assert.equal(typeof updated.thumbAt, 'number');
  assert.equal(updated.updatedAt, doc.updatedAt, 'the document itself is unchanged');
  assert.equal(((await (await call('GET', '/api/documents')).json()) as any[])[0].thumbAt, updated.thumbAt);

  const got = await call('GET', `/api/documents/${doc.id}/thumbnail?v=${updated.thumbAt}`);
  assert.equal(got.headers.get('content-type'), 'image/webp');
  assert.match(got.headers.get('cache-control')!, /immutable/);
  assert.deepEqual([...new Uint8Array(await got.arrayBuffer())], [...image]);
  assert.doesNotMatch((await call('GET', `/api/documents/${doc.id}/thumbnail`)).headers.get('cache-control')!, /immutable/);
});

test('only small images are accepted as thumbnails', async () => {
  const doc = await create();
  const path = `/api/documents/${doc.id}/thumbnail`;
  assert.equal((await call('PUT', path, { body: new Uint8Array([1]), type: 'text/html' })).status, 415);
  assert.equal((await call('PUT', path, { body: new Uint8Array(600 * 1024), type: 'image/png' })).status, 413);
  assert.equal((await call('PUT', path, { body: new Uint8Array(0), type: 'image/png' })).status, 400);
  assert.equal((await call('POST', path, { body: new Uint8Array([1]), type: 'image/png' })).status, 405);
});

test('deleting a document deletes its thumbnail too', async () => {
  const doc = await create();
  await call('PUT', `/api/documents/${doc.id}/thumbnail`, { body: new Uint8Array([1]), type: 'image/png' });
  assert.equal([...w.objects.keys()].filter((k) => k.endsWith('.thumb')).length, 1);
  assert.equal((await call('DELETE', `/api/documents/${doc.id}`)).status, 204);
  assert.equal(w.objects.size, 0);
});

test('thumbnails of unknown documents are 404, and need a session', async () => {
  assert.equal((await call('GET', '/api/documents/00000000-0000-4000-8000-000000000000/thumbnail')).status, 404);
  assert.equal((await w.call(null, 'GET', '/api/documents/00000000-0000-4000-8000-000000000000/thumbnail')).status, 401);
});

test('a save based on an older version is refused, not written over the newer one', async () => {
  const doc = await create();
  const put = (base: number) => call('PUT', `/api/documents/${doc.id}?base=${base}`, { body: new Uint8Array([4]), type: DOCX });
  const first = await put(doc.updatedAt);
  assert.equal(first.status, 200);
  const saved = (await first.json()) as any;
  assert.ok(saved.updatedAt > doc.updatedAt, 'every save moves the version on');

  const stale = await put(doc.updatedAt); // another device, still on the first version
  assert.equal(stale.status, 409);
  assert.equal((await put(saved.updatedAt)).status, 200);
  // Without a base, a save always goes through.
  assert.equal((await call('PUT', `/api/documents/${doc.id}`, { body: new Uint8Array([5]), type: DOCX })).status, 200);
});

test('the document list is cached, and every change shows up in the next listing', async () => {
  const doc = await create();
  const names = async () => ((await (await call('GET', '/api/documents')).json()) as any[]).map((d) => d.name);
  assert.deepEqual(await names(), ['Doc.docx']);
  const cached = w.directory.prepare("SELECT kind FROM catalogue_cache WHERE kind = 'documents'").all();
  assert.equal(cached.length, 1, 'the first listing is kept');

  await call('PUT', `/api/documents/${doc.id}?name=Renamed.docx`, { body: new Uint8Array([4]), type: DOCX });
  assert.deepEqual(await names(), ['Renamed.docx']);
  await create();
  assert.equal((await names()).length, 2);
  await call('DELETE', `/api/documents/${doc.id}`);
  assert.equal((await names()).length, 1);
});

test('a folder change shows up in the next listing', async () => {
  const folders = async () => ((await (await call('GET', '/api/folders')).json()) as any[]).map((f) => f.name);
  assert.deepEqual(await folders(), []);
  const fid = crypto.randomUUID();
  await call('PUT', `/api/folders/${fid}`, { body: JSON.stringify({ name: 'A', parentId: null }), type: 'application/json' });
  assert.deepEqual(await folders(), ['A']);
  await call('PUT', `/api/folders/${fid}`, { body: JSON.stringify({ name: 'B', parentId: null }), type: 'application/json' });
  assert.deepEqual(await folders(), ['B']);
});

test('a listing still works when the cache table is missing', async () => {
  await create();
  w.directory.exec('DROP TABLE catalogue_cache');
  assert.equal(((await (await call('GET', '/api/documents')).json()) as any[]).length, 1);
  await create();
  assert.equal(((await (await call('GET', '/api/documents')).json()) as any[]).length, 2);
});
