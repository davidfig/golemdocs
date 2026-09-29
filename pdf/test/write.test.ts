import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PageDrawing, PdfDocument, PdfStream, TrueTypeFont, decodeStream, type PdfImage } from '../src/index.ts';
import { checkXrefTables, fixture, latin1 } from './helpers.ts';

const DEJAVU = () => fixture('DejaVuSans-subset.ttf');

test('drawing records the expected operators', () => {
  const doc = PdfDocument.create();
  const page = doc.addPage([600, 800]);
  const d = page.draw({ origin: 'top-left' });
  d.rect(10, 20, 100, 50, { fill: [1, 0, 0], stroke: { color: 0, width: 2, dash: [3, 1] } });
  d.line(0, 0, 100, 100, { color: [0, 0, 0, 1] });
  assert.deepEqual(
    d.operations.map((o) => o.op),
    ['q', 'rg', 'G', 'w', 'd', 're', 'B', 'Q', 'q', 'K', 'm', 'l', 'S', 'Q'],
  );
  // Top-left origin: the rectangle's bottom edge is at 800 - 20 - 50.
  assert.deepEqual(d.operations[5].operands, [10, 730, 100, 50]);
  assert.deepEqual(d.operations[10].operands, [0, 800]);
});

test('text with the standard fonts: measured and extracted back', async () => {
  const doc = PdfDocument.create();
  const page = doc.addPage();
  const helv = doc.standardFont('Helvetica');
  const times = doc.standardFont('TimesNewRoman,Bold'); // alias of Times-Bold
  assert.equal(PageDrawing.measure('Hello', { font: helv, size: 10 }), 22.78); // H722 e556 l222 l222 o556
  const d = page.draw();
  d.text('Hello — “world” €', 72, 700, { font: helv, size: 12, color: 0.2 });
  d.text('Bold', 72, 680, { font: times, size: 12, charSpacing: 1, wordSpacing: 2, horizontalScale: 90 });
  d.finish();
  const back = PdfDocument.load(await doc.save());
  const items = back.pages[0].extractText().items;
  assert.deepEqual(
    items.map((i) => [i.text, i.fontName]),
    [
      ['Hello — “world” €', 'Helvetica'],
      ['Bold', 'Times-Bold'],
    ],
  );
  assert.ok(Math.abs(items[1].width - PageDrawing.measure('Bold', { font: times, size: 12, charSpacing: 1, wordSpacing: 2, horizontalScale: 90 })) < 1e-6);
});

test('characters a standard font lacks become "?"', () => {
  const doc = PdfDocument.create();
  const helv = doc.standardFont('Helvetica');
  assert.equal(latin1(helv.encode('aΩb')), 'a?b');
  assert.equal(helv.hasChar(0x3a9), false);
});

test('an embedded TrueType font is subset to the glyphs used, composites included', async () => {
  const doc = PdfDocument.create();
  const font = doc.embedFont(DEJAVU());
  const text = 'Ελληνικά Кириллица ✓ fi';
  doc.addPage().draw().text(text, 72, 700, { font, size: 14 }).finish();
  const bytes = await doc.save();
  const back = PdfDocument.load(bytes);
  assert.equal(back.pages[0].extractText().text, text);

  const fontDict = back.dict(back.dict(back.pages[0].resources.get('Font'))!.get('F1'))!;
  assert.match(fontDict.name('BaseFont')!, /^[A-Z]{6}\+DejaVuSans$/);
  const cid = back.dict(back.array(fontDict.get('DescendantFonts'))![0])!;
  const program = back.streamData(back.dict(cid.get('FontDescriptor'))!.get('FontFile2'));
  const subset = TrueTypeFont.parse(program);
  const original = TrueTypeFont.parse(DEJAVU());
  const distinct = new Set([...text]).size;
  // .notdef + each distinct character + the base glyphs composites (Ε→E, ά→α+tonos, ...) refer to.
  assert.ok(subset.numGlyphs > distinct && subset.numGlyphs < distinct + 12, `${subset.numGlyphs} glyphs`);
  assert.ok(subset.numGlyphs < original.numGlyphs / 5);
});

