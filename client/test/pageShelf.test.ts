// Pages away from the view keep their glyphs packed small (a book of tens of thousands of pages ran out of memory otherwise), and get
// them back, exactly, as they come near the view.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GLYPH_INSTANCE_BYTES } from '@golemdocs/layout';
import { packInstances, unpackInstances } from '../src/webgl/text/instancePack.ts';
import { TextBatch } from '../src/webgl/text/textBatch.ts';
import { PageShelf, nearRange, pagesNear } from '../src/webgl/pageShelf.ts';
import type { GpuPage } from '../src/webgl/gpuPage.ts';
import type { GpuFace } from '../src/webgl/text/gpuFace.ts';

/** Instances like a line of text: x rising, the same y, size and color. */
function instances(count: number, capacity = count): ArrayBuffer {
  const buffer = new ArrayBuffer(capacity * GLYPH_INSTANCE_BYTES);
  const view = new DataView(buffer);
  for (let i = 0; i < count; i++) {
    const at = i * GLYPH_INSTANCE_BYTES;
    view.setFloat32(at, 72 + i * 5.5, true);
    view.setFloat32(at + 4, 100 + Math.floor(i / 90) * 14, true);
    view.setFloat32(at + 8, 11, true);
    view.setUint16(at + 12, 30 + (i % 26), true);
    view.setUint32(at + 16, 0xff202020, true);
  }
  return buffer;
}

test('packed instances come back byte for byte, in a fraction of the space', async () => {
  const data = instances(1500, 2048);
  const packed = await packInstances(data, 1500, GLYPH_INSTANCE_BYTES);
  assert.ok(packed.length < (1500 * GLYPH_INSTANCE_BYTES) / 4, `${packed.length} bytes packed from ${1500 * GLYPH_INSTANCE_BYTES}`);
  const back = await unpackInstances(packed, 1500, GLYPH_INSTANCE_BYTES);
  assert.deepEqual(new Uint8Array(back), new Uint8Array(data, 0, 1500 * GLYPH_INSTANCE_BYTES));
});

/** Just enough of WebGL for a batch to upload. */
function fakeGl(uploads: Uint8Array[]): WebGL2RenderingContext {
  const nothing = () => {};
  return new Proxy(
    { bufferData: (_target: number, data: Uint8Array) => void uploads.push(data.slice()), createVertexArray: () => ({}), createBuffer: () => ({}) },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : typeof key === 'string' && key === key.toUpperCase() ? 0 : nothing) },
  ) as unknown as WebGL2RenderingContext;
}

const face = {} as GpuFace;

test('a shelved batch draws nothing until it is unshelved, then uploads its glyphs as they were', async () => {
  const data = instances(300);
  const expected = new Uint8Array(data.slice(0));
  const batch = new TextBatch(face, { skew: 0, embolden: 0 }, data, 300);
  const uploads: Uint8Array[] = [];
  const gl = fakeGl(uploads);
  assert.equal(batch.waiting, true);
  await batch.shelve();
  assert.equal(batch.shelved, true);
  assert.equal(batch.waiting, false);
  assert.equal(batch.prepare(gl), null, 'nothing to draw while packed');
  assert.equal(uploads.length, 0);
  await batch.unshelve();
  assert.equal(batch.shelved, false);
  assert.notEqual(batch.prepare(gl), null);
  assert.deepEqual(uploads, [expected]);
  // Drawn: nothing left to pack.
  await batch.shelve();
  assert.equal(batch.shelved, false);
});

test('a batch uploaded while it was being packed keeps what it uploaded', async () => {
  const batch = new TextBatch(face, { skew: 0, embolden: 0 }, instances(300), 300);
  const uploads: Uint8Array[] = [];
  const packing = batch.shelve();
  assert.notEqual(batch.prepare(fakeGl(uploads)), null);
  await packing;
  assert.equal(batch.shelved, false);
  assert.equal(uploads.length, 1);
});

/** A stand-in page: one batch of glyphs, placed one under another. */
function page(index: number): GpuPage {
  const batch = new TextBatch(face, { skew: 0, embolden: 0 }, instances(200), 200);
  return {
    x: 0,
    y: index * 800,
    width: 612,
    height: 792,
    shown: null,
    text: [batch],
    get waiting() {
      return batch.waiting;
    },
    get shelved() {
      return batch.shelved;
    },
    shelve: () => batch.shelve(),
    unshelve: () => batch.unshelve(),
  } as unknown as GpuPage;
}

test('pages near the view are the ones in it and a screen either side', () => {
  const pages = Array.from({ length: 20 }, (_, i) => page(i));
  // The view shows pages 5 and 6 (y 4000 to 5600); a screen of 1600 either side reaches pages 3 to 8.
  assert.deepEqual(
    pagesNear(pages, { top: 4000, bottom: 5600 }, 1).map((p) => p.y / 800),
    [3, 4, 5, 6, 7, 8],
  );
  // As positions, for the layout worker (which finds squiggles there).
  assert.deepEqual(nearRange(pages, { top: 4000, bottom: 5600 }, 1), { from: 3, to: 9 });
  assert.deepEqual(nearRange(pages, { top: 100_000, bottom: 101_600 }, 1), { from: 20, to: 20 }, 'past the end: none');
});

test('the shelf packs pages away from the view, leaves those near it, and brings them back as the view comes', async () => {
  const pages = Array.from({ length: 10 }, (_, i) => page(i));
  let redraws = 0;
  const shelf = new PageShelf(() => void redraws++, 0);
  shelf.keep(pages.slice(0, 2));
  shelf.added(pages);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    pages.map((p) => p.shelved),
    [false, false, true, true, true, true, true, true, true, true],
  );
  // The view moves down to pages 7 and 8.
  shelf.keep(pages.slice(7, 9));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pages[7].shelved, false);
  assert.equal(pages[8].shelved, false);
  assert.equal(pages[5].shelved, true);
  assert.ok(redraws > 0, 'drawn again once the glyphs are back');
  // A picture of a far page brings it back too.
  await shelf.bring(pages[3]);
  assert.equal(pages[3].shelved, false);
  shelf.clear();
});
