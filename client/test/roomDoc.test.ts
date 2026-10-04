import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WordDocument } from '@golemdocs/docx';
import { isWdoc } from '../src/formats/wdoc.ts';
import { isLayeredFormat, isPictureFormat, isVectorFormat, readRoomDocument, roomable, roomKind, writeRoomDocument } from '../src/formats/roomDoc.ts';
import { sourceFromFile } from '../src/formats/source.ts';

const docx = async (): Promise<Uint8Array> => (await WordDocument.create()).write();

test('plain Word with nothing beside it stays a plain .docx, as every room held before', async () => {
  const bytes = await docx();
  const written = await writeRoomDocument({ docx: bytes, lens: 'docx', origin: 'docx', extensions: {} });
  assert.equal(isWdoc(written), false);
  assert.deepEqual(written, bytes);
  assert.deepEqual(await readRoomDocument(written), { docx: bytes, lens: 'docx', origin: 'docx', extensions: {} });
});

test('a Markdown document goes into a room with what it is edited as and its front matter', async () => {
  const bytes = await docx();
  const written = await writeRoomDocument({ docx: bytes, lens: 'md', origin: 'md', extensions: { md: { frontMatter: 'title: Notes' } } });
  assert.equal(isWdoc(written), true);
  const read = await readRoomDocument(written);
  assert.equal(read.lens, 'md');
  assert.equal(read.origin, 'md');
  assert.deepEqual(read.extensions, { md: { frontMatter: 'title: Notes' } });
  assert.deepEqual(read.docx, bytes);
});

test('Word with extensions, or made from another format, is kept as that', async () => {
  const bytes = await docx();
  assert.equal(isWdoc(await writeRoomDocument({ docx: bytes, lens: 'docx', origin: 'rtf', extensions: {} })), true);
  assert.equal(isWdoc(await writeRoomDocument({ docx: bytes, lens: 'docx', origin: 'docx', extensions: { html: { head: '' } as never } })), true);
});

test('every kind of document can be in a room', () => {
  for (const format of ['png', 'jpeg', 'webp', 'docx', 'md', 'txt', 'html', 'odt', 'rtf', 'csv', 'tex', 'svg', 'svgz', 'pdf'] as const) assert.equal(roomable(format), true, format);
});

test('a picture’s changes are to the shapes drawn over it', () => {
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    assert.equal(roomKind(format), 'layers', format);
    assert.equal(isPictureFormat(format), true, format);
  }
  assert.equal(isPictureFormat('svg'), false);
});

test('a PDF’s changes are to its objects; those of everything else, to its text', () => {
  assert.equal(roomKind('pdf'), 'objects');
  for (const format of ['docx', 'md', 'txt'] as const) assert.equal(roomKind(format), 'doc', format);
});

test('nobody has to wait to edit: a drawing is shared node by node', () => {
  for (const format of ['svg', 'svgz'] as const) {
    assert.equal(roomKind(format), 'nodes', format);
    assert.equal(isVectorFormat(format), true, format);
    assert.equal(isLayeredFormat(format), true, format);
  }
  assert.equal(isLayeredFormat('png'), true);
  assert.equal(isLayeredFormat('docx'), false);
});

test('a plain Word file under another format’s name opens as Word, not as that format read from a ZIP', async () => {
  const bytes = await docx();
  const buffer = bytes.slice().buffer;
  assert.equal(sourceFromFile('Report.md', buffer)?.kind, 'docx');
  assert.equal(sourceFromFile('Report.docx', buffer)?.kind, 'docx');
  assert.equal(sourceFromFile('Report.md', new TextEncoder().encode('# Hello').buffer)?.kind, 'md');
});