test('saving again after drawing more rewrites the subset in place', async () => {
  const doc = PdfDocument.create();
  const font = doc.embedFont(DEJAVU());
  const page = doc.addPage();
  page.draw().text('abc', 72, 700, { font, size: 12 }).finish();
  const count = async () => {
    const bytes = await doc.save({ objectStreams: false });
    const text = latin1(bytes);
    return { bytes, objects: text.match(/\d+ 0 obj/g)!.length, programs: text.match(/\/Length1 /g)!.length };
  };
  const first = await count();
  page.draw().text('xyz', 72, 680, { font, size: 12 }).finish();
  const second = await count();
  assert.equal(second.programs, 1);
  // Only the new content: the drawing, plus q/Q streams wrapping the existing content.
  assert.equal(second.objects, first.objects + 3);
  assert.equal(PdfDocument.load(second.bytes).pages[0].extractText().text, 'abc\nxyz');
  assert.ok(checkXrefTables(second.bytes) > 0);
});

test('an OpenType (CFF) font is embedded whole', async () => {
  const doc = PdfDocument.create();
  const font = doc.embedFont(fixture('LMRoman10-subset.otf'));
  doc.addPage().draw().text('Latin Modern é', 72, 700, { font, size: 14 }).finish();
  const back = PdfDocument.load(await doc.save());
  assert.equal(back.pages[0].extractText().text, 'Latin Modern é');
  const cid = back.dict(back.array(back.dict(back.dict(back.pages[0].resources.get('Font'))!.get('F1'))!.get('DescendantFonts'))![0])!;
  assert.equal(cid.name('Subtype'), 'CIDFontType0');
  assert.ok(back.dict(cid.get('FontDescriptor'))!.has('FontFile3'));
});

test('textRun places glyphs at exactly the advances given', async () => {
  const doc = PdfDocument.create();
  const font = doc.embedFont(DEJAVU());
  const page = doc.addPage();
  // Layout's advances differ a little from the font's (tracking, justification, rounding).
  const tweaks = [0.7, -0.4, 1.25, 0];
  const glyphs = ['A', 'b', 'C', 'd'].map((text, i) => ({ text, advance: font.widthOf(text, 20) + tweaks[i] }));
  page.draw({ origin: 'top-left' }).textRun(glyphs, 100, 100, { font, size: 20 }).finish();
  const back = PdfDocument.load(await doc.save());
  const [item] = back.pages[0].extractText().items;
  assert.equal(item.text, 'AbCd');
  const total = glyphs.reduce((sum, g) => sum + g.advance, 0);
  assert.ok(Math.abs(item.width - total) < 1e-3, `width ${item.width}, wanted ${total}`);
  assert.equal(item.x, 100);
  assert.equal(item.y, 792 - 100);
  // Wide gaps (justified text) read back as word breaks.
  const d = doc.addPage().draw();
  d.textRun([{ text: 'one', advance: 60 }, { text: 'two' }], 0, 0, { font, size: 12 }).finish();
  const back2 = PdfDocument.load(await doc.save());
  assert.equal(back2.pages[1].extractText().text, 'one two');
});

test('text state does not leak between runs', () => {
  const doc = PdfDocument.create();
  const font = doc.standardFont('Courier');
  const d = doc.addPage().draw();
  d.text('a', 0, 0, { font, size: 10, color: [1, 0, 0], charSpacing: 5 });
  d.text('b', 0, 0, { font, size: 10 });
  const ops = d.operations.map((o) => o.op);
  assert.deepEqual(ops.slice(ops.lastIndexOf('q')), ['q', 'BT', 'Tf', 'Td', 'Tj', 'ET', 'Q']);
});

// --- images -------------------------------------------------------------------------------------

const W = 16;
const H = 12;
const rgbAt = (x: number, y: number) => [x * 16, y * 16, (x + y) * 8];
const alphaAt = (x: number, y: number) => x * 16 + y;

/** Embeds, saves, reloads, and returns the decoded image and soft mask samples. */
async function roundTrip(file: string): Promise<{ doc: PdfDocument; img: PdfStream; samples: Uint8Array; mask?: Uint8Array }> {
  const doc = PdfDocument.create();
  let image: PdfImage;
  if (file.startsWith('pixels')) {
    const data = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set([...rgbAt(x, y), alphaAt(x, y)], (y * W + x) * 4);
    image = doc.embedPixels({ width: W, height: H, channels: 4, data });
  } else image = doc.embedImage(fixture(file));
  assert.deepEqual([image.width, image.height], [W, H]);
  doc.addPage().draw().image(image, 0, 0, 160, 120).finish();
  const back = PdfDocument.load(await doc.save());
  const xobjects = back.dict(back.pages[0].resources.get('XObject'))!;
  const img = back.resolve(xobjects.get([...xobjects.keys()][0])) as PdfStream;
  const samples = decodeStream(img, (o) => back.resolve(o)).data;
  const smask = back.resolve(img.dict.get('SMask'));
  return { doc: back, img, samples, mask: smask instanceof PdfStream ? decodeStream(smask).data : undefined };
}

