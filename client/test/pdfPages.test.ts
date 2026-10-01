// PDF pages as PageLayouts (src/formats/pdfPages.ts), with the shipped MSDF font metrics.
// Run: node --experimental-transform-types --test test/pdfPages.test.ts

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FontSet, packColor } from '@golemdocs/layout';
import { PageDrawing, PdfDocument } from '../../pdf/src/index.ts';
import { N, PdfDict, PdfStream, PdfString } from '../../pdf/src/core/objects.ts';
import { toUnicodeCMap } from '../../pdf/src/write/fonts.ts';
import { cjkLangOf, openPdfView } from '../src/formats/pdfPages.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'manifest.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : null;
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(import.meta.dirname, '../../pdf/test/fixtures', name)));

async function sample(): Promise<Uint8Array> {
  const doc = PdfDocument.create();
  const p1 = doc.addPage([300, 200]);
  const d = new PageDrawing(p1, { origin: 'top-left' });
  d.rect(10, 10, 100, 20, { fill: [0.9, 0.9, 0.5] });
  d.text('Hello, PDF', 20, 25, { font: doc.standardFont('Helvetica'), size: 12, color: [1, 0, 0] });
  d.text('Serif fi', 20, 60, { font: doc.standardFont('Times-Bold'), size: 14 });
  d.text('mono', 20, 90, { font: doc.standardFont('Courier'), size: 10 });
  d.line(10, 120, 210, 120, { color: 0, width: 2 });
  d.image(doc.embedImage(fixture('img-rgb.jpg')), 150, 20, 40, 30);
  d.image(doc.embedImage(fixture('img-rgba.png')), 200, 20, 32, 32);
  d.finish();
  doc.addPage([400, 500]);
  return doc.save();
}

