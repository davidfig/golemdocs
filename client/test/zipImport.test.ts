// Import ▸ ZIP (src/storage/zipImport.ts): which files are read, and where they are put.
// Run: node --test test/*.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeZip } from '@golemdocs/docx';
import type { Folder } from '../src/folders.ts';
import { importFiles, readZipFiles, sameBytes, type DuplicateChoice, type ImportTarget } from '../src/storage/zipImport.ts';
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

test('a GIF, BMP or SVG is read under the PNG name it is kept as, so it can not take the name of a PNG beside it', async () => {
  const zip = await writeZip([
    { name: 'logo.png', data: enc.encode('p') },
    { name: 'logo.svg', data: enc.encode('<svg/>') },
  ]);
  const { files } = await readZipFiles(zip);
  assert.deepEqual(files.map((f) => f.name), ['logo.png', 'logo.png']);
  const { t, saved } = target();
  await importFiles(files, t);
  assert.deepEqual(saved.map((s) => s.name), ['logo.png', 'logo (2).png']);
});

test('a file in the ZIP that cannot be read is skipped, not the reason the rest are not imported', async () => {
  const zip = await writeZip([
    { name: 'good.txt', data: enc.encode('g') },
    { name: 'locked.txt', data: enc.encode('l'), compress: false },
  ]);
  // Mark the second entry as encrypted, in its central directory record (flags are 8 bytes in).
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let central = -1;
  for (let i = zip.length - 4; i >= 0; i--) if (view.getUint32(i, true) === 0x02014b50 && new TextDecoder().decode(zip.subarray(i + 46, i + 46 + 10)) === 'locked.txt') central = i;
  view.setUint16(central + 8, view.getUint16(central + 8, true) | 1, true);
  const { files, skipped } = await readZipFiles(zip);
  assert.deepEqual(files.map((f) => f.name), ['good.txt']);
  assert.equal(skipped, 1);
});

test('names not marked as UTF-8 that are not UTF-8 are read as code page 437, as Windows writes them', async () => {
  const zip = await writeZip([{ name: 'R?sum?.txt', data: enc.encode('r') }]);
  // é in code page 437 is 0x82; clear the UTF-8 flag in the central directory.
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let i = zip.length - 4; i >= 0; i--) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    view.setUint16(i + 8, view.getUint16(i + 8, true) & ~(1 << 11), true);
    zip[i + 46 + 1] = 0x82;
    zip[i + 46 + 5] = 0x82;
  }
  assert.deepEqual((await readZipFiles(zip)).files.map((f) => f.name), ['R\u00e9sum\u00e9.txt']);
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
  assert.deepEqual(result, { imported: 4, replaced: 0, unchanged: 0, skipped: 0, folders: 2, cancelled: false });
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
  assert.deepEqual(await importFiles([file('ok.txt'), file('bad.png')], t), { imported: 1, replaced: 0, unchanged: 0, skipped: 1, folders: 0, cancelled: false });
});

test('importing reports progress and stops when aborted, keeping what was saved', async () => {
  const abort = new AbortController();
  const seen: number[] = [];
  const saved: string[] = [];
  const files = ['a.txt', 'b.txt', 'c.txt'].map((name) => ({ folders: [], name, bytes: enc.encode(name) }));
  const result = await importFiles(files, {
    folders: [],
    documents: [],
    root: null,
    signal: abort.signal,
    onProgress: (done, total) => seen.push(done / total),
    makeFolder: async () => folder('x', 'x'),
    async save(name) {
      saved.push(name);
      if (saved.length === 2) abort.abort();
      return true;
    },
  });
  assert.deepEqual(saved, ['a.txt', 'b.txt']);
  assert.equal(result.imported, 2);
  assert.equal(result.cancelled, true);
  assert.deepEqual(seen, [0, 1 / 3]);
});

test('reading a ZIP rejects when aborted', async () => {
  const zip = await writeZip([{ name: 'a.txt', data: enc.encode('a') }]);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(readZipFiles(zip, { signal: abort.signal }), { name: 'AbortError' });
});

const dup = (over: Partial<ImportTarget> = {}) => {
  const replaced: string[] = [];
  const asked: string[] = [];
  const base = target({
    documents: [{ id: 'd1', name: 'a.txt', folderId: null }, { id: 'd2', name: 'b.txt', folderId: null }, { id: 'd3', name: 'c.txt', folderId: null }],
    replace: async (id) => {
      replaced.push(id);
      return true;
    },
    ...over,
  });
  return { ...base, replaced, asked };
};

test('a file identical to the document there is left alone, without asking', async () => {
  const { t, saved, asked } = dup({ same: async (id) => id === 'd1', ask: async () => 'cancel' });
  const result = await importFiles([file('a.txt')], t);
  assert.deepEqual(saved, []);
  assert.deepEqual([result.unchanged, result.imported, result.cancelled], [1, 0, false]);
  assert.deepEqual(asked, []);
});

test('each duplicate is asked about, and overwrite, keep both and skip do what they say', async () => {
  const answers: DuplicateChoice[] = [{ action: 'overwrite', all: false }, { action: 'rename', all: false }, { action: 'skip', all: false }];
  const asked: string[] = [];
  const { t, saved, replaced } = dup({
    ask: async (d) => {
      asked.push(d.name);
      return answers.shift()!;
    },
  });
  const result = await importFiles([file('a.txt'), file('b.txt'), file('c.txt'), file('new.txt')], t);
  assert.deepEqual(asked, ['a.txt', 'b.txt', 'c.txt']);
  assert.deepEqual(replaced, ['d1']);
  assert.deepEqual(saved.map((s) => s.name), ['b (2).txt', 'new.txt']);
  assert.deepEqual([result.imported, result.replaced, result.unchanged], [3, 1, 1]);
});

test('"all" answers for the rest of the files', async () => {
  let asks = 0;
  const { t, replaced } = dup({
    ask: async () => {
      asks++;
      return { action: 'overwrite', all: true };
    },
  });
  await importFiles([file('a.txt'), file('b.txt'), file('c.txt')], t);
  assert.equal(asks, 1);
  assert.deepEqual(replaced, ['d1', 'd2', 'd3']);
});

test('dismissing the dialog stops the import', async () => {
  const { t, saved } = dup({ ask: async () => 'cancel' });
  const result = await importFiles([file('new.txt'), file('a.txt'), file('later.txt')], t);
  assert.equal(result.cancelled, true);
  assert.deepEqual(saved.map((s) => s.name), ['new.txt']);
});

test('without a way to ask, both are kept; a second copy in the same import is only renamed', async () => {
  const { t, saved } = dup({ ask: undefined });
  await importFiles([file('a.txt'), file('a.txt')], t);
  assert.deepEqual(saved.map((s) => s.name), ['a (2).txt', 'a (3).txt']);
});

test('sameBytes compares contents', () => {
  assert.equal(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]).buffer), true);
  assert.equal(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
  assert.equal(sameBytes(new Uint8Array([1]), new Uint8Array([1, 1])), false);
});
