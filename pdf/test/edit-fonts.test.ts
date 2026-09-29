import assert from 'node:assert/strict';
import { test } from 'node:test';
import { N, PdfDict, PdfStream, PdfString } from '../src/core/objects.ts';
import { matchStandard } from '../src/edit/fallback.ts';
import { TrueTypeFont } from '../src/fonts/truetype.ts';
import { describeFont } from '../src/render/fontinfo.ts';
import { TextFont } from '../src/text/font.ts';
import { toUnicodeCMap } from '../src/write/fonts.ts';
import { PdfDocument, applyEdits, cellsOf, findBlocks, scanPage, textOf, type TextEdit } from '../src/index.ts';
import { docText, fixture, load } from './helpers.ts';

const edit = (doc: PdfDocument, start: string, text: string): TextEdit => {
  const block = findBlocks(scanPage(doc.pages[0]).runs).find((b) => textOf(cellsOf(b)).startsWith(start));
  assert.ok(block, `no block starting ${start}`);
  return { id: 'e1', page: 0, kind: 'text', runs: block.runs.map((r) => r.id), text };
};

/** The BaseFont of every font the saved page's text is shown in. */
const fontsShown = (doc: PdfDocument): string[] => [...new Set(scanPage(doc.pages[0]).runs.map((r) => r.font.textFont.name.replace(/^[A-Z]{6}\+/, '')))];

/**
 * A page showing `text` in DejaVu Sans as a composite font whose program is embedded whole but
 * whose widths and /ToUnicode list only the glyphs shown: what a producer that embeds whole fonts writes.
 */
async function wholeFontPage(text: string): Promise<PdfDocument> {
  const bytes = fixture('DejaVuSans-subset.ttf');
  const ttf = TrueTypeFont.parse(bytes);
  const doc = PdfDocument.create();
  const page = doc.addPage([612, 792]);
  const gids = [...text].map((ch) => ttf.glyphForCodePoint(ch.codePointAt(0)!));
  const widths = [...new Set(gids)].flatMap((g) => [g, [Math.round(ttf.advance(g) * ttf.scale)]]);
  const descriptor = doc.add(new PdfDict({ Type: N('FontDescriptor'), FontName: N('DejaVuSans'), Flags: 32, FontBBox: [0, -200, 1000, 900], ItalicAngle: 0, Ascent: 900, Descent: -200, CapHeight: 729, XHeight: 547, StemV: 80, FontFile2: doc.add(new PdfStream(new PdfDict(), bytes)) }));
  const cidFont = doc.add(new PdfDict({ Type: N('Font'), Subtype: N('CIDFontType2'), BaseFont: N('DejaVuSans'), CIDSystemInfo: new PdfDict({ Registry: new PdfString(Uint8Array.from('Adobe', (c) => c.charCodeAt(0))), Ordering: new PdfString(Uint8Array.from('Identity', (c) => c.charCodeAt(0))), Supplement: 0 }), FontDescriptor: descriptor, W: widths, CIDToGIDMap: N('Identity') }));
  const toUnicode = doc.add(new PdfStream(new PdfDict(), toUnicodeCMap(new Map([...text].map((ch, i) => [gids[i], ch])))));
  const font = doc.add(new PdfDict({ Type: N('Font'), Subtype: N('Type0'), BaseFont: N('DejaVuSans'), Encoding: N('Identity-H'), DescendantFonts: [cidFont], ToUnicode: toUnicode }));
  const name = page.addResource('Font', font, 'F');
  const shown = Uint8Array.from(gids.flatMap((g) => [g >> 8, g & 255]));
  page.setContent([
    { op: 'BT', operands: [] },
    { op: 'Tf', operands: [N(name), 12] },
    { op: 'Td', operands: [72, 700] },
    { op: 'Tj', operands: [new PdfString(shown, true)] },
    { op: 'ET', operands: [] },
  ]);
  return PdfDocument.load(await doc.save());
}

