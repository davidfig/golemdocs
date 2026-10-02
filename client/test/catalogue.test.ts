import { beforeEach, expect, test } from 'vitest';
import { moveDocsInCatalogue, updateFoldersInCatalogue } from '../src/sync.ts';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
});

const read = () => JSON.parse(store.get('wm.catalogue')!);

test('a moved folder is moved in the cached catalogue', () => {
  store.set('wm.catalogue', JSON.stringify({ user: 'u', cloud: [], shared: [], folders: [{ id: 'a', name: 'A', parentId: null }, { id: 'b', name: 'B', parentId: null }] }));
  updateFoldersInCatalogue([{ id: 'a', name: 'A', parentId: 'b', createdAt: 0, updatedAt: 1 }]);
  expect(read().folders.map((f: { id: string; parentId: string | null }) => [f.id, f.parentId])).toEqual([['a', 'b'], ['b', null]]);
  expect(read().user).toBe('u');
});

test('moved documents are moved in the cached catalogue', () => {
  store.set('wm.catalogue', JSON.stringify({ user: 'u', cloud: [{ id: 'd1', folderId: null }, { id: 'd2', folderId: null }], shared: [], folders: [] }));
  moveDocsInCatalogue(['d1'], 'f');
  expect(read().cloud.map((d: { folderId: string | null }) => d.folderId)).toEqual(['f', null]);
});
