// A vector drawing as a document: a one-page document exactly the size of the drawing, holding a
// picture of it (see imageDoc.ts), with the drawing itself kept as SVG text in the `svg` extension.
// Everything a document has (zoom and pan, saving, thumbnails, printing, conversion to Word, or to
// PDF, where the drawing stays vector) works on it, and the vector editor changes the drawing in
// the extension and draws the picture again.

import type { WordDocument } from '@golemdocs/docx';
import type { Extensions, SvgExtension } from './wdoc.ts';
import { decodeImage, encodeCanvas, makeCanvas } from './imageCodec.ts';
import { imageToDocument } from './imageDoc.ts';
import { sniffImage } from './images.ts';
import { gunzip, gzip, isGzip } from '../vector/gzip.ts';
import { loadImages, paintScene } from '../vector/paint.ts';
import { readSvg } from '../vector/svgRead.ts';
import type { Scene } from '../vector/model.ts';
import { writeSvg } from '../vector/svgWrite.ts';

/** The longest side the picture of a drawing has: a canvas much bigger fails, or takes all the memory there is. */
const LARGEST_SIDE = 8192;
/** Small drawings are pictured larger, so they stay sharp when zoomed: up to this many times, aiming at this many pixels on the long side. */
const SMALLEST_TARGET = 1024;
const MOST_ENLARGED = 4;

/** The drawing as PNG, in as many pixels as are worth having. */
export async function sceneToPng(scene: Scene): Promise<Uint8Array> {
  const longest = Math.max(scene.width, scene.height, 1);
  const scale = Math.min(Math.max(1, Math.min(MOST_ENLARGED, SMALLEST_TARGET / longest)), LARGEST_SIDE / longest);
  const { canvas, context } = makeCanvas(scene.width * scale, scene.height * scale);
  const images = await loadImages(scene, (bytes) => decodeImage(bytes));
  paintScene(context, scene, canvas.width, canvas.height, { images });
  return encodeCanvas(canvas, 'png');
}

/** The SVG text of a file's bytes (undoing gzip if it is compressed); the scene is read from it to check it is one. */
export async function svgText(bytes: Uint8Array): Promise<{ text: string; scene: Scene; gzip: boolean }> {
  const zipped = isGzip(bytes);
  const text = new TextDecoder().decode(zipped ? await gunzip(bytes) : bytes).replace(/^﻿/, '');
  return { text, scene: readSvg(text), gzip: zipped };
}

/** The document for a drawing: the page showing it, and the extension that keeps it. */
export async function sceneToDocument(scene: Scene, text: string, zipped = false): Promise<{ document: WordDocument; extensions: Extensions }> {
  const png = sniffImage(await sceneToPng(scene));
  if (!png) throw new Error('the drawing could not be pictured');
  // The page has the drawing's own size; the picture has more pixels than that.
  const document = await imageToDocument({ ...png, width: scene.width, height: scene.height });
  const svg: SvgExtension = { source: text, ...(zipped && { gzip: true as const }) };
  return { document, extensions: { svg } };
}

/** The scene kept in a document's extension. */
export const sceneOf = (extensions: Extensions): Scene | null => (extensions.svg ? readSvg(extensions.svg.source) : null);

/** The drawing's file: plain SVG text, or gzip-compressed for .svgz. */
export async function svgBytes(text: string, compressed: boolean): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return compressed ? gzip(bytes) : bytes;
}

export { writeSvg };