test('a character the font dictionary lacks is shown from its own embedded program when that has it', async () => {
  const doc = await wholeFontPage('Hello');
  applyEdits(doc, [edit(doc, 'Hello', 'Hello World')]);
  const back = PdfDocument.load(await doc.save());
  assert.ok(docText(back).includes('Hello World'), docText(back));
  assert.deepEqual(fontsShown(back), ['DejaVuSans']);
});

test('the copy of a font that reaches more of its program is made once, however often edits are applied', async () => {
  const doc = await wholeFontPage('Hello');
  const copies = () => new Set(scanPage(doc.pages[0]).runs.map((r) => r.font.textFont.dict).filter((d) => d.get('ToUnicode') && !d.get('W')));
  const [one, two] = [edit(doc, 'Hello', 'Hello World'), edit(doc, 'Hello', 'Hello Wood')];
  applyEdits(doc, [one]);
  const first = copies();
  applyEdits(doc, [two]);
  assert.equal(first.size, 2);
  assert.deepEqual(copies(), first);
});

test('a character a subset lacks is taken from another subset of the same face', async () => {
  const doc = PdfDocument.create();
  const page = doc.addPage([612, 792]);
  const a = doc.embedFont(fixture('DejaVuSans-subset.ttf'));
  const b = doc.embedFont(fixture('DejaVuSans-subset.ttf'));
  const d = page.draw();
  d.text('Hello', 72, 700, { font: a, size: 12 });
  d.text('A Wizard', 72, 600, { font: b, size: 12 });
  d.finish();
  const saved = PdfDocument.load(await doc.save());
  applyEdits(saved, [edit(saved, 'Hello', 'Hello Wizard')]);
  const back = PdfDocument.load(await saved.save());
  assert.ok(docText(back).includes('Hello Wizard'), docText(back));
  assert.deepEqual(fontsShown(back), ['DejaVuSans']);
});

/** A simple font named `name` (flags `flags`) whose widths are `standard`'s times `factor`, with the given descriptor heights. */
function lookalike(doc: PdfDocument, name: string, flags: number, standard: string, factor: number, heights: Record<string, number>) {
  const std = doc.standardFont(standard);
  const widths: number[] = [];
  for (let code = 32; code <= 126; code++) widths.push(Math.round(std.widthOf(String.fromCharCode(code), 1000) * factor));
  const descriptor = new PdfDict({ Type: N('FontDescriptor'), FontName: N(name), Flags: flags, ItalicAngle: 0, ...heights });
  const dict = new PdfDict({ Type: N('Font'), Subtype: N('TrueType'), BaseFont: N(name), Encoding: N('WinAnsiEncoding'), FirstChar: 32, LastChar: 126, Widths: widths, FontDescriptor: descriptor });
  return matchStandard(doc, new TextFont(doc, dict), describeFont(doc, dict));
}

test('a standard font stands in at the font’s x-height and widths', () => {
  const doc = PdfDocument.create();
  // A serif font 10% narrower than Times, with an x-height 5% taller.
  const match = lookalike(doc, 'SomeSerif', 34, 'Times-Roman', 0.9, { XHeight: 450 * 1.05 });
  assert.equal(match.font, 'Times-Roman');
  assert.ok(Math.abs(match.size - 1.05) < 0.001, `size ${match.size}`);
  assert.ok(Math.abs(match.size * match.scale - 0.9) < 0.01, `width ${match.size * match.scale}`);
  // Without heights, only the width is matched.
  const plain = lookalike(doc, 'OtherSans', 32, 'Helvetica', 1.1, {});
  assert.deepEqual([plain.font, plain.size], ['Helvetica', 1]);
  assert.ok(Math.abs(plain.scale - 1.1) < 0.01);
});

test('widths, not the name, say whether a font is monospaced', () => {
  const doc = PdfDocument.create();
  assert.equal(lookalike(doc, 'PlainSans', 32, 'Courier', 1, {}).font, 'Courier');
  assert.equal(lookalike(doc, 'Courier-ish', 33, 'Helvetica', 1, {}).font, 'Helvetica');
  // A descriptor height far from any real font's is ignored.
  assert.equal(lookalike(doc, 'Broken', 32, 'Helvetica', 1, { XHeight: 90 }).size, 1);
});

