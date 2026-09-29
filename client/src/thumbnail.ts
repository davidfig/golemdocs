// Thumbnails of a document's first page, drawn with the same renderer as the editor into an
// offscreen framebuffer, so they always look like the real page (fonts, images, headers and all).
// One is made whenever a document is saved in this browser (see main.ts), kept next to it in
// IndexedDB (storage/local.ts) and, for documents in the cloud, uploaded with them (library.ts).

import { Camera } from './view/camera.ts';
import type { GpuPage } from './view/gpuPage.ts';
import type { PageRenderer } from './view/pageRenderer.ts';

/** Thumbnails are at most this many pixels wide and tall (about 2x their size on the dashboard). */
export const THUMB_WIDTH = 320;
export const THUMB_MAX_HEIGHT = 420;

/** Pixel size of a thumbnail of a page: as large as fits the limits, keeping the page's shape. */
export function thumbnailSize(pageWidth: number, pageHeight: number): { width: number; height: number } {
  if (!(pageWidth > 0) || !(pageHeight > 0)) return { width: THUMB_WIDTH, height: THUMB_MAX_HEIGHT };
  const scale = Math.min(THUMB_WIDTH / pageWidth, THUMB_MAX_HEIGHT / pageHeight);
  return { width: Math.max(1, Math.round(pageWidth * scale)), height: Math.max(1, Math.round(pageHeight * scale)) };
}

/**
 * GL reads pixels bottom row first; images want the top row first. Also forces every pixel opaque:
 * the page is opaque, and blending text into a framebuffer can leave alpha a little under 255.
 */
export function toTopDownOpaque(pixels: Uint8Array, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const row = width * 4;
  const out = new Uint8ClampedArray(row * height);
  for (let y = 0; y < height; y++) {
    const from = (height - 1 - y) * row;
    const to = y * row;
    out.set(pixels.subarray(from, from + row), to);
    for (let x = 3; x < row; x += 4) out[to + x] = 255;
  }
  return out;
}

/**
 * Draws a page into an offscreen framebuffer at a pixel size and reads it back, top row first and
 * opaque. Null if the framebuffer can't be made. Leaves the GL state the editor's frame loop relies on
 * as found.
 */
export function readPage(gl: WebGL2RenderingContext, renderer: PageRenderer, page: GpuPage, width: number, height: number): Uint8ClampedArray<ArrayBuffer> | null {
  const camera = new Camera();
  camera.width = width;
  camera.height = height;
  camera.dpr = 1;
  camera.fit({ x: page.x, y: page.y, width: page.width, height: page.height }, width, height, 0);

  const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  const pixels = new Uint8Array(width * height * 4);
  let ok = false;
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
      renderer.render(camera, [page]);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      ok = true;
    }
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, previousTexture);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
  }
  return ok ? toTopDownOpaque(pixels, width, height) : null;
}

/**
 * Renders a page to an image (WebP where the browser can encode it, else PNG). Returns null if
 * the framebuffer can't be made.
 */
export async function capturePageThumbnail(gl: WebGL2RenderingContext, renderer: PageRenderer, page: GpuPage): Promise<Blob | null> {
  const { width, height } = thumbnailSize(page.width, page.height);
  const pixels = readPage(gl, renderer, page, width, height);
  if (!pixels) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85));
}

/** Points of grey between pages when several are drawn in one picture. */
export const PAGE_GAP_POINTS = 12;

/** Pixels per point of a page picture (2: about 144 dpi), lowered when the pages together would be too large for a canvas. */
const PICTURE_SCALE = 2;

/**
 * How pages stacked top to bottom fit in one picture: the pixels per point, and how many pages go in. The scale is
 * PICTURE_SCALE unless that would pass a canvas's limits (then the largest that fits, but not below a quarter of it,
 * after which pages are left out instead).
 */
export function pictureLayout(pageSizes: readonly { width: number; height: number }[], limits: { side: number; pixels: number }): { scale: number; count: number; width: number; height: number } {
  const fits = (count: number, scale: number) => {
    const width = Math.max(...pageSizes.slice(0, count).map((p) => p.width));
    const height = pageSizes.slice(0, count).reduce((sum, p) => sum + p.height, 0) + PAGE_GAP_POINTS * (count - 1);
    const w = Math.ceil(width * scale);
    const h = Math.ceil(height * scale);
    return w <= limits.side && h <= limits.side && w * h <= limits.pixels ? { w, h } : null;
  };
  for (let count = pageSizes.length; count >= 1; count--) {
    // The largest scale, up to the default, at which these pages fit (stepping down to a quarter of it).
    for (let scale = PICTURE_SCALE; scale >= PICTURE_SCALE / 4 - 1e-9; scale /= 1.25) {
      const size = fits(count, scale);
      if (size) return { scale, count, width: size.w, height: size.h };
    }
  }
  const first = pageSizes[0] ?? { width: 612, height: 792 };
  const scale = Math.min(limits.side / first.width, limits.side / first.height, Math.sqrt(limits.pixels / (first.width * first.height)));
  return { scale, count: 1, width: Math.floor(first.width * scale), height: Math.floor(first.height * scale) };
}

/** The pages drawn one under another on a canvas, white pages on grey, as the layout gives them. Null if a page can't be drawn. */
export function drawPages(gl: WebGL2RenderingContext, renderer: PageRenderer, pages: readonly GpuPage[], layout: { scale: number; count: number; width: number; height: number }): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#e0e0e0';
  context.fillRect(0, 0, canvas.width, canvas.height);
  let y = 0;
  for (const page of pages.slice(0, layout.count)) {
    const width = Math.max(1, Math.round(page.width * layout.scale));
    const height = Math.max(1, Math.round(page.height * layout.scale));
    const pixels = readPage(gl, renderer, page, width, height);
    if (!pixels) return null;
    context.putImageData(new ImageData(pixels, width, height), Math.round((canvas.width - width) / 2), Math.round(y));
    y += height + PAGE_GAP_POINTS * layout.scale;
  }
  return canvas;
}
