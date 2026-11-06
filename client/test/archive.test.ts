// Download All (src/storage/archive.ts): unique names in the ZIP, and its contents.
// Run: node --test test/*.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WordDocument, ZipArchive } from '@golemdocs/docx';
import { toVaultFile } from '../src/desktop/vaultCodec.ts';
import { writeWdoc, WDOC_VERSION } from '../src/formats/wdoc.ts';
import { archiveFiles, archiveNames, zipDocuments } from '../src/storage/archive.ts';

const container = async () =>
  writeWdoc({ manifest: { version: WDOC_VERSION, lens: 'docx', origin: 'docx', pagesCurrent: false }, document: await (await WordDocument.create()).write(), original: null, extensions: {} });

test('a saved document goes in the ZIP as the file its name says, not the container', async () => {
  const { docs, kept } = await archiveFiles([{ name: 'Report.docx', bytes: await container() }], toVaultFile);
  assert.deepEqual(kept, []);
  assert.equal(docs[0].name, 'Report.docx');
  const zip = ZipArchive.read(docs[0].bytes as Uint8Array);
  assert.ok(zip.entries.has('word/document.xml'));
  assert.ok(!zip.entries.has('mimetype'));
});

test('a container that cannot be converted is kept, under a name that says what it is', async () => {
  const stored = await container();
  const { docs, kept } = await archiveFiles([{ name: 'Report.docx', bytes: stored, folders: ['Work'] }], () => Promise.reject(new Error('no')));
  assert.deepEqual(kept, ['Report.docx']);
  assert.deepEqual(docs, [{ name: 'Report.wdoc', bytes: stored, folders: ['Work'] }]);
});

test('a file stored as itself that cannot be converted goes as it is', async () => {
  const stored = new TextEncoder().encode('plain');
  const { docs, kept } = await archiveFiles([{ name: 'data.bin', bytes: stored }], async () => null);
  assert.deepEqual(kept, []);
  assert.deepEqual(docs, [{ name: 'data.bin', bytes: stored }]);
});

test('documents are converted one at a time: a conversion has a time limit from when it is asked for', async () => {
  let running = 0;
  let most = 0;
  const { docs } = await archiveFiles(
    ['a.txt', 'b.txt', 'c.txt'].map((name) => ({ name, bytes: new Uint8Array() })),
    async (stored) => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      return stored;
    },
  );
  assert.equal(most, 1);
  assert.deepEqual(docs.map((d) => d.name), ['a.txt', 'b.txt', 'c.txt']);
});

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

test('documents are stored inside their folders', async () => {
  assert.deepEqual(archiveNames(['a.txt', 'a.txt', 'a.txt', 'n'], [['Work', 'v1.0'], ['Work', 'v1.0'], undefined, ['x/y']]), ['Work/v1.0/a.txt', 'Work/v1.0/a (2).txt', 'a.txt', 'x_y/n']);
  const enc = new TextEncoder();
  const zip = await zipDocuments([{ name: 'a.txt', bytes: enc.encode('in'), folders: ['A', 'B'] }]);
  assert.deepEqual([...ZipArchive.read(zip).entries.keys()], ['A/B/a.txt']);
});
