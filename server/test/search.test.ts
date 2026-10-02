// The assistant's document search: chunking, indexing on demand, and what a search returns. The
// embedding model and the Vectorize index are faked: words hash into a 1024-dimension vector, so
// texts that share words are close together, as real embeddings roughly make them.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { WordDocument } from '@golemdocs/docx';
import { DIMENSIONS, MAX_CHUNKS, MAX_CHUNK_CHARS, MAX_INDEXED_PER_SEARCH, chunkSegments } from '../src/search.ts';
import { DOCX, world, type World } from './harness.ts';

let w: World;
let embedded: string[];
let vectors: Map<string, { values: number[]; namespace?: string; metadata?: Record<string, unknown> }>;
let deleted: string[];

const embedText = (text: string): number[] => {
  const v = new Array<number>(DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 7;
    for (const c of word) h = (h * 31 + c.charCodeAt(0)) % DIMENSIONS;
    v[h]! += 1;
  }
  const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0)) || 1;
  return v.map((x) => x / norm);
};
const cosine = (a: number[], b: number[]) => a.reduce((n, x, i) => n + x * b[i]!, 0);

beforeEach(() => {
  w = world();
  embedded = [];
  deleted = [];
  vectors = new Map();
  w.env.AI = {
    async run(_model: string, inputs: unknown) {
      const text = (inputs as { text: string[] }).text;
      embedded.push(...text);
      return { shape: [text.length, DIMENSIONS], data: text.map(embedText) };
    },
  };
  w.env.VECTORS = {
    async upsert(list) {
      for (const v of list) vectors.set(v.id, v);
    },
    async query(vector, options) {
      const matches = [...vectors.entries()]
        .filter(([, v]) => v.namespace === options.namespace)
        .map(([id, v]) => ({ id, score: cosine(vector, v.values), metadata: v.metadata }))
        .sort((a, b) => b.score - a.score)
        .slice(0, options.topK);
      return { matches };
    },
    async deleteByIds(ids) {
      deleted.push(...ids);
      for (const id of ids) vectors.delete(id);
    },
  };
});
afterEach(() => w.restore());

