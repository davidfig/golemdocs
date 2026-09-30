// Decoding pictures to pixels and encoding pixels as a picture file, with the browser's own codecs
// (OffscreenCanvas where there is one, so it also works in the layout worker). Kept apart from
// images.ts (which only reads headers) because it needs a browser.

import { MIME, sniffImage } from './images.ts';
import type { ImageData, ImageType } from './images.ts';

/** What a picture can be saved as: the types a canvas can encode. */
export type OutputType = 'png' | 'jpeg' | 'webp';

export interface Canvas2D {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
}

export function makeCanvas(width: number, height: number): Canvas2D {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const context = canvas.getContext('2d', { willReadFrequently: true }) as Canvas2D['context'] | null;
  if (!context) throw new Error('no 2D canvas');
  return { canvas, context };
}

/** A picture's pixels as the browser shows it (rotation tags applied). */
export async function decodeImage(bytes: Uint8Array, type?: ImageType): Promise<ImageBitmap> {
  const kind = type ?? sniffImage(bytes)?.type ?? 'png';
  return createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: MIME[kind] }));
}

/** JPEG has no transparency: what shows through is white. */
export async function encodeCanvas(canvas: Canvas2D['canvas'], type: OutputType, quality = 0.92): Promise<Uint8Array> {
  let source = canvas;
  if (type === 'jpeg') {
    const flat = makeCanvas(canvas.width, canvas.height);
    flat.context.fillStyle = '#fff';
    flat.context.fillRect(0, 0, canvas.width, canvas.height);
    flat.context.drawImage(canvas as CanvasImageSource, 0, 0);
    source = flat.canvas;
  }
  const options = { type: MIME[type], quality };
  const blob = 'convertToBlob' in source ? await source.convertToBlob(options) : await new Promise<Blob | null>((resolve) => (source as HTMLCanvasElement).toBlob(resolve, options.type, options.quality));
  if (!blob) throw new Error(`this browser can't save ${type} pictures`);
  return new Uint8Array(await blob.arrayBuffer());
}

/** A picture file as another type (or the same bytes, when it already is that type). */
export async function transcode(bytes: Uint8Array, to: OutputType, quality = 0.92): Promise<Uint8Array> {
  const image = sniffImage(bytes);
  if (image?.type === to) return bytes;
  const bitmap = await decodeImage(bytes, image?.type);
  const { canvas, context } = makeCanvas(bitmap.width, bitmap.height);
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return encodeCanvas(canvas, to, quality);
}

/** The longest side an SVG is drawn at: a canvas much bigger fails, or takes all the memory there is. */
const SVG_LARGEST_SIDE = 8192;

/** A picture as a PNG the document can hold: GIF and BMP (first frame) and SVG (drawn at its own size, small ones enlarged up to four times, huge ones reduced to fit a canvas). */
export async function toPng(name: string, bytes: Uint8Array): Promise<{ name: string; bytes: Uint8Array }> {
  const image = sniffImage(bytes);
  const stem = name.replace(/\.[^.]*$/, '');
  if (image && (image.type === 'png' || image.type === 'jpeg' || image.type === 'webp')) return { name, bytes };
  if (image) return { name: `${stem}.png`, bytes: await transcode(bytes, 'png') };
  // Not a raster type we know: SVG is drawn by an <img>, which is the one thing that renders it everywhere.
  const text = new TextDecoder().decode(bytes.subarray(0, 2048));
  if (!/<svg[\s>]/i.test(text)) throw new Error('unknown picture type');
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // An SVG without a size draws at 300x150; give one that has a viewBox a workable size.
    const width = img.naturalWidth || 512;
    const height = img.naturalHeight || 512;
    const scale = Math.min(Math.max(1, Math.min(4, 1024 / Math.max(width, height))), SVG_LARGEST_SIDE / Math.max(width, height));
    const { canvas, context } = makeCanvas(width * scale, height * scale);
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { name: `${stem}.png`, bytes: await encodeCanvas(canvas, 'png') };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export type { ImageData };
