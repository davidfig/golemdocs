// The parts of thumbnails (src/thumbnail.ts) that need no GPU or DOM: sizes, pixel order, and the
// page-picture layout. readPage is run against a scripted WebGL context.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pictureLayout, PAGE_GAP_POINTS, readPage, THUMB_MAX_HEIGHT, THUMB_WIDTH, thumbnailSize, toTopDownOpaque } from '../src/thumbnail.ts';
import type { GpuPage } from '../src/view/gpuPage.ts';
import type { PageRenderer } from '../src/view/pageRenderer.ts';

test('thumbnailSize fits the page in the limits and keeps its shape', () => {
  assert.deepEqual(thumbnailSize(612, 792), { width: 320, height: 414 }, 'Letter is limited by width');
});

test('thumbnailSize: a wide page is limited by width, a tall one by height', () => {
  assert.deepEqual(thumbnailSize(1000, 100), { width: 320, height: 32 });
  assert.deepEqual(thumbnailSize(100, 1000), { width: 42, height: 420 });
  assert.deepEqual(thumbnailSize(1, 1e6), { width: 1, height: THUMB_MAX_HEIGHT }, 'never below 1 px');
  assert.deepEqual(thumbnailSize(1e6, 1), { width: THUMB_WIDTH, height: 1 });
});

test('thumbnailSize falls back to the full box for a page with no usable size', () => {
  for (const [w, h] of [[0, 100], [100, 0], [-1, 5], [NaN, 5], [5, Infinity * 0]] as const) assert.deepEqual(thumbnailSize(w, h), { width: THUMB_WIDTH, height: THUMB_MAX_HEIGHT }, `${w}x${h}`);
});

test('toTopDownOpaque flips the rows and makes every pixel opaque', () => {
  // 2x2, GL order: bottom row first.
  const gl = Uint8Array.from([
    /* bottom */ 1, 2, 3, 10, 4, 5, 6, 20,
    /* top    */ 7, 8, 9, 30, 10, 11, 12, 255,
  ]);
  const out = toTopDownOpaque(gl, 2, 2);
  assert.deepEqual([...out], [7, 8, 9, 255, 10, 11, 12, 255, 1, 2, 3, 255, 4, 5, 6, 255]);
  assert.ok(out instanceof Uint8ClampedArray);
  assert.deepEqual([...gl.subarray(0, 4)], [1, 2, 3, 10], 'the input is not modified');
  assert.equal(toTopDownOpaque(new Uint8Array(0), 0, 0).length, 0);
  assert.deepEqual([...toTopDownOpaque(Uint8Array.from([9, 9, 9, 0]), 1, 1)], [9, 9, 9, 255]);
});

test('pictureLayout: pages that fit are drawn at the default scale with a gap between them', () => {
  const layout = pictureLayout([{ width: 100, height: 200 }, { width: 150, height: 100 }], { side: 10000, pixels: 1e9 });
  assert.equal(layout.scale, 2);
  assert.equal(layout.count, 2);
  assert.equal(layout.width, 300);
  assert.equal(layout.height, Math.ceil((300 + PAGE_GAP_POINTS) * 2));
});

test('pictureLayout lowers the scale before dropping pages, down to a quarter', () => {
  const pages = [{ width: 100, height: 100 }];
  const layout = pictureLayout(pages, { side: 150, pixels: 1e9 });
  assert.ok(layout.scale < 2 && layout.scale >= 0.5, `scale ${layout.scale}`);
  assert.equal(layout.count, 1);
  assert.ok(layout.width <= 150 && layout.height <= 150);
  // The scale is the largest that fits: a step up would not.
  assert.ok(Math.ceil(100 * layout.scale * 1.25) > 150);
});

test('pictureLayout leaves pages out once even a quarter of the default scale does not fit them all', () => {
  const pages = Array.from({ length: 10 }, () => ({ width: 100, height: 100 }));
  const limits = { side: 400, pixels: 1e9 };
  const layout = pictureLayout(pages, limits);
  assert.ok(layout.count < 10 && layout.count >= 1);
  assert.ok(layout.height <= 400);
  assert.ok(layout.scale >= 0.5 - 1e-9);
  const more = pictureLayout(pages.slice(0, layout.count + 1), limits);
  assert.ok(more.count <= layout.count + 1);
});

test('pictureLayout honours a total pixel budget, not just the side limit', () => {
  const layout = pictureLayout([{ width: 100, height: 100 }], { side: 1e6, pixels: 20000 });
  assert.ok(layout.width * layout.height <= 20000, `${layout.width}x${layout.height}`);
  assert.ok(layout.scale < 2);
});

test('pictureLayout: a first page too big even at a quarter scale is shrunk to fit alone', () => {
  const layout = pictureLayout([{ width: 4000, height: 1000 }, { width: 10, height: 10 }], { side: 500, pixels: 1e9 });
  assert.equal(layout.count, 1);
  assert.equal(layout.scale, 500 / 4000);
  assert.equal(layout.width, 500);
  assert.equal(layout.height, 125);
});

