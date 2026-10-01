import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WordDocument, commentEnd, commentReference, commentStart, insertInlines, type Paragraph, type Run } from '@golemdocs/docx';
import { FontSet } from '@golemdocs/layout';
import { PdfDocument, isDict, isRef, readAnnotations, type PdfObject } from '@golemdocs/pdf';
import { documentToPdf } from '../src/formats/pdfExport.ts';
import { markupToDocument } from '../src/formats/pdfMarkup.ts';
import { pdfToDocument } from '../src/formats/pdfImport.ts';

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

test('comments export as notes and import back with replies and resolved state', skip, async () => {
  const doc = await WordDocument.create();
  const first = paragraph([run('Alpha beta gamma delta epsilon zeta eta theta iota kappa.')]);
  const second = paragraph([run('Second paragraph with a distinct remark to discuss here.')]);
  doc.body = [first, second];
  // Comment 0 (with reply 1) on words of the second paragraph; comment 2 on the first, resolved.
  insertInlines(second, 40, [commentEnd('0'), commentReference('0'), commentEnd('1'), commentReference('1')]);
  insertInlines(second, 7, [commentStart('0'), commentStart('1')]);
  insertInlines(first, 11, [commentEnd('2'), commentReference('2')]);
  insertInlines(first, 0, [commentStart('2')]);
  doc.comments = [
    { id: '0', author: 'Ada', date: '2026-01-02T03:04:05Z', paragraphs: ['Check this', 'second line'] },
    { id: '1', author: 'Bo', date: '2026-01-03T03:04:05Z', paragraphs: ['Agreed'], parentId: '0' },
    { id: '2', author: 'Cy', paragraphs: ['Fine'], resolved: true },
  ];
  const bytes = await documentToPdf(doc, fonts!);
  const pdf = PdfDocument.load(bytes);
  const annotations = readAnnotations(pdf);
  const contents = annotations.filter((a) => a.contents).map((a) => a.contents);
  assert.deepEqual(contents.sort(), ['Agreed', 'Check this\nsecond line', 'Fine']);
  const reply = annotations.find((a) => a.contents === 'Agreed')!;
  assert.equal(reply.replyTo, annotations.find((a) => a.contents.startsWith('Check'))!.id);
  assert.ok(annotations.some((a) => a.state === 'Completed' && !a.contents));

  const back = await pdfToDocument(bytes);
  markupToDocument(back, pdf, annotations);
  const byText = (t: string) => back.comments.find((c) => c.paragraphs.join('\n') === t)!;
  const check = byText('Check this\nsecond line');
  assert.equal(check.author, 'Ada');
  assert.equal(check.date, '2026-01-02T03:04:05Z');
  assert.equal(check.parentId, undefined);
  const agreed = byText('Agreed');
  assert.equal(agreed.parentId, check.id);
  assert.equal(agreed.date, '2026-01-03T03:04:05Z');
  assert.equal(byText('Fine').resolved, true);
  assert.equal(check.resolved, undefined);
  assert.equal(back.comments.length, 3);
});
