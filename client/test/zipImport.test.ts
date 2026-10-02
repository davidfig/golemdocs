// Import ▸ ZIP (src/storage/zipImport.ts): which files are read, and where they are put.
// Run: node --test test/*.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeZip } from '@golemdocs/docx';
import type { Folder } from '../src/folders.ts';
import { importFiles, readZipFiles, type ImportTarget } from '../src/storage/zipImport.ts';
import { uniqueName } from '../src/storage/uniqueName.ts';

const enc = new TextEncoder();
const folder = (id: string, name: string, parentId: string | null = null): Folder => ({ id, name, parentId, createdAt: 0, updatedAt: 0 });

test('uniqueName adds a counter before the extension', () => {
  const taken = new Set(['a.txt', 'a (2).txt']);
  assert.equal(uniqueName('A.txt', taken), 'A (3).txt');
  assert.equal(uniqueName('b', taken), 'b');
  assert.equal(uniqueName('b', taken), 'b (2)');
});

test('reads documents with their folders, leaving out system files and types that do not open', async () => {
  const zip = await writeZip([
    { name: 'top.txt', data: enc.encode('t') },
    { name: 'Work/Reports/q1.md', data: enc.encode('# q1') },
    { name: '__MACOSX/Work/._q1.md', data: enc.encode('x') },
    { name: 'Work/.DS_Store', data: enc.encode('x') },
    { name: 'Work/tool.exe', data: enc.encode('x') },
    { name: 'Work/', data: new Uint8Array() },
  ]);
  const { files, skipped } = await readZipFiles(zip);
  assert.deepEqual(files.map((f) => [f.folders, f.name]), [[[], 'top.txt'], [['Work', 'Reports'], 'q1.md']]);
  assert.equal(skipped, 1);
  assert.equal(new TextDecoder().decode(files[1].bytes), '# q1');
});

function target(over: Partial<ImportTarget> = {}) {
  const made: Folder[] = [];
  const saved: { name: string; folderId: string | null }[] = [];
  const t: ImportTarget = {
    folders: [],
    documents: [],
    root: null,
    makeFolder: async (name, parentId) => {
      const f = folder(`new${made.length}`, name, parentId);
      made.push(f);
      return f;
    },
    save: async (name, _bytes, folderId) => {
      saved.push({ name, folderId });
      return true;
    },
    ...over,
  };
  return { t, made, saved };
}

const file = (path: string) => {
  const parts = path.split('/');
  return { folders: parts.slice(0, -1), name: parts.at(-1)!, bytes: new Uint8Array() };
};

test('makes the folders that are missing and reuses the ones that exist', async () => {
  const { t, made, saved } = target({ folders: [folder('w', 'work')] });
  const result = await importFiles([file('Work/a.txt'), file('Work/Reports/b.txt'), file('Reports/c.txt'), file('Work/Reports/d.txt')], t);
  assert.deepEqual(made.map((f) => [f.name, f.parentId]), [['Reports', 'w'], ['Reports', null]]);
  assert.deepEqual(saved, [
    { name: 'a.txt', folderId: 'w' },
    { name: 'b.txt', folderId: 'new0' },
    { name: 'c.txt', folderId: 'new1' },
    { name: 'd.txt', folderId: 'new0' },
  ]);
  assert.deepEqual(result, { imported: 4, skipped: 0, folders: 2 });
});

test('never takes a name that is in use in the same folder', async () => {
  const { t, saved } = target({ folders: [folder('w', 'Work')], documents: [{ name: 'a.txt', folderId: 'w' }, { name: 'a.txt', folderId: null }, { name: 'a (2).txt', folderId: null }] });
  await importFiles([file('Work/a.txt'), file('Work/a.txt'), file('a.txt'), file('Other/a.txt')], t);
  assert.deepEqual(saved.map((s) => s.name), ['a (2).txt', 'a (3).txt', 'a (3).txt', 'a.txt']);
});

test('the top level of the ZIP goes in the chosen folder', async () => {
  const { t, made, saved } = target({ root: 'r' });
  await importFiles([file('x.txt'), file('Sub/y.txt')], t);
  assert.deepEqual(saved[0], { name: 'x.txt', folderId: 'r' });
  assert.equal(made[0].parentId, 'r');
});

test('a document that cannot be saved is counted as skipped', async () => {
  const { t } = target({ save: async (name) => name !== 'bad.png' });
  assert.deepEqual(await importFiles([file('ok.txt'), file('bad.png')], t), { imported: 1, skipped: 1, folders: 0 });
});
