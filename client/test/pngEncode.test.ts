// The PNG written from pixels (src/formats/pngEncode.ts), for where a canvas's Blob can't be read (WebKit, an opaque-origin worker):
// read back here with Node's own zlib and CRC, so the file is one any decoder takes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32 as nodeCrc32, inflateSync } from 'node:zlib';
import { crc32, encodePng } from '../src/formats/pngEncode.ts';
import { sniffImage } from '../src/formats/images.ts';

/** The chunks of a PNG: type, data, and whether its CRC is right. */
function chunks(png: Uint8Array): { type: string; data: Uint8Array; crcOk: boolean }[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out = [];
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    out.push({ type, data, crcOk: view.getUint32(at + 8 + length) === nodeCrc32(png.subarray(at + 4, at + 8 + length)) });
    at += 12 + length;
  }
  return out;
}

test('crc32 is the PNG and zlib CRC', () => {
  for (const text of ['', 'IEND', 'The quick brown fox jumps over the lazy dog']) {
    const bytes = new TextEncoder().encode(text);
    assert.equal(crc32(bytes), nodeCrc32(bytes), text);
  }
});

test('pixels come back from the PNG exactly, with its size, in valid chunks', async () => {
  const width = 3;
  const height = 2;
  const pixels = Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => (i * 37) % 256);
  const png = await encodePng(pixels, width, height);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const sniffed = sniffImage(png);
  assert.deepEqual([sniffed?.type, sniffed?.width, sniffed?.height], ['png', width, height]);
  const parts = chunks(png);
  assert.deepEqual(parts.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  assert.ok(parts.every((c) => c.crcOk));
  assert.deepEqual([...parts[0]!.data.subarray(8)], [8, 6, 0, 0, 0], '8-bit RGBA, not interlaced');
  const raw = inflateSync(parts[1]!.data);
  const rows = [];
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width * 4 + 1)], 0, 'each row unfiltered');
    rows.push(...raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)));
  }
  assert.deepEqual(rows, [...pixels]);
});
