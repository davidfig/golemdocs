// Decoding and encoding pictures (src/formats/imageCodec.ts): the logic around the browser's codecs,
// run against a recording fake canvas (test/fakeCanvas.ts).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { decodeImage, encodeCanvas, makeCanvas, toPng, transcode } from '../src/formats/imageCodec.ts';
import { FakeCanvas, installFakeCanvas } from './fakeCanvas.ts';
import { jpegBytes, pngBytes } from './pictures.ts';

let fake: ReturnType<typeof installFakeCanvas>;
beforeEach(() => {
  fake = installFakeCanvas((blob) => ({ width: 30, height: 20, ...(blob.type === 'image/gif' ? { width: 4, height: 2 } : {}) }));
});
afterEach(() => fake.restore());

const text = async (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const GIF = Uint8Array.from([...Buffer.from('GIF89a'), 3, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

test('makeCanvas rounds its size, never below 1 pixel, and asks for a readable context', () => {
  const { canvas } = makeCanvas(10.6, 0.2);
  assert.deepEqual([canvas.width, canvas.height], [11, 1]);
  assert.deepEqual((fake.canvases[0] as FakeCanvas).contextOptions, { willReadFrequently: true });
  const negative = makeCanvas(-4, 0).canvas;
  assert.deepEqual([negative.width, negative.height], [1, 1]);
});

test('makeCanvas throws when there is no 2D context', () => {
  FakeCanvas.noContext = true;
  assert.throws(() => makeCanvas(2, 2), /no 2D canvas/);
});

test('decodeImage hands the browser a blob of the sniffed type, whatever the caller thinks', async () => {
  await decodeImage(pngBytes(2, 2, 100));
  await decodeImage(pngBytes(2, 2, 100), 'jpeg'); // an explicit type wins over sniffing
  await decodeImage(Uint8Array.from([1, 2, 3])); // unrecognised bytes: tried as PNG
  assert.deepEqual(
    fake.bitmaps.map((b) => b.blob.type),
    ['image/png', 'image/jpeg', 'image/png'],
  );
});

test('decodeImage passes on the browser refusing a picture', async () => {
  fake.restore();
  fake = installFakeCanvas(() => null);
  await assert.rejects(decodeImage(pngBytes(2, 2, 1)), /cannot decode/);
});

test('encodeCanvas: PNG and WebP are encoded from the canvas itself, with the quality asked for', async () => {
  const { canvas } = makeCanvas(4, 4);
  const png = await encodeCanvas(canvas, 'png');
  assert.equal(await text(png), 'encoded:image/png');
  await encodeCanvas(canvas, 'webp', 0.5);
  assert.deepEqual((canvas as unknown as FakeCanvas).encoded, [
    { type: 'image/png', quality: 0.92 },
    { type: 'image/webp', quality: 0.5 },
  ]);
  assert.equal(fake.canvases.length, 1, 'no scratch canvas was needed');
});

test('encodeCanvas: JPEG has no transparency, so the picture is first drawn onto white', async () => {
  const { canvas } = makeCanvas(6, 3);
  const jpeg = await encodeCanvas(canvas, 'jpeg', 0.7);
  assert.equal(await text(jpeg), 'encoded:image/jpeg');
  const flat = fake.canvases[1]!;
  assert.deepEqual([flat.width, flat.height], [6, 3]);
  const fill = flat.ctx.calls.find((c) => c.op === 'fillRect')!;
  assert.equal(fill.fillStyle, '#fff');
  assert.deepEqual(fill.args, [0, 0, 6, 3]);
  const order = flat.ctx.calls.map((c) => c.op);
  assert.ok(order.indexOf('fillRect') < order.indexOf('drawImage'), 'white first, the picture over it');
  assert.equal(flat.ctx.calls.find((c) => c.op === 'drawImage')!.args[0], canvas);
  assert.deepEqual(flat.encoded, [{ type: 'image/jpeg', quality: 0.7 }]);
  assert.equal((canvas as unknown as FakeCanvas).encoded.length, 0, 'the original was not encoded');
});

test('encodeCanvas reports a type the browser cannot encode', async () => {
  FakeCanvas.blob = () => null;
  await assert.rejects(encodeCanvas(makeCanvas(2, 2).canvas, 'webp'), /can't save webp pictures/);
});

test('transcode returns the very same bytes when the picture already is that type', async () => {
  const png = pngBytes(3, 3, 9);
  assert.equal(await transcode(png, 'png'), png);
  assert.equal(fake.bitmaps.length, 0, 'nothing was decoded');
});

test('transcode decodes, draws at the picture’s own size and re-encodes, closing the bitmap', async () => {
  const out = await transcode(pngBytes(3, 3, 9), 'webp', 0.4);
  assert.equal(await text(out), 'encoded:image/webp');
  const [bitmap] = fake.bitmaps;
  assert.equal(bitmap!.closed, true);
  const canvas = fake.canvases[0]!;
  assert.deepEqual([canvas.width, canvas.height], [30, 20]);
  assert.equal(canvas.ctx.ops('drawImage')[0]!.args[0], bitmap);
  assert.deepEqual(canvas.encoded, [{ type: 'image/webp', quality: 0.4 }]);
  // Unrecognised bytes are still tried (as PNG) rather than refused.
  await transcode(Uint8Array.from([9, 9, 9]), 'jpeg');
  assert.equal(fake.bitmaps.length, 2);
});

test('toPng leaves PNG, JPEG and WebP alone', async () => {
  const png = pngBytes(2, 2, 5);
  const jpeg = jpegBytes(8, 8);
  assert.deepEqual(await toPng('a.b.png', png), { name: 'a.b.png', bytes: png });
  assert.deepEqual(await toPng('photo.jpg', jpeg), { name: 'photo.jpg', bytes: jpeg });
  assert.equal(fake.bitmaps.length, 0);
});

test('toPng converts other pictures to PNG and renames them, keeping dots in the stem', async () => {
  const out = await toPng('my.scan.v2.gif', GIF);
  assert.equal(out.name, 'my.scan.v2.png');
  assert.equal(await text(out.bytes), 'encoded:image/png');
  assert.equal(fake.bitmaps[0]!.blob.type, 'image/gif');
  assert.equal((await toPng('noextension', GIF)).name, 'noextension.png');
});

test('toPng refuses bytes that are no picture', async () => {
  await assert.rejects(toPng('x.dat', new TextEncoder().encode('just some text, not <a picture>')), /unknown picture type/);
  await assert.rejects(toPng('x.dat', Uint8Array.from([])), /unknown picture type/);
  // The <svg marker must be near the start (first 2 KB).
  await assert.rejects(toPng('x.svg', new TextEncoder().encode(' '.repeat(3000) + '<svg></svg>')), /unknown picture type/);
});

test('toPng draws an SVG through an <img>, scaled up to a workable size, and frees the object URL', async () => {
  const g = globalThis as Record<string, any>;
  const saved = { Image: g.Image };
  const urls = { created: [] as unknown[], revoked: [] as string[] };
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  let natural = { w: 100, h: 50 };
  g.Image = class {
    naturalWidth = 0;
    naturalHeight = 0;
    src = '';
    async decode() {
      this.naturalWidth = natural.w;
      this.naturalHeight = natural.h;
    }
  };
  URL.createObjectURL = (blob: unknown) => (urls.created.push(blob), 'blob:fake');
  URL.revokeObjectURL = (u: string) => void urls.revoked.push(u);
  try {
    const svg = new TextEncoder().encode('<?xml version="1.0"?><SVG viewBox="0 0 100 50"></SVG>');
    const out = await toPng('logo.svg', svg);
    assert.equal(out.name, 'logo.png');
    assert.equal((urls.created[0] as Blob).type, 'image/svg+xml');
    assert.deepEqual(urls.revoked, ['blob:fake']);
    let canvas = fake.canvases.at(-1)!;
    assert.deepEqual([canvas.width, canvas.height], [400, 200], '100x50 is scaled by 4, the maximum');
    assert.deepEqual(canvas.ctx.ops('drawImage')[0]!.args.slice(1), [0, 0, 400, 200]);

    natural = { w: 800, h: 400 };
    await toPng('big.svg', svg);
    canvas = fake.canvases.at(-1)!;
    assert.deepEqual([canvas.width, canvas.height], [1024, 512], 'scaled so the long side is 1024');

    natural = { w: 3000, h: 100 };
    await toPng('huge.svg', svg);
    canvas = fake.canvases.at(-1)!;
    assert.deepEqual([canvas.width, canvas.height], [3000, 100], 'never scaled down');

    natural = { w: 0, h: 0 };
    await toPng('sizeless.svg', svg);
    canvas = fake.canvases.at(-1)!;
    assert.deepEqual([canvas.width, canvas.height], [1024, 1024], 'an SVG with no size is drawn from 512x512 at scale 2');

    // The URL is freed even when drawing fails.
    urls.revoked.length = 0;
    g.Image = class {
      src = '';
      decode() {
        return Promise.reject(new Error('bad svg'));
      }
    };
    await assert.rejects(toPng('bad.svg', svg), /bad svg/);
    assert.deepEqual(urls.revoked, ['blob:fake']);
  } finally {
    g.Image = saved.Image;
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }
});