async function docx(...paragraphs: string[]): Promise<Uint8Array> {
  const doc = await WordDocument.create();
  doc.body = paragraphs.map((text) => ({
    kind: 'paragraph' as const,
    properties: text.startsWith('# ') ? { style: 'Heading1' } : {},
    children: [{ kind: 'run' as const, properties: {}, attrs: {}, content: [{ kind: 'text' as const, text: text.replace(/^# /, '') }] }],
    attrs: {},
  }));
  doc.styles.styles.push({ type: 'paragraph', id: 'Heading1', name: 'Heading 1' });
  return doc.write();
}

async function upload(as: string, name: string, bytes: Uint8Array) {
  const response = await w.call(as, 'POST', `/api/documents?name=${encodeURIComponent(name)}`, { body: bytes, type: DOCX });
  assert.equal(response.status, 201);
  return (await response.json()) as { id: string; updatedAt: number };
}
const search = (as: string | null, q: string) => w.call(as, 'GET', `/api/assistant/search?q=${encodeURIComponent(q)}`);

// --- chunking ---------------------------------------------------------------------------------

test('chunks start at headings, are bounded, and skip blank paragraphs', () => {
  const chunks = chunkSegments([
    { style: 'Heading 1', text: 'Kitchen' },
    { text: 'Budget is 12000.' },
    { text: '   ' },
    { text: 'Paint the walls.' },
    { style: 'Heading 1', text: 'Garden' },
    { text: 'Plant roses.' },
  ]);
  assert.deepEqual(chunks, [
    { start: 0, text: 'Kitchen\nBudget is 12000.\nPaint the walls.' },
    { start: 4, text: 'Garden\nPlant roses.' },
  ]);
});

test('a long paragraph is cut up, and a long document stops at the chunk limit', () => {
  const long = chunkSegments([{ text: 'x'.repeat(MAX_CHUNK_CHARS * 2 + 10) }]);
  assert.equal(long.length, 3);
  assert.ok(long.every((c) => c.text.length <= MAX_CHUNK_CHARS));
  const many = chunkSegments(Array.from({ length: 500 }, (_, i) => ({ style: 'Heading 1', text: `Part ${i}` })));
  assert.equal(many.length, MAX_CHUNKS);
});

// --- the route --------------------------------------------------------------------------------

test('signed out, unsubscribed, unconfigured and empty searches are refused', async () => {
  assert.equal((await search(null, 'x')).status, 401);
  const alice = 'alice@example.com';
  await w.signUp(alice);
  assert.equal((await search(alice, 'x')).status, 402);
  const sub = 'sub@example.com';
  await w.signUp(sub, 'Sub', { subscribed: true });
  assert.equal((await search(sub, '   ')).status, 400);
  delete w.env.VECTORS;
  assert.equal((await search(sub, 'x')).status, 503);
});

test('a search indexes what it needs and finds the document that is about the question', async () => {
  const me = 'sub@example.com';
  await w.signUp(me, 'Sub', { subscribed: true });
  const kitchen = await upload(me, 'Kitchen.docx', await docx('# Renovation', 'The cabinets cost twelve thousand dollars.', 'Replace the oven.'));
  await upload(me, 'Trip.docx', await docx('# Lisbon', 'We visited castles and ate pastries.'));
  const found = (await (await search(me, 'how much were the cabinets')).json()) as { hits: { id: string; name: string; paragraph: number; text: string }[]; pending: number };
  assert.equal(found.pending, 0);
  assert.equal(found.hits[0]!.id, kitchen.id);
  assert.equal(found.hits[0]!.name, 'Kitchen.docx');
  assert.equal(found.hits[0]!.paragraph, 0);
  assert.match(found.hits[0]!.text, /cabinets/);
  assert.equal(vectors.size, 2);
  // The name goes into what is embedded.
  assert.ok(embedded.some((t) => t.startsWith('Kitchen.docx\n')));
});

test('a document is embedded once, and again only after it changes', async () => {
  const me = 'sub@example.com';
  await w.signUp(me, 'Sub', { subscribed: true });
  const doc = await upload(me, 'A.docx', await docx('# One', 'alpha beta gamma'));
  await search(me, 'alpha');
  const first = embedded.length;
  await search(me, 'beta');
  assert.equal(embedded.length, first + 1, 'only the question is embedded the second time');
  // Shorter after an edit: the extra vectors go.
  const long = await upload(me, 'B.docx', await docx('# One', 'x', '# Two', 'y', '# Three', 'z'));
  await search(me, 'x');
  assert.equal([...vectors.keys()].filter((k) => k.startsWith(`${long.id}:`)).length, 3);
  const put = await w.call(me, 'PUT', `/api/documents/${long.id}`, { body: await docx('# One', 'x'), type: DOCX });
  assert.equal(put.status, 200);
  await search(me, 'x');
  assert.deepEqual(deleted.sort(), [`${long.id}:1`, `${long.id}:2`]);
  assert.ok(vectors.has(`${doc.id}:0`));
});

test('only a few documents are indexed per search, and the rest are reported waiting', async () => {
  const me = 'sub@example.com';
  await w.signUp(me, 'Sub', { subscribed: true });
  for (let i = 0; i < MAX_INDEXED_PER_SEARCH + 2; i++) await upload(me, `D${i}.docx`, await docx(`# Doc ${i}`, `unique${i}`));
  const first = (await (await search(me, 'unique')).json()) as { pending: number };
  assert.equal(first.pending, 2);
  const second = (await (await search(me, 'unique')).json()) as { pending: number };
  assert.equal(second.pending, 0);
});

test('one person never sees another person’s documents', async () => {
  const mine = 'sub@example.com';
  await w.signUp(mine, 'Sub', { subscribed: true });
  const theirs = 'other@example.com';
  await w.signUp(theirs, 'Other', { subscribed: true });
  await upload(theirs, 'Secret.docx', await docx('# Plans', 'the secret recipe'));
  await upload(mine, 'Mine.docx', await docx('# Notes', 'groceries'));
  const found = (await (await search(mine, 'secret recipe')).json()) as { hits: { name: string }[] };
  assert.deepEqual(found.hits.map((h) => h.name), ['Mine.docx']);
});

test('deleting a document removes it from the index and from results', async () => {
  const me = 'sub@example.com';
  await w.signUp(me, 'Sub', { subscribed: true });
  const doc = await upload(me, 'Gone.docx', await docx('# Title', 'remember this'));
  await search(me, 'remember');
  assert.ok(vectors.has(`${doc.id}:0`));
  assert.equal((await w.call(me, 'DELETE', `/api/documents/${doc.id}`)).status, 204);
  assert.equal(vectors.size, 0);
  assert.deepEqual(((await (await search(me, 'remember')).json()) as { hits: unknown[] }).hits, []);
});

test('deleting documents together removes each from the index and from results too', async () => {
  const me = 'sub@example.com';
  await w.signUp(me, 'Sub', { subscribed: true });
  const first = await upload(me, 'One.docx', await docx('# One', 'remember this one'));
  const second = await upload(me, 'Two.docx', await docx('# Two', 'remember this two'));
  await search(me, 'remember');
  assert.ok(vectors.has(`${first.id}:0`) && vectors.has(`${second.id}:0`));
  const response = await w.call(me, 'DELETE', '/api/documents', { body: JSON.stringify({ ids: [first.id, second.id] }), type: 'application/json' });
  assert.equal(response.status, 200);
  assert.equal(vectors.size, 0);
  assert.deepEqual(((await (await search(me, 'remember')).json()) as { hits: unknown[] }).hits, []);
});

test('a document that cannot be read is skipped, not fatal', async () => {
  const me = 'sub@example.com';
  await w.signUp(me, 'Sub', { subscribed: true });
  await w.call(me, 'POST', '/api/documents?name=Bad.docx', { body: new Uint8Array([1, 2, 3]), type: DOCX });
  await upload(me, 'Good.docx', await docx('# Fine', 'readable words'));
  const found = (await (await search(me, 'readable')).json()) as { hits: { name: string }[]; pending: number };
  assert.equal(found.hits[0]!.name, 'Good.docx');
  assert.equal(found.pending, 1);
});
