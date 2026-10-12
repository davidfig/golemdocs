// HEIC pictures (src/formats/images.ts reads the file's header, heicDecode.ts decodes it). The fixtures are real
// files made by macOS `sips` from a 64 x 48 picture; photo-turned.heic has an `irot` box turning it a quarter turn.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { keptPictureName, sniffImage } from '../src/formats/images.ts';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));

test('a HEIC file is recognised, with the size of its main picture', () => {
  const image = sniffImage(fixture('photo.heic'));
  assert.equal(image?.type, 'heic');
  assert.deepEqual([image?.width, image?.height], [64, 48]);
});

test('a HEIC picture turned by a quarter turn has its width and height swapped', () => {
  const image = sniffImage(fixture('photo-turned.heic'));
  assert.equal(image?.type, 'heic');
  assert.deepEqual([image?.width, image?.height], [48, 64]);
});

test('other files that are boxes (AVIF, a truncated HEIC) are not taken for HEIC', () => {
  const ftyp = (brand: string, ...compatible: string[]) => {
    const bytes = new Uint8Array(16 + compatible.length * 4 + 8);
    new DataView(bytes.buffer).setUint32(0, 16 + compatible.length * 4);
    bytes.set(new TextEncoder().encode(`ftyp${brand}`), 4);
    compatible.forEach((c, i) => bytes.set(new TextEncoder().encode(c), 16 + i * 4));
    return bytes;
  };
  assert.equal(sniffImage(ftyp('avif', 'mif1', 'avif')), null);
  assert.equal(sniffImage(ftyp('mif1', 'avif', 'miaf')), null);
  assert.equal(sniffImage(ftyp('isom', 'mp42')), null);
  // A HEIC brand with no `meta` box: still HEIC, its size unknown.
  assert.deepEqual([sniffImage(ftyp('heic', 'mif1'))?.type, sniffImage(ftyp('heic', 'mif1'))?.width], ['heic', 0]);
  // Cut off in the middle of the metadata: no crash.
  assert.doesNotThrow(() => sniffImage(fixture('photo.heic').subarray(0, 70)));
});

test('a HEIC photo is kept under a JPEG name', () => {
  assert.equal(keptPictureName('IMG_0001.HEIC'), 'IMG_0001.jpg');
  assert.equal(keptPictureName('a.b.heif'), 'a.b.jpg');
  assert.equal(keptPictureName('a.jpg'), 'a.jpg');
});

test('libheif decodes the main picture to RGBA, turned as the file says', async () => {
  const { decodeHeicPixels } = await import('../src/formats/heicDecode.ts');
  const flat = await decodeHeicPixels(fixture('photo.heic'));
  assert.deepEqual([flat.width, flat.height, flat.data.length], [64, 48, 64 * 48 * 4]);
  // The picture is a gradient: red grows to the right, green downward (HEIC is lossy, so roughly).
  const at = (x: number, y: number) => flat.data.subarray((y * flat.width + x) * 4, (y * flat.width + x) * 4 + 3);
  assert.ok(at(60, 2)[0] > at(3, 2)[0] + 100);
  assert.ok(at(2, 44)[1] > at(2, 3)[1] + 100);
  const turned = await decodeHeicPixels(fixture('photo-turned.heic'));
  assert.deepEqual([turned.width, turned.height], [48, 64]);
});