test('layoutPage: size, glyphs at PDF positions, colors, rects and images', skip, async () => {
  const view = await openPdfView(await sample(), fonts!);
  assert.equal(view.pageCount, 2);
  const page = view.layoutPage(0);
  assert.equal(page.width, 300);
  assert.equal(page.height, 200);
  assert.equal(page.index, 0);
  assert.equal(page.number, 1);
  assert.equal(view.layoutPage(1).width, 400);

  // Helvetica text stands in as Arial, red, its first glyph at (20, 25).
  const lists = [...page.glyphs.values()];
  const arial = lists.find((l) => l.font.family.id.includes('arial') && !l.font.face.italic && l.font.face.weight < 600)!;
  assert.ok(arial, [...page.glyphs.keys()].join());
  const i = [...Array(arial.count).keys()].find((k) => arial.color(k) === packColor(0xff0000))!;
  assert.equal(arial.x(i), 20);
  assert.equal(arial.y(i), 25);
  assert.equal(arial.size(i), 12);
  // "Hello," has 6 glyphs, "PDF" 3 (the space draws nothing); Hello, PDF shares a face with "Hello".
  assert.equal(arial.count, 9);
  // Positions follow the PDF's Helvetica advances (H = 722, e = 556), not our face's.
  assert.ok(Math.abs(arial.x(i + 1) - (20 + (722 * 12) / 1000)) < 1e-3);
  assert.ok(Math.abs(arial.x(i + 2) - (20 + ((722 + 556) * 12) / 1000)) < 1e-3);

  // Times-Bold resolves to a bold serif face; Courier to the mono one.
  assert.ok(lists.some((l) => l.font.family.id.includes('times') && l.font.face.weight >= 600));
  assert.ok(lists.some((l) => l.font.family.id.includes('courier')));

  assert.equal(page.background.count + page.foreground.count, 2); // the fill and the 2pt line
  assert.deepEqual(page.background.rect(0), [10, 10, 100, 20]);
  assert.equal(page.background.color(0), packColor(0xe6e680));

  assert.equal(page.images.length, 2);
  assert.deepEqual([page.images[0].x, page.images[0].y, page.images[0].width, page.images[0].height], [150, 20, 40, 30]);
  assert.notEqual(page.images[0].part, page.images[1].part);
  const jpeg = await view.media(page.images[0].part);
  assert.deepEqual([...jpeg!.subarray(0, 2)], [0xff, 0xd8]);
  const png = await view.media(page.images[1].part);
  assert.deepEqual([...png!.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  assert.equal(await view.media('pdf-image:99'), null);

  // Fresh layouts each call, sharing image parts.
  const again = view.layoutPage(0);
  assert.notEqual(again, page);
  assert.equal(again.id === page.id, false);
  assert.equal(again.images[0].part, page.images[0].part);
  assert.throws(() => view.layoutPage(5), RangeError);
});

test('producer fixtures lay out with every character', skip, async () => {
  for (const name of ['libreoffice.pdf', 'chromium.pdf', 'reportlab.pdf', 'xelatex.pdf', 'matplotlib-type42.pdf']) {
    const view = await openPdfView(fixture(name), fonts!);
    const page = view.layoutPage(0);
    assert.ok(page.glyphCount > 40, `${name}: ${page.glyphCount}`);
  }
});

test('lazy: pages are not interpreted until asked for', skip, async () => {
  const doc = PdfDocument.create();
  for (let i = 0; i < 300; i++) doc.addPage([200, 200]).setContent(new TextEncoder().encode('0 g 0 0 10 10 re f'));
  const t = performance.now();
  const view = await openPdfView(await doc.save(), fonts!);
  assert.equal(view.pageCount, 300);
  assert.ok(performance.now() - t < 2000);
  assert.equal(view.layoutPage(299).background.count, 1);
});

test('East Asian text is drawn from the CJK pages of the font’s language', skip, async () => {
  // A Traditional Chinese font as Word writes it: a composite font whose /ToUnicode says what each code is.
  const text = '廖文彬出生於';
  const doc = PdfDocument.create();
  const page = doc.addPage([300, 200]);
  const toUnicode = doc.add(new PdfStream(new PdfDict(), toUnicodeCMap(new Map([...text].map((ch, i) => [i + 1, ch])))));
  const cidFont = new PdfDict({ Type: N('Font'), Subtype: N('CIDFontType2'), BaseFont: N('ABCDEF+MicrosoftJhengHeiRegular'), DW: 1000, CIDSystemInfo: new PdfDict({ Registry: new PdfString(new TextEncoder().encode('Adobe')), Ordering: new PdfString(new TextEncoder().encode('Identity')), Supplement: 0 }) });
  const font = doc.add(new PdfDict({ Type: N('Font'), Subtype: N('Type0'), BaseFont: N('ABCDEF+MicrosoftJhengHeiRegular'), Encoding: N('Identity-H'), DescendantFonts: [cidFont], ToUnicode: toUnicode }));
  const name = page.addResource('Font', font, 'F');
  const shown = Uint8Array.from([...text].flatMap((_, i) => [0, i + 1]));
  page.setContent([
    { op: 'BT', operands: [] },
    { op: 'Tf', operands: [N(name), 12] },
    { op: 'Td', operands: [20, 100] },
    { op: 'Tj', operands: [new PdfString(shown, true)] },
    { op: 'ET', operands: [] },
  ]);
  const view = await openPdfView(await doc.save(), fonts!);
  const laid = view.layoutPage(0);
  assert.equal(laid.glyphCount, text.length);
  const lists = [...laid.glyphs.values()].filter((l) => l.count);
  assert.ok(lists.every((l) => fonts!.pages('zh-Hant').includes(l.font.family) || fonts!.pages('zh-Hans').includes(l.font.family)), lists.map((l) => l.font.family.id).join());
  assert.ok(lists.some((l) => fonts!.pages('zh-Hant').includes(l.font.family)));
});

test('the CJK language of a PDF font: by its name as PDFs write it, else by its characters', () => {
  const fontSet = { defaultCjkLang: 'ja' } as FontSet;
  assert.equal(cjkLangOf(fontSet, 'MicrosoftJhengHeiUIRegular', []), 'zh-Hant');
  assert.equal(cjkLangOf(fontSet, 'DFHei-W5-WIN-BF', []), 'zh-Hant');
  assert.equal(cjkLangOf(fontSet, 'SimSun', []), 'zh-Hans');
  assert.equal(cjkLangOf(fontSet, 'MS-Mincho', []), 'ja');
  assert.equal(cjkLangOf(fontSet, 'MalgunGothic', []), 'ko');
  assert.equal(cjkLangOf(fontSet, 'Unknown', [0xac00]), 'ko');
  assert.equal(cjkLangOf(fontSet, 'Unknown', [0x3042]), 'ja');
  assert.equal(cjkLangOf({ defaultCjkLang: 'zh-Hans' } as FontSet, 'Unknown', [0x4e00]), 'zh-Hans');
});
