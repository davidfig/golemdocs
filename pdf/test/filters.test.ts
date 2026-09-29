import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { N, PdfDict, PdfStream, decodeStream, flateEncode, inflate } from '../src/index.ts';
import { applyPredictor, ascii85Decode, asciiHexDecode, lzwDecode, pngUpEncode, runLengthDecode } from '../src/filters/filters.ts';
import { ascii, latin1 } from './helpers.ts';

const sample = (): Uint8Array => {
  // Compressible text plus incompressible noise, so every block type shows up.
  const text = ascii('BT /F1 12 Tf 72 720 Td (Hello) Tj ET\n'.repeat(2000));
  const out = new Uint8Array(text.length + 70000);
  out.set(text);
  out.set(randomBytes(70000), text.length);
  return out;
};

test('inflate matches zlib at every level, wrapped and raw', () => {
  const data = sample();
  for (const level of [0, 1, 6, 9]) {
    assert.deepEqual(inflate(deflateSync(data, { level })).data, data, `zlib level ${level}`);
    assert.deepEqual(inflate(deflateRawSync(data, { level })).data, data, `raw level ${level}`);
  }
  assert.deepEqual(inflate(deflateSync(new Uint8Array(0))).data, new Uint8Array(0));
});

test('inflate returns what decoded before damage', () => {
  const data = ascii('x'.repeat(5000) + 'y'.repeat(5000));
  const z = deflateSync(data, { level: 0 }); // stored blocks: truncation point is predictable
  const r = inflate(z.subarray(0, z.length - 3000));
  assert.ok(r.error);
  assert.ok(r.data.length > 4000 && r.data.length < data.length);
  assert.deepEqual(r.data, data.subarray(0, r.data.length));
});

test('flateEncode round-trips through inflate', async () => {
  const data = sample();
  assert.deepEqual(inflate(await flateEncode(data)).data, data);
});

test('ASCIIHex, ASCII85, RunLength', () => {
  assert.equal(latin1(asciiHexDecode(ascii('48 65 6c6C 6f7>ignored'))), 'Hello\x70');
  assert.equal(latin1(ascii85Decode(ascii('<~87cURD_*#4DfTZ)+T~>'))), 'Hello, World!');
  assert.deepEqual(ascii85Decode(ascii('z~>')), new Uint8Array(4));
  // 2 literal bytes, then 'x' repeated 4 times (257 - 253), then EOD.
  assert.equal(latin1(runLengthDecode(Uint8Array.from([1, 0x61, 0x62, 253, 0x78, 128, 0x7a]))), 'abxxxx');
});

test('LZW: the example from the PDF spec (§7.4.4.2)', () => {
  const encoded = Uint8Array.from([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]);
  assert.equal(latin1(lzwDecode(encoded)), '-----A---B');
});

test('PNG predictors', () => {
  const rows = 5;
  const width = 7;
  const bpp = 3;
  const raw = Uint8Array.from({ length: rows * width * bpp }, (_, i) => (i * 37 + (i >> 3)) & 0xff);
  // Up (via our encoder) round-trips.
  assert.deepEqual(applyPredictor(pngUpEncode(raw, width * bpp), 12, bpp, 8, width), raw);
  // Each filter type encoded by hand.
  const rb = width * bpp;
  const enc = new Uint8Array(rows * (rb + 1));
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let r = 0; r < rows; r++) {
    const type = r % 5;
    enc[r * (rb + 1)] = type;
    for (let i = 0; i < rb; i++) {
      const x = raw[r * rb + i];
      const a = i >= bpp ? raw[r * rb + i - bpp] : 0;
      const b = r ? raw[(r - 1) * rb + i] : 0;
      const c = r && i >= bpp ? raw[(r - 1) * rb + i - bpp] : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][type];
      enc[r * (rb + 1) + 1 + i] = (x - pred) & 0xff;
    }
  }
  assert.deepEqual(applyPredictor(enc, 15, bpp, 8, width), raw);
});

test('TIFF predictor, 8-bit', () => {
  const raw = Uint8Array.from([10, 20, 30, 11, 22, 33, 12, 24, 36]);
  const enc = Uint8Array.from([10, 20, 30, 1, 2, 3, 1, 2, 3]);
  assert.deepEqual(applyPredictor(enc, 2, 3, 8, 3), raw);
});

test('decodeStream applies a filter chain and stops at image codecs', () => {
  const data = ascii('stream contents');
  const hexed = ascii(Buffer.from(deflateSync(data)).toString('hex') + '>');
  const s = new PdfStream(new PdfDict({ Filter: [N('AHx'), N('Fl')] }), hexed);
  assert.equal(latin1(decodeStream(s).data), 'stream contents');
  const jpeg = new PdfStream(new PdfDict({ Filter: [N('FlateDecode'), N('DCTDecode')] }), deflateSync(ascii('JPEG')));
  const r = decodeStream(jpeg);
  assert.equal(latin1(r.data), 'JPEG');
  assert.deepEqual(r.remaining.map((f) => f.name), ['DCTDecode']);
});