test('PNG and raw RGB(A) images keep their exact pixels', async () => {
  for (const file of ['img-rgb.png', 'img-rgb-interlaced.png', 'img-rgba.png', 'img-rgba-interlaced.png', 'pixels']) {
    const { img, samples, mask } = await roundTrip(file);
    assert.equal(img.dict.name('ColorSpace'), 'DeviceRGB', file);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        assert.deepEqual([...samples.subarray(i * 3, i * 3 + 3)], rgbAt(x, y), `${file} (${x}, ${y})`);
        if (file.includes('rgba') || file === 'pixels') assert.equal(mask?.[i], alphaAt(x, y), `${file} alpha`);
      }
    }
    if (!file.includes('rgba') && file !== 'pixels') assert.equal(mask, undefined);
  }
});

test('16-bit gray, 1-bit and palette PNGs', async () => {
  const gray = await roundTrip('img-gray16.png');
  assert.equal(gray.img.dict.number('BitsPerComponent'), 16);
  assert.equal((gray.samples[2 * (3 * W + 5)] << 8) | gray.samples[2 * (3 * W + 5) + 1], (5 * 16 + 3) * 257);

  const bits = await roundTrip('img-gray1.png');
  assert.equal(bits.img.dict.number('BitsPerComponent'), 1);
  assert.equal(bits.samples.length, 2 * H); // two bytes per 16-pixel row
  assert.equal(bits.samples[0], 0b01010101);

  const pal = await roundTrip('img-palette-trns.png');
  const cs = pal.doc.array(pal.img.dict.get('ColorSpace'))!;
  assert.equal(String(cs[0]), '/Indexed');
  assert.equal(pal.samples[5], 1); // x = 5 → palette index 1
  assert.deepEqual([pal.mask![0], pal.mask![4], pal.mask![8], pal.mask![12]], [0, 128, 255, 255]);
});

test('JPEGs are embedded as they are', async () => {
  for (const [file, cs] of [
    ['img-rgb.jpg', 'DeviceRGB'],
    ['img-gray.jpg', 'DeviceGray'],
    ['img-cmyk.jpg', 'DeviceCMYK'],
  ]) {
    const { img } = await roundTrip(file);
    assert.equal(img.dict.name('Filter'), 'DCTDecode', file);
    assert.equal(img.dict.name('ColorSpace'), cs, file);
    assert.deepEqual(img.data, fixture(file), `${file} bytes untouched`);
  }
});

// --- navigation ---------------------------------------------------------------------------------

test('links and outline', async () => {
  const doc = PdfDocument.create();
  const [a, b, c] = [doc.addPage(), doc.addPage(), doc.addPage()];
  a.addLink([0, 0, 100, 20], 'https://example.com/a path?q=1');
  a.addLink([0, 30, 100, 50], { page: c, top: 500 });
  doc.setOutline([
    { title: 'Chapter 1', target: { page: a }, open: true, children: [{ title: 'Section 1.1', target: { page: b, top: 300 } }] },
    { title: 'Chapter 2 — ünïcode', target: { page: c }, bold: true },
    { title: 'Website', target: 'https://example.com' },
  ]);
  const back = PdfDocument.load(await doc.save());
  assert.deepEqual(back.outline, [
    { title: 'Chapter 1', pageIndex: 0, children: [{ title: 'Section 1.1', pageIndex: 1, children: [] }] },
    { title: 'Chapter 2 — ünïcode', pageIndex: 2, children: [] },
    { title: 'Website', pageIndex: -1, uri: 'https://example.com', children: [] },
  ]);
  const [uri, internal] = back.pages[0].annotations;
  assert.equal(latin1((back.dict(uri.get('A'))!.get('URI') as { bytes: Uint8Array }).bytes), 'https://example.com/a%20path?q=1');
  assert.ok(back.pages[2].ref.equals(back.array(internal.get('Dest'))![0]));
});
