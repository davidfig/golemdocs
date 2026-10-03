// The library store (src/libraryStore.ts): one copy every view reads, kept in step by one listing,
// and a change shown before it is saved never undone by a listing asked for before it.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { fakeIndexedDB } from './fakeIndexedDB.ts';

(globalThis as { indexedDB: unknown }).indexedDB = fakeIndexedDB();
const local = await import('../src/storage/local.ts');
const { LibraryStore } = await import('../src/libraryStore.ts');

const user = { id: 'u1', email: 'u@example.com', name: 'U' } as never;
const doc = (id: string, folderId: string | null = null) => ({ id, name: `${id}.docx`, size: 1, createdAt: 1, updatedAt: 1, thumbAt: null, folderId });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

let cloud: ReturnType<typeof doc>[];
let listings: number;
let hold: Promise<void> | null;

beforeEach(async () => {
  for (const d of await local.listSaved()) await local.deleteSaved(d.id);
  cloud = [doc('c1'), doc('c2', 'f')];
  listings = 0;
  hold = null;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url === '/api/documents') {
      listings++;
      const answer = cloud.slice();
      if (hold) await hold;
      return json(answer);
    }
    if (url === '/api/folders') return json([{ id: 'f', name: 'F', parentId: null, createdAt: 1, updatedAt: 1 }]);
    if (url === '/api/shared') return json([]);
    return json({ error: 'not found' }, 404);
  }) as typeof fetch;
});

const store = () => new LibraryStore({ account: () => user, signedIn: () => user });

test('one listing serves every view: each is told, and reads the same documents and folders', async () => {
  const library = store();
  let told = 0;
  library.subscribe(() => told++);
  library.subscribe(() => told++);
  await library.refresh();
  assert.equal(listings, 1);
  assert.ok(told >= 2);
  assert.deepEqual(library.entries.map((e) => e.key).sort(), ['c1', 'c2']);
  assert.deepEqual(library.cloud.map((d) => d.id).sort(), ['c1', 'c2']);
  assert.deepEqual(library.folders.map((f) => f.id), ['f']);
});

test('a change shown before it is saved is not undone by a listing asked for before it', async () => {
  const library = store();
  await library.refresh();
  let release!: () => void;
  hold = new Promise((resolve) => (release = resolve));
  const listing = library.refresh(); // asked for before the move
  await new Promise((resolve) => setTimeout(resolve, 0));
  const moved = library.entries.map((e) => (e.key === 'c1' ? { ...e, folderId: 'f', cloud: { ...e.cloud!, folderId: 'f' } } : e));
  library.update({ entries: moved });
  release();
  await listing;
  assert.equal(library.entries.find((e) => e.key === 'c1')!.folderId, 'f');
});

test('a copy saved here and a document uploaded show at once, without listing again', async () => {
  const library = store();
  await library.refresh();
  const saved = await local.saveSaved({ name: 'New.docx', bytes: new Uint8Array([1]), owner: 'u1' });
  library.putLocal(saved);
  assert.ok(library.local.some((l) => l.id === saved.id));
  library.putCloud(doc('c3'));
  assert.ok(library.cloud.some((d) => d.id === 'c3'));
  assert.equal(listings, 1);
});

test('unreachable, the account\'s documents as last listed still show', async () => {
  const library = store();
  await library.refresh();
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  let heard: { signedOut: boolean; offline: boolean } | null = null;
  const offline = new LibraryStore({ account: () => user, signedIn: () => user, listed: (r) => (heard = r) });
  await offline.refresh();
  assert.deepEqual(heard, { signedOut: false, offline: true });
  await library.refresh();
  assert.deepEqual(library.cloud.map((d) => d.id).sort(), ['c1', 'c2']);
  assert.ok(library.problem);
});
