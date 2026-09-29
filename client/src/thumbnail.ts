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
 * Renders a page to an image (WebP where the browser can encode it, else PNG). Returns null if
 * the framebuffer can't be made. Leaves the GL state the editor's frame loop relies on as found.
 */
export async function capturePageThumbnail(gl: WebGL2RenderingContext, renderer: PageRenderer, page: GpuPage): Promise<Blob | null> {
  const { width, height } = thumbnailSize(page.width, page.height);

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
  if (!ok) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.putImageData(new ImageData(toTopDownOpaque(pixels, width, height), width, height), 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85));
}
