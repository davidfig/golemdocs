// Searching every document by its content: the indexes are kept per document and made again only
// when the document changes. No browser: documents are Markdown read into the bytes the cloud stores,
// and the index store is a map.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndex, paragraphSegments, type DocIndex } from '@golemdocs/docx';
import { readDocument } from '../src/formats/convert.ts';
import { segmentsFromBytes } from '../src/formats/docBytes.ts';
import { indexFromBytes } from '../src/search/indexJob.ts';
import { SearchLibrary, type IndexStore, type SearchableDocument } from '../src/search/searchLibrary.ts';
import { searchableDocuments, type SourceDeps } from '../src/search/sources.ts';
import type { StoredIndex } from '../src/storage/local.ts';
import type { CloudDocument } from '../src/cloud.ts';
import type { LibraryEntry } from '../src/sync.ts';

const encoder = new TextEncoder();
const segmentsOf = async (md: string) => paragraphSegments(await readDocument('md', encoder.encode(md)));
const bytesOf = async (md: string): Promise<ArrayBuffer> => {
  const out = await (await readDocument('md', encoder.encode(md))).write();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
};

function memoryStore(): IndexStore & { rows: Map<string, StoredIndex>; puts: number } {
  const rows = new Map<string, StoredIndex>();
  return {
    rows,
    puts: 0,
    list: async () => new Map(rows),
    put: async function (key, stored) {
      this.puts++;
      rows.set(key, stored);
    },
    remove: async (keys) => void keys.forEach((k) => rows.delete(k)),
  };
}

const doc = (key: string, name: string, md: string, stamp = 'l:1', extra: Partial<SearchableDocument> = {}): SearchableDocument => ({
  key,
  name,
  updatedAt: 1,
  size: md.length,
  stamp,
  bytes: () => bytesOf(md),
  ...extra,
});

test('documents are indexed, and found by their words, tags and names', async () => {
  const store = memoryStore();
  const lib = new SearchLibrary(store, indexFromBytes);
  const docs = [doc('a', 'Kitchen.md', '# Kitchen plan\n\nBuy cabinets #renovation'), doc('b', 'Garden.md', 'Plant roses #garden/spring'), doc('c', 'Taxes.md', 'Nothing about the house')];
  await lib.sync(docs);
  assert.equal(store.rows.size, 3);
  assert.deepEqual((await lib.search('cabinets', docs)).hits.map((h) => h.key), ['a']);
  assert.deepEqual((await lib.search('#renovation', docs)).hits.map((h) => h.key), ['a']);
  assert.deepEqual((await lib.search('#garden', docs)).hits.map((h) => h.key), ['b']);
  assert.deepEqual((await lib.search('garden', docs)).hits.map((h) => h.key), ['b']); // the name, and the tag's word
  const hit = (await lib.search('roses', docs)).hits[0]!;
  assert.equal(hit.paragraph, 0);
  assert.match(hit.text!, /Plant roses/);
  assert.deepEqual((await lib.search('zebra', docs)).hits, []);
  assert.deepEqual((await lib.search('', docs)).hits, []);
});

test('a document is read again only when its version changed', async () => {
  const store = memoryStore();
  const lib = new SearchLibrary(store, indexFromBytes);
  let reads = 0;
  const make = (stamp: string, md: string) => doc('a', 'Note.md', md, stamp, { bytes: async () => (reads++, bytesOf(md)) });
  await lib.sync([make('l:1', 'first words')]);
  await lib.sync([make('l:1', 'first words')]);
  assert.equal(reads, 1);
  await lib.sync([make('l:2', 'second words')]);
  assert.equal(reads, 2);
  assert.equal((await lib.search('second', [make('l:2', '')])).hits.length, 1);
  assert.equal((await lib.search('first', [make('l:2', '')])).hits.length, 0);
  // A fresh start (another tab, a reload) uses what was kept.
  const again = new SearchLibrary(store, indexFromBytes);
  await again.sync([make('l:2', 'second words')]);
  assert.equal(reads, 2);
});

test('the account\'s index is used in place of reading the document', async () => {
  const lib = new SearchLibrary(memoryStore(), indexFromBytes);
  let reads = 0;
  const index: DocIndex = buildIndex(await segmentsOf('from the account'));
  const cloud = doc('a', 'Note.docx', 'unused', 'c:50', { bytes: async () => (reads++, bytesOf('')), fromCloud: async () => ({ index, at: 50 }) });
  await lib.sync([cloud]);
  assert.equal(reads, 0);
  assert.equal((await lib.search('account', [cloud])).hits.length, 1);
  assert.equal((await lib.search('account', [cloud])).pending, 0);
  // When the account has none (too big, an older server) the document is read.
  const lone = doc('b', 'Other.docx', 'read here', 'c:7', { fromCloud: async () => null });
  await lib.sync([cloud, lone]);
  assert.equal((await lib.search('here', [cloud, lone])).hits.length, 1);
  // An index for a different version than listed is kept under the version it is for, and counts as pending.
  const newer = doc('c', 'Moved.docx', 'x', 'c:9', { fromCloud: async () => ({ index, at: 10 }) });
  await lib.sync([newer]);
  assert.equal((await lib.search('account', [newer])).pending, 1);
});