test('a monospaced subset is stood in for by Courier', () => {
  const doc = load('libreoffice.pdf');
  const run = scanPage(doc.pages[0]).runs[0];
  assert.equal(matchStandard(doc, run.font.textFont, run.font.style).font, 'Courier');
});

test('a stand-in character is written at its own size and scaling', async () => {
  const doc = load('chromium.pdf');
  const start = 'The quick';
  applyEdits(doc, [edit(doc, start, 'The Qquick brown fox jumps over the lazy dog.')]);
  const runs = scanPage(doc.pages[0]).runs;
  const stand = runs.find((r) => !(r.font.textFont.name.includes('DejaVu')));
  assert.ok(stand, 'the subset has no Q, so a standard font stands in')
  const match = matchStandard(doc, runs.find((r) => r.font.textFont.name.includes('DejaVu'))!.font.textFont, runs[0].font.style);
  assert.equal(stand.font.textFont.name, match.font);
  assert.ok(Math.abs(stand.scale - match.scale) < 0.001, `scale ${stand.scale} vs ${match.scale}`);
});

test('a simple TrueType font embedded whole shows characters its /Widths left out', async () => {
  const bytes = fixture('DejaVuSans-subset.ttf');
  const ttf = TrueTypeFont.parse(bytes);
  const doc = PdfDocument.create();
  const page = doc.addPage([612, 792]);
  const widths = Array.from({ length: 95 }, (_, i) => ('Helo'.includes(String.fromCharCode(32 + i)) ? Math.round(ttf.advance(ttf.glyphForCodePoint(32 + i)) * ttf.scale) : 0));
  const descriptor = doc.add(new PdfDict({ Type: N('FontDescriptor'), FontName: N('DejaVuSans'), Flags: 32, FontBBox: [0, -200, 1000, 900], ItalicAngle: 0, Ascent: 900, Descent: -200, CapHeight: 729, StemV: 80, FontFile2: doc.add(new PdfStream(new PdfDict(), bytes)) }));
  const font = doc.add(new PdfDict({ Type: N('Font'), Subtype: N('TrueType'), BaseFont: N('DejaVuSans'), Encoding: N('WinAnsiEncoding'), FirstChar: 32, LastChar: 126, Widths: widths, FontDescriptor: descriptor }));
  const name = page.addResource('Font', font, 'F');
  page.setContent([
    { op: 'BT', operands: [] },
    { op: 'Tf', operands: [N(name), 12] },
    { op: 'Td', operands: [72, 700] },
    { op: 'Tj', operands: [new PdfString(Uint8Array.from('Hello', (c) => c.charCodeAt(0)))] },
    { op: 'ET', operands: [] },
  ]);
  const saved = PdfDocument.load(await doc.save());
  applyEdits(saved, [edit(saved, 'Hello', 'Hello there')]);
  const back = PdfDocument.load(await saved.save());
  assert.ok(docText(back).includes('Hello there'), docText(back));
  assert.deepEqual(fontsShown(back), ['DejaVuSans']);
});

test('a subset font doesn’t claim the characters it left out', () => {
  const doc = PdfDocument.create();
  // Widths only for the codes shown; others missing or 0, with a MissingWidth that would give them one.
  const widths = Array.from({ length: 95 }, (_, i) => (' Hel'.includes(String.fromCharCode(32 + i)) ? 500 : 0));
  const descriptor = new PdfDict({ Type: N('FontDescriptor'), FontName: N('Subset'), Flags: 32, MissingWidth: 500 });
  const dict = new PdfDict({ Type: N('Font'), Subtype: N('TrueType'), BaseFont: N('ABCDEF+Subset'), Encoding: N('WinAnsiEncoding'), FirstChar: 32, LastChar: 126, Widths: widths, FontDescriptor: descriptor });
  const have = [...new TextFont(doc, dict).characters.keys()].sort().join('');
  assert.equal(have, ' Hel');
});
