// GET /api/documents/:id/index: built on the first request after a change, kept in R2 with a stamp,
// and used again only while the stamp matches.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { INDEX_VERSION, WordDocument, decodeIndex, writeZip } from '@golemdocs/docx';
import { DOCX, world, type World } from './harness.ts';

let w: World;
const OWNER = 'owner@example.com';
const ALICE = 'alice@example.com';
beforeEach(async () => {
  w = world();
  for (const email of [OWNER, ALICE]) await w.signUp(email, email.split('@')[0]);
});
afterEach(() => w.restore());

async function docx(...paragraphs: string[]): Promise<Uint8Array> {
  const doc = await WordDocument.create();
  doc.body = paragraphs.map((text) => ({
    kind: 'paragraph' as const,
    properties: {},
    children: [{ kind: 'run' as const, properties: {}, attrs: {}, content: [{ kind: 'text' as const, text }] }],
    attrs: {},
  }));
  return doc.write();
}
async function create(...paragraphs: string[]): Promise<{ id: string; updatedAt: number }> {
  const r = await w.call(OWNER, 'POST', '/api/documents?name=Doc.docx', { body: await docx(...paragraphs), type: DOCX });
  assert.equal(r.status, 201);
  return (await r.json()) as any;
}
const idxKeys = () => [...w.objects.keys()].filter((k) => k.endsWith('.idx'));
const index = (as: string, id: string) => w.call(as, 'GET', `/api/documents/${id}/index`);
const words = async (r: Response) => Object.keys((await decodeIndex(new Uint8Array(await r.arrayBuffer())))!.t);

test('the first request builds the index and stores it with its stamp', async () => {
  const doc = await create('Zebra crossing');
  assert.equal(idxKeys().length, 0, 'saving builds nothing');
  const r = await index(OWNER, doc.id);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('x-index-at'), String(doc.updatedAt));
  assert.equal(r.headers.get('cache-control'), 'private, no-cache');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(r.headers.get('etag'));
  assert.ok((await words(r)).includes('zebra'));
  const [key] = idxKeys();
  const stored = w.objects.get(key!)!;
  assert.deepEqual(stored.customMetadata, { v: String(INDEX_VERSION), at: String(doc.updatedAt) });
  assert.equal(stored.contentType, 'application/octet-stream');
  assert.equal(Number(r.headers.get('content-length')), stored.bytes.byteLength);
});

test('a matching stored index is returned as it is', async () => {
  const doc = await create('Zebra crossing');
  await index(OWNER, doc.id);
  const key = idxKeys()[0]!;
  const marker = new Uint8Array([9, 9, 9]).buffer;
  w.objects.get(key)!.bytes = marker;
  const r = await index(OWNER, doc.id);
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [9, 9, 9]);
});

test('a changed document or a different version makes it again', async () => {
  const doc = await create('Zebra crossing');
  await index(OWNER, doc.id);
  const put = await w.call(OWNER, 'PUT', `/api/documents/${doc.id}`, { body: await docx('Giraffe parade'), type: DOCX });
  assert.equal(put.status, 200);
  const changed = (await put.json()) as { updatedAt: number };
  assert.notEqual(changed.updatedAt, doc.updatedAt);
  const r = await index(OWNER, doc.id);
  assert.equal(r.headers.get('x-index-at'), String(changed.updatedAt));
  const list = await words(r);
  assert.ok(list.includes('giraffe') && !list.includes('zebra'));
  const key = idxKeys()[0]!;
  assert.equal(w.objects.get(key)!.customMetadata!.at, String(changed.updatedAt));

  w.objects.get(key)!.customMetadata!.v = String(INDEX_VERSION - 1);
  w.objects.get(key)!.bytes = new Uint8Array([9]).buffer;
  assert.ok((await words(await index(OWNER, doc.id))).includes('giraffe'));
  assert.equal(w.objects.get(key)!.customMetadata!.v, String(INDEX_VERSION));
});