test('documents that are gone lose their index, and failures wait for another try', async () => {
  const store = memoryStore();
  const lib = new SearchLibrary(store, indexFromBytes);
  const a = doc('a', 'A.md', 'alpha');
  const b = doc('b', 'B.md', 'beta');
  await lib.sync([a, b]);
  await lib.sync([a]);
  assert.deepEqual([...store.rows.keys()], ['a']);
  const flaky = doc('c', 'Ledger.md', 'gamma', 'l:1', { bytes: async () => { throw new Error('offline'); } });
  const quiet = console.error;
  console.error = () => {};
  try {
    await lib.sync([a, flaky]);
  } finally {
    console.error = quiet;
  }
  assert.equal(store.rows.has('c'), false);
  const found = await lib.search('gamma', [a, flaky]);
  assert.equal(found.pending, 1);
  assert.deepEqual(found.hits, []);
  // Its name can still find it meanwhile.
  assert.deepEqual((await lib.search('ledger', [a, flaky])).hits.map((h) => h.key), ['c']);
});

test('tags are counted by how many documents use them', async () => {
  const lib = new SearchLibrary(memoryStore(), indexFromBytes);
  const docs = [doc('a', 'A', '#work and #home'), doc('b', 'B', '#work again #Work'), doc('c', 'C', '#home')];
  await lib.sync(docs);
  assert.deepEqual(await lib.tags(docs), [
    { tag: 'home', documents: 2 },
    { tag: 'work', documents: 2 },
  ]);
});

test('big documents are skipped but remembered, and progress is announced', async () => {
  const lib = new SearchLibrary(memoryStore(), indexFromBytes);
  const seen: (number | null)[] = [];
  lib.subscribe((p) => seen.push(p ? p.done : null));
  const big = { ...doc('a', 'Big.md', 'needle'), size: 7_000_000 };
  await lib.sync([big, doc('b', 'B.md', 'hay')]);
  assert.deepEqual((await lib.search('needle', [big])).hits, []);
  assert.deepEqual((await lib.search('needle', [big])).pending, 0);
  assert.deepEqual(seen, [0, 1, 2, null]);
});

test('entries are searched as the account\'s copy when that is what opens, else as the browser\'s', async () => {
  const bytes = async (md: string) => {
    const out = await (await readDocument('md', encoder.encode(md))).write();
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  };
  const calls: string[] = [];
  const deps: SourceDeps = {
    local: async (id) => (calls.push(`local:${id}`), bytes('local text')),
    download: async (id) => (calls.push(`download:${id}`), bytes('cloud text')),
    index: async (id) => (calls.push(`index:${id}`), null),
  };
  const info = (over: object) => ({ id: 'L', name: 'N.docx', size: 1, updatedAt: 5, ...over }) as LibraryEntry['local'];
  const cloud = (over: object = {}) => ({ id: 'C', name: 'N.docx', size: 1, createdAt: 1, updatedAt: 9, thumbAt: null, ...over }) as CloudDocument;
  const entry = (state: LibraryEntry['state'], local: LibraryEntry['local'], c: CloudDocument | null): LibraryEntry => ({ key: 'k', name: 'N.docx', size: 1, updatedAt: 5, local, cloud: c, state, folderId: null });

  const [synced] = searchableDocuments([entry('synced', info({ cloudId: 'C' }), cloud())], [], deps);
  assert.equal(synced!.stamp, 'c:9');
  assert.ok(synced!.fromCloud);
  assert.match(JSON.stringify(await segmentsFromBytes(await synced!.bytes())), /local text/); // the same bytes, already here

  const [ahead] = searchableDocuments([entry('local-ahead', info({ cloudId: 'C' }), cloud())], [], deps);
  assert.equal(ahead!.stamp, 'l:5');
  assert.equal(ahead!.fromCloud, undefined);

  const [only] = searchableDocuments([entry('cloud-only', null, cloud())], [], deps);
  assert.equal(only!.stamp, 'c:9');
  assert.match(JSON.stringify(await segmentsFromBytes(await only!.bytes())), /cloud text/);

  const [behind] = searchableDocuments([entry('cloud-ahead', info({ cloudId: 'C' }), cloud())], [], deps);
  assert.match(JSON.stringify(await segmentsFromBytes(await behind!.bytes())), /cloud text/);

  const list = searchableDocuments([entry('cloud-only', null, cloud())], [cloud(), cloud({ id: 'S', name: 'Shared.docx', owner: { name: 'Ann', email: null } })], deps);
  assert.deepEqual(list.map((d) => [d.key, d.place]), [['k', undefined], ['S', 'Ann']]);
  await list[1]!.fromCloud!();
  assert.ok(calls.includes('index:S'));
});
