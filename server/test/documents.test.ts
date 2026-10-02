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

/** The body of POST /api/documents/batch (see uploadBatch in worker.ts). */
function batchBody(documents: { name: string; bytes: number[]; folderId?: string | null }[]): Uint8Array {
  const header = new TextEncoder().encode(JSON.stringify({ documents: documents.map((d) => ({ name: d.name, size: d.bytes.length, folderId: d.folderId ?? null })) }));
  const body = new Uint8Array(4 + header.length + documents.reduce((n, d) => n + d.bytes.length, 0));
  new DataView(body.buffer).setUint32(0, header.length);
  body.set(header, 4);
  let at = 4 + header.length;
  for (const d of documents) {
    body.set(d.bytes, at);
    at += d.bytes.length;
  }
  return body;
}

test('a batch upload makes every document, in a folder if it names one, and reports each that cannot be made', async () => {
  const folder = (await (await call('PUT', '/api/folders/' + crypto.randomUUID(), { body: JSON.stringify({ name: 'Books', parentId: null }), type: 'application/json' })).json()) as any;
  const sent = [
    { name: 'A.md', bytes: [1, 2], folderId: folder.id },
    { name: 'B.md', bytes: [3] },
    { name: 'Empty.md', bytes: [] },
    { name: 'Lost.md', bytes: [4], folderId: crypto.randomUUID() },
  ];
  const response = await call('POST', '/api/documents/batch', { body: batchBody(sent) });
  assert.equal(response.status, 201);
  const { results } = (await response.json()) as { results: any[] };
  assert.equal(results.length, 4);
  assert.equal(results[0].document.name, 'A.md');
  assert.equal(results[0].document.folderId, folder.id);
  assert.equal(results[1].document.folderId, null);
  assert.equal(results[2].error, 'empty body');
  assert.equal(results[3].error, 'no such folder');

  const listed = (await (await call('GET', '/api/documents')).json()) as any[];
  assert.deepEqual(listed.map((d) => d.name).sort(), ['A.md', 'B.md']);
  const got = await call('GET', `/api/documents/${results[0].document.id}`);
  assert.deepEqual([...new Uint8Array(await got.arrayBuffer())], [1, 2]);
});

test('a batch of many documents takes few requests to Cloudflare', async () => {
  await create(); // the first request makes and migrates the user's database
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => (requests++, realFetch(...args))) as typeof fetch;
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `Doc ${i}.md`, bytes: [i + 1] }));
  const { results } = (await (await call('POST', '/api/documents/batch', { body: batchBody(many) })).json()) as { results: any[] };
  assert.equal(results.filter((r) => r.document).length, 40);
  // One request for the three inserts (14 rows each), not a folder check and an insert per document.
  assert.equal(requests, 1);
  assert.equal(((await (await call('GET', '/api/documents')).json()) as any[]).length, 41);
});

test('a malformed batch is refused', async () => {
  assert.equal((await call('POST', '/api/documents/batch', { body: new Uint8Array([0, 0]) })).status, 400);
  const truncated = batchBody([{ name: 'A.md', bytes: [1, 2, 3] }]).slice(0, -1);
  assert.equal((await call('POST', '/api/documents/batch', { body: truncated })).status, 400);
  assert.equal((await call('GET', '/api/documents/batch')).status, 405);
});

test('when Cloudflare rate limits the API the page is told to wait, not that the server broke', async () => {
  await create();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ success: false, errors: [{ code: 971, message: 'rate limited' }] }), { status: 429, headers: { 'retry-after': '7' } })) as typeof fetch;
  try {
    const response = await call('GET', '/api/documents');
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '7');
  } finally {
    globalThis.fetch = realFetch;
  }
});
