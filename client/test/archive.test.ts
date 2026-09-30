// Download All (src/storage/archive.ts): unique names in the ZIP, and its contents.
// Run: node --test test/*.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZipArchive } from '@word/docx';
import { archiveNames, zipDocuments } from '../src/storage/archive.ts';

test('colliding names get a counter before the extension', () => {
  assert.deepEqual(archiveNames(['a.docx', 'b.docx', 'a.docx', 'A.docx', 'notes']), ['a.docx', 'b.docx', 'a (2).docx', 'A (3).docx', 'notes']);
  assert.deepEqual(archiveNames(['n', 'n']), ['n', 'n (2)']);
});

test('the archive holds every document', async () => {
  const enc = new TextEncoder();
  const zip = await zipDocuments([
    { name: 'one.txt', bytes: enc.encode('first') },
    { name: 'one.txt', bytes: enc.encode('second').buffer },
    { name: 'two.docx', bytes: enc.encode('third') },
  ]);
  const read = ZipArchive.read(zip);
  assert.deepEqual([...read.entries.keys()], ['one.txt', 'one (2).txt', 'two.docx']);
  assert.equal(await read.entries.get('one.txt')!.text(), 'first');
  assert.equal(await read.entries.get('one (2).txt')!.text(), 'second');
  assert.equal(await read.entries.get('two.docx')!.text(), 'third');
});
