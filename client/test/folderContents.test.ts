import assert from 'node:assert/strict';
import { test } from 'node:test';
import { folderContents, type Folder } from '../src/folders.ts';

const folder = (id: string, parentId: string | null): Folder => ({ id, name: id, parentId, createdAt: 0, updatedAt: 0 });

test('folderContents lists a folder, its subfolders deepest first, and every document inside', () => {
  const folders = [folder('a', null), folder('b', 'a'), folder('c', 'b'), folder('other', null)];
  const items = [{ n: 1, local: { folderId: 'a' } }, { n: 2, local: { folderId: 'c' } }, { n: 3, local: { folderId: 'other' } }, { n: 4, local: null }];
  const inside = folderContents(folders, items, folders[0]);
  assert.deepEqual(inside.folders.map((f) => f.id), ['c', 'b', 'a']);
  assert.deepEqual(inside.items.map((i) => i.n), [1, 2]);
});

import { deletionList } from '../src/folders.ts';

test('deletionList names everything a deletion removes, once, with paths from the deleted folder', () => {
  const folders = [folder('A', null), folder('B', 'A')];
  const inA = { name: 'x.txt', local: { folderId: 'A' } };
  const inB = { name: 'y.txt', local: { folderId: 'B' } };
  const alone = { name: 'z.txt', local: null };
  const items = [inA, inB, alone];
  assert.deepEqual(deletionList(folders, items, [folders[0], folders[1]], [inB, alone]), ['A/', 'A/B/', 'A/B/y.txt', 'A/x.txt', 'z.txt']);
  assert.deepEqual(deletionList(folders, items, [], [alone]), ['z.txt']);
});
