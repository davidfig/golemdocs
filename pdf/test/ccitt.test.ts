// CCITT fax images (Group 3 and Group 4): decoded against what libtiff made of the same pictures.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { N, PdfDict, PdfDocument, PdfStream, imageBytes, interpretPage } from '../src/index.ts';
import { ccittDecode } from '../src/filters/ccitt.ts';
import { fixture } from './helpers.ts';

// The pictures are 200 x 60 (bytes of 1 = white). Their data was written by libtiff (through Pillow).
const CASES: [string, number, string][] = [
  ['Group 4', -1, 'ccitt-g4'],
  ['Group 3, one-dimensional', 0, 'ccitt-g3'],
  ['Group 3, two-dimensional', 4, 'ccitt-g3-2d'],
];

for (const [name, k, file] of CASES) {
  test(`${name} data decodes to the picture`, () => {
    const out = ccittDecode(fixture(`${file}.bin`), { k, columns: 200, rows: 60, byteAlign: false, blackIs1: false });
    assert.deepEqual(out, fixture(`${file}.pixels`));
    // BlackIs1 is the same picture the other way round.
    const inverted = ccittDecode(fixture(`${file}.bin`), { k, columns: 200, rows: 60, byteAlign: false, blackIs1: true });
    assert.deepEqual(inverted, fixture(`${file}.pixels`).map((b) => b ^ 0xff));
  });
}

test('damaged data leaves the rest of the picture white', () => {
  const data = fixture('ccitt-g4.bin');
  const out = ccittDecode(data.subarray(0, 100), { k: -1, columns: 200, rows: 60, byteAlign: false, blackIs1: false });
  assert.equal(out.length, 25 * 60);
  assert.deepEqual(out.subarray(25 * 59), new Uint8Array(25).fill(0xff));
});

test('a CCITT image in a page becomes a PNG', () => {
  const pdf = PdfDocument.create();
  const stream = new PdfStream(
    new PdfDict({ Type: N('XObject'), Subtype: N('Image'), Width: 200, Height: 60, ColorSpace: N('DeviceGray'), BitsPerComponent: 1, Filter: N('CCITTFaxDecode'), DecodeParms: new PdfDict({ K: -1, Columns: 200, Rows: 60 }) }),
    fixture('ccitt-g4.bin'),
  );
  const page = pdf.addPage([300, 200]);
  const name = page.addResource('XObject', pdf.add(stream), 'Im');
  page.draw({ origin: 'top-left' }).save().transform(200, 0, 0, 60, 50, 100).op('Do', N(name)).restore().finish();
  const display = interpretPage(page);
  assert.equal(display.images.length, 1);
  assert.deepEqual(display.warnings, []);
  const found = imageBytes(pdf, display.images[0]);
  assert.ok(found && found.mime === 'image/png');
  // 8-bit gray, unfiltered rows: the first row's first bytes are the picture's.
  const view = new DataView(found.bytes.buffer, found.bytes.byteOffset, found.bytes.byteLength);
  assert.deepEqual([view.getUint32(16), view.getUint32(20)], [200, 60]);
  const idat: number[] = [];
  for (let p = 8; p < found.bytes.length; p += 12 + view.getUint32(p)) if (String.fromCharCode(...found.bytes.subarray(p + 4, p + 8)) === 'IDAT') idat.push(...found.bytes.subarray(p + 8, p + 8 + view.getUint32(p)));
  const raw = inflateSync(Uint8Array.from(idat));
  const pixels = fixture('ccitt-g4.pixels');
  for (const [x, y] of [[0, 0], [100, 30], [199, 59], [57, 12]]) assert.equal(raw[y * 201 + 1 + x], (pixels[y * 25 + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0);
});
