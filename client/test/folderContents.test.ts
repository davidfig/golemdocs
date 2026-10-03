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

import { outermost } from '../src/folders.ts';

test('outermost leaves out what is inside another picked folder', () => {
  const f = (id: string, parentId: string | null): Folder => ({ id, name: id, parentId, createdAt: 0, updatedAt: 0 });
  const folders = [f('proj', null), f('sub', 'proj'), f('deep', 'sub'), f('other', null)];
  const doc = (key: string, folderId: string | null) => ({ key, local: { folderId: folderId ?? undefined } });
  const picked = { folders: [folders[0]!, folders[2]!, folders[3]!], items: [doc('a', 'deep'), doc('b', null), doc('c', 'other')] };
  const { folders: top, items } = outermost(folders, picked);
  assert.deepEqual(top.map((x) => x.id), ['proj', 'other']);
  assert.deepEqual(items.map((x) => x.key), ['b']);
});

test('canDrop allows a move somewhere else, never a folder into itself or its own subfolder', async () => {
  const { canDrop } = await import('../src/folderOps.ts');
  const f = (id: string, parentId: string | null): Folder => ({ id, name: id, parentId, createdAt: 0, updatedAt: 0 });
  const folders = [f('a', null), f('b', 'a'), f('c', null)];
  const doc = { key: 'd', local: { folderId: 'a' } } as never;
  assert.equal(canDrop(folders, { kind: 'doc', entry: doc }, 'a'), false, 'already there');
  assert.equal(canDrop(folders, { kind: 'doc', entry: doc }, 'c'), true);
  assert.equal(canDrop(folders, { kind: 'folder', folder: folders[0]! }, 'b'), false, 'inside itself');
  assert.equal(canDrop(folders, { kind: 'folder', folder: folders[0]! }, 'a'), false);
  assert.equal(canDrop(folders, { kind: 'folder', folder: folders[1]! }, null), true);
});

test('withMoved shows a move with new entries, leaving the ones it was given as they were', async () => {
  const { withMoved } = await import('../src/folderOps.ts');
  const entry = { key: 'd', name: 'D', folderId: 'a', local: { id: 'd', folderId: 'a' }, cloud: { id: 'c', folderId: 'a' } } as never as import('../src/sync.ts').LibraryEntry;
  const other = { key: 'e', name: 'E', folderId: null, local: null, cloud: null } as never as import('../src/sync.ts').LibraryEntry;
  const [moved, untouched] = withMoved([entry, other], [entry], null);
  assert.equal(moved!.folderId, null);
  assert.equal(moved!.cloud!.folderId, null);
  assert.equal('folderId' in moved!.local!, false);
  assert.equal(untouched, other);
  assert.equal(entry.local!.folderId, 'a', 'the original is unchanged');
});
