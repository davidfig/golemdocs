// The cached catalogue the Files panel lists from first (sync.ts) follows changes made to the account.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { addFoldersToCatalogue, forgetCatalogue, forgetInCatalogue, forgetSharedInCatalogue, loadLibrary, moveDocsInCatalogue, putDocInCatalogue, updateFoldersInCatalogue } from '../src/sync.ts';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

const read = () => JSON.parse(store.get('wm.catalogue')!);
const folder = (id: string, parentId: string | null) => ({ id, name: id, parentId, createdAt: 0, updatedAt: 1 });

test('a moved folder is moved in the cached catalogue', () => {
  store.set('wm.catalogue', JSON.stringify({ user: 'u', cloud: [], shared: [], folders: [folder('a', null), folder('b', null)] }));
  updateFoldersInCatalogue([folder('a', 'b')]);
  assert.deepEqual(read().folders.map((f: { id: string; parentId: string | null }) => [f.id, f.parentId]), [['a', 'b'], ['b', null]]);
  assert.equal(read().user, 'u');
});

test('a new folder is added to the cached catalogue', () => {
  store.set('wm.catalogue', JSON.stringify({ user: 'u', cloud: [], shared: [], folders: [folder('a', null)] }));
  addFoldersToCatalogue([folder('b', 'a')]);
  assert.deepEqual(read().folders.map((f: { id: string }) => f.id), ['a', 'b']);
});

test('moved documents are moved in the cached catalogue', () => {
  store.set('wm.catalogue', JSON.stringify({ user: 'u', cloud: [{ id: 'd1', folderId: null }, { id: 'd2', folderId: null }], shared: [], folders: [] }));
  moveDocsInCatalogue(['d1'], 'f');
  assert.deepEqual(read().cloud.map((d: { folderId: string | null }) => d.folderId), ['f', null]);
});

test('deleting a folder takes the documents in it out of the cached catalogue, named or not', () => {
  store.set('wm.catalogue', JSON.stringify({ user: 'u', cloud: [{ id: 'd1', folderId: 'f' }, { id: 'd2', folderId: null }, { id: 'd3', folderId: 'g' }], shared: [], folders: [folder('f', null), folder('g', null)] }));
  forgetInCatalogue({ id: 'u' } as never, [], ['f']);
  assert.deepEqual(read().cloud.map((d: { id: string }) => d.id), ['d2', 'd3']);
  assert.deepEqual(read().folders.map((f: { id: string }) => f.id), ['g']);
});

test('signing out forgets the cached catalogue', () => {
  store.set('wm.catalogue', JSON.stringify({ user: 'u', cloud: [{ id: 'd1', folderId: null }], shared: [], folders: [folder('f', null)] }));
  forgetCatalogue();
  assert.equal(store.has('wm.catalogue'), false);
});

test('a document saved to the account is updated in the cached catalogue, or added if it is new there', () => {
  store.set('wm.catalogue', JSON.stringify({ user: 'u', cloud: [{ id: 'd1', name: 'Old', folderId: null }], shared: [{ id: 's1', name: 'Theirs', role: 'editor' }], folders: [] }));
  putDocInCatalogue({ id: 'd1', name: 'New' } as never);
  putDocInCatalogue({ id: 'd2', name: 'First upload' } as never);
  putDocInCatalogue({ id: 's1', name: 'Theirs', role: 'editor' } as never);
  assert.deepEqual(read().cloud.map((d: { id: string; name: string }) => [d.id, d.name]), [['d2', 'First upload'], ['d1', 'New']]);
  assert.equal(read().shared.length, 1);
  forgetSharedInCatalogue('s1');
  assert.equal(read().shared.length, 0);
});

test('a listing asked for before a move, answering after it, does not write the old place back', async () => {
  store.set('wm.catalogue', JSON.stringify({ user: 'u', cloud: [{ id: 'd1', folderId: null }], shared: [], folders: [folder('f', null)] }));
  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url === '/api/documents') {
      moveDocsInCatalogue(['d1'], 'f'); // moved while the listing was on its way
      return json([{ id: 'd1', name: 'd1.docx', size: 1, createdAt: 1, updatedAt: 1, thumbAt: null, folderId: null }]);
    }
    if (url === '/api/folders') return json([folder('f', null)]);
    return json([]);
  }) as typeof fetch;
  await loadLibrary({ id: 'u' } as never);
  assert.equal(read().cloud[0].folderId, 'f');
});
