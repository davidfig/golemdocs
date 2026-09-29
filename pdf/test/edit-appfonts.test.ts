import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PdfDocument, applyEdits, cellsOf, findBlocks, scanPage, textOf, type ApplyOptions, type PdfEdit } from '../src/index.ts';
import { load } from './helpers.ts';

const FONTS = join(import.meta.dirname, '../../client/public/fonts');
const files: Record<string, string> = { 'Arial|00': 'arial/regular.ttf', 'Arial|10': 'arial/bold.ttf', 'Times New Roman|10': 'times-new-roman/bold.ttf', 'Calibri|00': 'calibri/regular.ttf' };
const options: ApplyOptions = {
  fontFile: (family, bold, italic) => {
    const path = files[`${family}|${bold ? 1 : 0}${italic ? 1 : 0}`];
    return path ? new Uint8Array(readFileSync(join(FONTS, path))) : undefined;
  },
};

const box = (text: string, font = 'Arial', extra: object = {}): PdfEdit => ({ id: 'b', page: 0, kind: 'textbox', box: [72, 700, 400, 730], text, font, size: 14, color: [0, 0, 0], ...extra });

test('a text box in an app font embeds that font (subset to what is used)', async () => {
  const doc = load('libreoffice.pdf');
  applyEdits(doc, [box('Hello Arial world')], options);
  const bytes = await doc.save();
  const back = PdfDocument.load(bytes);
  const item = back.pages[0].extractText().items.find((i) => i.text.includes('Hello Arial'))!;
  assert.ok(item, back.pages[0].extractText().text);
  assert.match(item.fontName, /Liberation ?Sans/i);
  // A subset, not the whole font (Liberation Sans is about 400 KB).
  assert.ok(bytes.length < 120_000, `${bytes.length} bytes`);
});

test('bold and a different family choose their own files', async () => {
  const doc = load('libreoffice.pdf');
  applyEdits(doc, [box('Bold serif', 'Times New Roman', { bold: true })], options);
  const back = PdfDocument.load(await doc.save());
  const item = back.pages[0].extractText().items.find((i) => i.text.includes('Bold serif'))!;
  assert.match(item.fontName, /LiberationSerif-Bold/);
});

test('with no file to hand, the nearest standard font is used', async () => {
  const doc = load('libreoffice.pdf');
  applyEdits(doc, [box('Nothing to embed', 'Georgia', { italic: true })], options);
  const back = PdfDocument.load(await doc.save());
  const item = back.pages[0].extractText().items.find((i) => i.text.includes('Nothing to embed'))!;
  assert.equal(item.fontName, 'Times-Italic');
});

test('a font with no file to hand is reported as substituted; embedded and standard ones are not', () => {
  const doc = load('libreoffice.pdf');
  const result = applyEdits(doc, [box('a', 'Georgia'), box('b', 'Arial'), box('c', 'Helvetica-Bold')], options);
  assert.deepEqual([...result.substituted], ['Georgia']);
});

test('applying again after more text was typed keeps the earlier glyphs\' widths and the text right', async () => {
  const doc = load('libreoffice.pdf');
  const text = () => doc.pages[0].extractText().text.replace(/\s+/g, ' ');
  applyEdits(doc, [box('Hello')], options);
  assert.ok(text().includes('Hello'), text());
  applyEdits(doc, [box('Hello world, and more')], options);
  assert.ok(text().includes('Hello world, and more'), text());
  // The glyphs are read back with real widths: the run is as wide as the font makes it, not a default 1000 per glyph.
  const item = doc.pages[0].extractText().items.find((i) => i.text.includes('Hello world'))!;
  const arial = (await import('../src/index.ts')).TrueTypeFont.parse(new Uint8Array(readFileSync(join(FONTS, 'arial/regular.ttf'))));
  let expected = 0;
  for (const ch of 'Hello world, and more') expected += arial.advance(arial.glyphForCodePoint(ch.codePointAt(0)!)) * arial.scale * 14 / 1000;
  assert.ok(Math.abs(item.width - expected) < 0.5, `${item.width} vs ${expected}`);
  // Taken back, the page is as it was.
  applyEdits(doc, [], options);
  assert.ok(!text().includes('Hello world'));
});

test('a block set in an app font, and a character the font lacks, still shows', async () => {
  const doc = load('chromium.pdf');
  const block = findBlocks(scanPage(doc.pages[0]).runs)[0];
  const edits: PdfEdit[] = [{ id: 't', page: 0, kind: 'text', runs: block.runs.map((r) => r.id), text: `${textOf(cellsOf(block))} ✓ Ω`, style: { font: 'Calibri', size: 12 } }];
  applyEdits(doc, edits, options);
  const back = PdfDocument.load(await doc.save());
  const text = back.pages[0].extractText();
  assert.ok(text.items.some((i) => /Carlito/i.test(i.fontName)), text.items.map((i) => i.fontName).join());
  assert.ok(text.text.includes('The quick'), text.text);
});