test('a viewer can fetch it; someone with no access gets 404; other methods 405', async () => {
  const doc = await create('Zebra crossing');
  assert.equal((await index(ALICE, doc.id)).status, 404);
  const shared = await w.call(OWNER, 'PUT', `/api/documents/${doc.id}/shares`, { body: JSON.stringify({ email: ALICE, role: 'viewer' }), type: 'application/json' });
  assert.equal(shared.status, 200);
  assert.equal((await index(ALICE, doc.id)).status, 200);
  assert.equal((await w.call(OWNER, 'PUT', `/api/documents/${doc.id}/index`, { body: new Uint8Array([1]) })).status, 405);
  assert.equal((await w.call(null, 'GET', `/api/documents/${doc.id}/index`)).status, 401);
});

test('a file that is not a .docx answers 422', async () => {
  const r = await w.call(OWNER, 'POST', '/api/documents?name=Doc.docx', { body: new Uint8Array([0, 1, 2, 3]), type: DOCX });
  const doc = (await r.json()) as any;
  assert.equal((await index(OWNER, doc.id)).status, 422);
  assert.equal(idxKeys().length, 0);
});

test('a file that is not a ZIP (a PDF, a picture) answers 422 without logging a failure', async () => {
  const r = await w.call(OWNER, 'POST', '/api/documents?name=Doc.pdf', { body: new TextEncoder().encode('%PDF-1.7\n\u0000\u0001binary'), type: 'application/pdf' });
  const doc = (await r.json()) as any;
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    assert.equal((await index(OWNER, doc.id)).status, 422);
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged, []);
});

test('deleting a document deletes its index too', async () => {
  const doc = await create('Zebra crossing');
  await index(OWNER, doc.id);
  assert.equal(idxKeys().length, 1);
  assert.equal((await w.call(OWNER, 'DELETE', `/api/documents/${doc.id}`)).status, 204);
  // The trash keeps the document (and so its index is rebuilt, when asked) until it is emptied.
  assert.equal((await w.call(OWNER, 'DELETE', '/api/trash')).status, 204);
  assert.equal(w.objects.size, 0);
});

/** What the app uploads: its own .wdoc (a ZIP with the .docx inside) under the document's key. */
async function wdoc(document: Uint8Array | null, original?: Uint8Array): Promise<Uint8Array> {
  const text = (value: string) => new TextEncoder().encode(value);
  return writeZip([
    { name: 'mimetype', data: text('application/x-golem-document'), compress: false },
    { name: 'manifest.json', data: text(JSON.stringify({ version: 1, lens: 'docx', origin: 'docx', pagesCurrent: true })) },
    ...(document ? [{ name: 'document.docx', data: document, compress: false }] : []),
    ...(original ? [{ name: 'originals/source.pdf', data: original, compress: false }] : []),
  ]);
}

test('the app\'s own .wdoc wrapper is read through to the document inside', async () => {
  const r = await w.call(OWNER, 'POST', '/api/documents?name=Doc.wdoc', { body: await wdoc(await docx('Giraffe necks')), type: DOCX });
  const doc = (await r.json()) as { id: string; updatedAt: number };
  const answer = await index(OWNER, doc.id);
  assert.equal(answer.status, 200);
  assert.ok((await words(answer)).includes('giraffe'));
  assert.equal(answer.headers.get('x-index-at'), String(doc.updatedAt));
});

test('a .wdoc with no flowing document (a PDF not turned into one) has no text here: refused, and nothing is kept', async () => {
  const r = await w.call(OWNER, 'POST', '/api/documents?name=Scan.wdoc', { body: await wdoc(null, new Uint8Array([37, 80, 68, 70])), type: DOCX });
  const doc = (await r.json()) as { id: string };
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal((await index(OWNER, doc.id)).status, 422);
  } finally {
    console.error = quiet;
  }
  assert.equal(idxKeys().length, 0);
});

test('a plain text file is indexed by its lines', async () => {
  const r = await w.call(OWNER, 'POST', '/api/documents?name=Notes.txt', { body: new TextEncoder().encode('first line\nsecond line with cabinets\n'), type: 'text/plain' });
  const doc = (await r.json()) as any;
  const response = await index(OWNER, doc.id);
  assert.equal(response.status, 200);
  assert.equal(((await decodeIndex(new Uint8Array(await response.arrayBuffer())))!).n, 3);
});
