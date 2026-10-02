// The cached catalogue the Files panel lists from first (sync.ts) follows changes made to the account.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { addFoldersToCatalogue, moveDocsInCatalogue, updateFoldersInCatalogue } from '../src/sync.ts';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
});

const read = () => JSON.parse(store.get('wm.catalogue')!);
const folder = (id: string, parentId: string | null) => ({ id, name: id, parentId, createdAt: 0, updatedAt: 1 });

test('a moved folder is moved in the cached catalogue', () => {
  store.set('wm.catalogue', JSON.stringify({ user: 'u', cloud: [], shared: [], folders: [folder('a', null), folder('b', null)] }));
  updateFoldersInCatalogue([folder('a', 'b')]);
  assert.deepEqual(read().folders.map((f: { id: string; parentId: string | null }) => [f.id, f.parentId]), [['b', null], ['a', 'b']].reverse());
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
