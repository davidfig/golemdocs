// Pictures opened as documents (src/formats/imageDoc.ts, handlers/image.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WordDocument } from '@golemdocs/docx';
import type { Drawing, Paragraph } from '@golemdocs/docx';
import { png as pngHandler } from '../src/formats/handlers/image.ts';
import { exportDocument, importDocument, conversionIsLossy } from '../src/formats/convert.ts';
import { firstPicture, imageToDocument, pageSizeFor } from '../src/formats/imageDoc.ts';
import { sniffImage } from '../src/formats/images.ts';
import { readWdoc, writeWdoc } from '../src/formats/wdoc.ts';
import { pngBytes, jpegBytes } from './pictures.ts';

const fonts = undefined as never;

test('a picture is a page exactly its size, in twips at 96 dpi', () => {
  assert.deepEqual(pageSizeFor(400, 300), { w: 6000, h: 4500 });
  // Larger than Word's biggest page: shrunk, keeping the shape.
  const big = pageSizeFor(6000, 3000);
  assert.equal(big.w, 31680);
  assert.equal(big.h, 15840);
  // Tiny pictures are shown an inch across at least.
  assert.equal(pageSizeFor(16, 16).w, 1440);
});

test('opening a picture makes a one-page document holding it, with no margins', async () => {
  const bytes = pngBytes(400, 300, 90);
  const { document } = await importDocument('png', bytes);
  assert.deepEqual(document.section.pageSize, { w: 6000, h: 4500 });
  assert.deepEqual([document.section.margins?.left, document.section.margins?.top], [0, 0]);
  const picture = await firstPicture(document);
  assert.deepEqual([...picture!.image.bytes], [...bytes]);
  const drawing = ((document.body[0] as Paragraph).children[0] as { content: Drawing[] }).content[0];
  assert.equal(drawing.inline, false);
  assert.equal(drawing.width, 6000 * 635);
});

test('the picture comes back out as the same bytes, and survives a Word file and a .wdoc', async () => {
  const bytes = pngBytes(120, 80, 30);
  const doc = await imageToDocument(sniffImage(bytes)!);
  assert.deepEqual([...(await pngHandler.write(doc, {}, fonts))], [...bytes]);
  const reread = await WordDocument.read(await doc.write());
  assert.deepEqual(reread.section.pageSize, { w: 1800, h: 1200 });
  assert.deepEqual([...(await firstPicture(reread))!.image.bytes], [...bytes]);
  const wdoc = await readWdoc(await writeWdoc({ manifest: { version: 1, lens: 'png', origin: 'png', pagesCurrent: false }, document: await doc.write(), original: null, extensions: {} }));
  assert.equal(wdoc.manifest.lens, 'png');
});

test('a JPEG keeps its own bytes when saved as JPEG, and reads with its size', async () => {
  const bytes = jpegBytes(64, 48);
  const { document } = await importDocument('jpeg', bytes);
  assert.deepEqual(document.section.pageSize, { w: 1440, h: 1080 });
  assert.deepEqual([...(await exportDocument(document, {}, 'jpeg', fonts))], [...bytes]);
});

test('a document with no picture cannot be saved as one; non-pictures are refused', async () => {
  const empty = await WordDocument.create();
  await assert.rejects(() => exportDocument(empty, {}, 'png', fonts), Error);
  await assert.rejects(() => importDocument('png', new TextEncoder().encode('not a picture')), Error);
});

test('converting a picture to Word or PDF loses nothing; to JPEG or WebP it compresses', () => {
  assert.equal(conversionIsLossy('png', 'docx'), false);
  assert.equal(conversionIsLossy('png', 'pdf'), false);
  assert.equal(conversionIsLossy('jpeg', 'png'), false);
  assert.equal(conversionIsLossy('png', 'jpeg'), true);
  assert.equal(conversionIsLossy('png', 'webp'), true);
});

test('a JPEG turned by its rotation tag is sized as displayed', () => {
  // Exif orientation 6 (a quarter turn): 64 wide by 48 high as stored, shown 48 by 64.
  const jpeg = jpegBytes(64, 48, 6);
  const image = sniffImage(jpeg)!;
  assert.deepEqual([image.width, image.height], [48, 64]);
});