test('pictureLayout of no pages assumes a Letter page', () => {
  const layout = pictureLayout([], { side: 100, pixels: 1e9 });
  assert.equal(layout.count, 1);
  assert.equal(layout.scale, 100 / 792);
  assert.equal(layout.height, 100);
});

/** A WebGL context that records calls, and can be told the framebuffer is incomplete. */
function fakeGl(complete: boolean, fill: (pixels: Uint8Array) => void = () => {}) {
  const log: string[] = [];
  const previous = { texture: 'prev' };
  const C = { TEXTURE_BINDING_2D: 1, TEXTURE_2D: 2, FRAMEBUFFER: 3, FRAMEBUFFER_COMPLETE: 4, COLOR_ATTACHMENT0: 5, RGBA8: 6, RGBA: 7, UNSIGNED_BYTE: 8, LINEAR: 9, TEXTURE_MIN_FILTER: 10, TEXTURE_MAG_FILTER: 11 };
  const gl = {
    ...C,
    getParameter: () => previous.texture,
    createTexture: () => 'tex',
    createFramebuffer: () => 'fb',
    bindTexture: (_t: number, tex: unknown) => log.push(`bindTexture ${tex}`),
    texImage2D: (...a: unknown[]) => log.push(`texImage2D ${a[3]}x${a[4]}`),
    texParameteri: () => {},
    bindFramebuffer: (_t: number, fb: unknown) => log.push(`bindFramebuffer ${fb}`),
    framebufferTexture2D: () => {},
    checkFramebufferStatus: () => (complete ? C.FRAMEBUFFER_COMPLETE : 0),
    readPixels: (...a: unknown[]) => {
      log.push('readPixels');
      fill(a[6] as Uint8Array);
    },
    deleteFramebuffer: (fb: unknown) => log.push(`deleteFramebuffer ${fb}`),
    deleteTexture: (t: unknown) => log.push(`deleteTexture ${t}`),
  };
  return { gl: gl as unknown as WebGL2RenderingContext, log };
}

test('readPage renders the page fitted exactly to the framebuffer, then reads it back top row first', () => {
  let camera: { x: number; y: number; zoom: number; width: number; height: number; dpr: number } | undefined;
  const renderer = { render: (c: typeof camera, pages: unknown[]) => ((camera = c), assert.equal(pages.length, 1)) } as unknown as PageRenderer;
  const { gl, log } = fakeGl(true, (pixels) => {
    pixels.set([1, 1, 1, 0, 2, 2, 2, 0], 0); // bottom row
    pixels.set([3, 3, 3, 0, 4, 4, 4, 0], 8); // top row
  });
  const page = { x: 5, y: 7, width: 100, height: 100 } as GpuPage;
  const out = readPage(gl, renderer, page, 2, 2)!;
  assert.deepEqual([...out], [3, 3, 3, 255, 4, 4, 4, 255, 1, 1, 1, 255, 2, 2, 2, 255]);
  // 2 px for 100 points at dpr 1: zoom = 2 / (100 * 96/72), centred on the page.
  assert.ok(Math.abs(camera!.zoom - 2 / (100 * (96 / 72))) < 1e-9);
  assert.equal(camera!.dpr, 1);
  assert.deepEqual([camera!.width, camera!.height], [2, 2]);
  assert.ok(Math.abs(camera!.x - 5) < 1e-9 && Math.abs(camera!.y - 7) < 1e-9, 'no padding: the view starts at the page corner');
  // GL state is put back as found: the framebuffer unbound, the old texture rebound, temporaries deleted.
  assert.deepEqual(log.slice(-4), ['bindFramebuffer null', 'bindTexture prev', 'deleteFramebuffer fb', 'deleteTexture tex']);
});

test('readPage gives null, still cleaning up, when the framebuffer is incomplete', () => {
  let rendered = false;
  const renderer = { render: () => void (rendered = true) } as unknown as PageRenderer;
  const { gl, log } = fakeGl(false);
  assert.equal(readPage(gl, renderer, { x: 0, y: 0, width: 10, height: 10 } as GpuPage, 4, 4), null);
  assert.equal(rendered, false);
  assert.ok(!log.includes('readPixels'));
  assert.deepEqual(log.slice(-4), ['bindFramebuffer null', 'bindTexture prev', 'deleteFramebuffer fb', 'deleteTexture tex']);
});

test('readPage cleans up even if rendering throws', () => {
  const renderer = {
    render: () => {
      throw new Error('shader lost');
    },
  } as unknown as PageRenderer;
  const { gl, log } = fakeGl(true);
  assert.throws(() => readPage(gl, renderer, { x: 0, y: 0, width: 10, height: 10 } as GpuPage, 2, 2), /shader lost/);
  assert.deepEqual(log.slice(-4), ['bindFramebuffer null', 'bindTexture prev', 'deleteFramebuffer fb', 'deleteTexture tex']);
});
