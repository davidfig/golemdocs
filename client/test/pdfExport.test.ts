import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WordDocument, type Paragraph, type Run } from '@word/docx';
import { FontSet } from '@word/layout';
import { PdfDocument, isDict, isRef, type PdfObject } from '@word/pdf';
import { documentToPdf } from '../src/formats/pdfExport.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'manifest.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : null;

const run = (text: string, properties: Run['properties'] = {}): Run => ({ kind: 'run', properties, content: [{ kind: 'text', text }], attrs: {} });
const paragraph = (children: Paragraph['children'], properties: Paragraph['properties'] = {}): Paragraph => ({ kind: 'paragraph', properties, children, attrs: {} });

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

test('text, styles and pagination survive a round trip', skip, async () => {
  const doc = await WordDocument.create();
  const texts = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}: the quick brown fox jumps over the lazy dog, (again) and again & again.`);
  doc.body = [
    paragraph([run('Bold, ', { bold: true }), run('italic, ', { italic: true }), run('red', { color: { val: 'FF0000' } }), run(' and mono', { fonts: { ascii: 'Courier New', hAnsi: 'Courier New' } })]),
    ...texts.map((t) => paragraph([run(t)])),
  ];
  const bytes = await documentToPdf(doc, fonts!);
  const back = PdfDocument.load(bytes);
  assert.ok(back.pageCount >= 2, `${back.pageCount} pages`);
  for (const page of back.pages) assert.deepEqual([page.mediaBox[2] - page.mediaBox[0], page.mediaBox[3] - page.mediaBox[1]], [612, 792]);

  const extracted = back.pages.map((p) => p.extractText().text).join('\n');
  const expected = ['Bold, italic, red and mono', ...texts].join(' ');
  assert.equal(norm(extracted), norm(expected));

  const names = new Set(back.pages[0].extractText().items.map((i) => i.fontName));
  assert.ok(names.has('Helvetica') || names.has('Helvetica-Bold'), [...names].join());
  assert.ok(names.has('Courier'), [...names].join());
  assert.ok(names.has('Helvetica-Oblique') || names.has('Helvetica-BoldOblique'), [...names].join());
});

test('glyphs land at their laid-out positions', skip, async () => {
  const doc = await WordDocument.create();
  doc.body = [paragraph([run('Hello world')])];
  const back = PdfDocument.load(await documentToPdf(doc, fonts!));
  const items = back.pages[0].extractText().items;
  assert.equal(norm(items.map((i) => i.text).join('')), 'Hello world');
  // Default margins: 1 inch left, and the first line sits below the top margin.
  assert.ok(Math.abs(items[0].x - 72) < 0.5, `x=${items[0].x}`);
  assert.ok(items[0].y < 792 - 72 && items[0].y > 792 - 120, `y=${items[0].y}`);
});

test('an empty document still yields one page', skip, async () => {
  const doc = await WordDocument.create();
  const back = PdfDocument.load(await documentToPdf(doc, fonts!));
  assert.equal(back.pageCount, 1);
});

test('images become image XObjects, and bad ones are skipped', skip, async () => {
  const doc = await WordDocument.create();
  const png = readFileSync(path.resolve(import.meta.dirname, '../../pdf/test/fixtures/img-rgb.png'));
  const part = doc.addImage(new Uint8Array(png), 'png');
  const bad = doc.addImage(new Uint8Array([1, 2, 3, 4]), 'png');
  const picture = (image: string): Run => ({
    kind: 'run',
    properties: {},
    attrs: {},
    content: [{ kind: 'drawing', inline: true, width: 914400, height: 914400, image }],
  });
  doc.body = [paragraph([run('Before '), picture(part), run(' after')]), paragraph([picture(bad), run('tail')])];
  const back = PdfDocument.load(await documentToPdf(doc, fonts!));
  const xobjects = back.pages[0].resources && back.dict(back.pages[0].resources.get('XObject'));
  assert.ok(xobjects, 'page has XObjects');
  let images = 0;
  for (const value of xobjects.entries.values() as Iterable<PdfObject>) {
    const obj = isRef(value) ? back.resolve(value) : value;
    const dict = isDict(obj) ? obj : (obj as { dict?: unknown }).dict;
    if (dict && (dict as { name(k: string): string | undefined }).name('Subtype') === 'Image') images++;
  }
  assert.equal(images, 1);
  assert.equal(norm(back.pages[0].extractText().text), 'Before after tail');
});
