// A vector drawing as a document: a one-page document exactly the size of the drawing, holding a
// picture of it (see imageDoc.ts), with the drawing itself kept as SVG text in the `svg` extension.
// Everything a document has (zoom and pan, saving, thumbnails, printing, conversion to Word, or to
// PDF, where the drawing stays vector) works on it, and the vector editor changes the drawing in
// the extension and draws the picture again.

import type { Drawing, WordDocument } from '@golemdocs/docx';
import { isWdoc, readWdoc, writeWdoc, type Extensions, type SvgExtension } from './wdoc.ts';
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
  // The drawing is kept beside its picture too (as for a drawing in a Word document), so that editing it together with others is a change to the document.
  keepSvgBesidePicture(document, text);
  const svg: SvgExtension = { source: text, ...(zipped && { gzip: true as const }) };
  return { document, extensions: { svg } };
}

/** Puts the SVG text in the document as the part beside the picture of the drawing the page shows. */
export function keepSvgBesidePicture(document: WordDocument, text: string): void {
  const drawing = firstDrawing(document);
  if (drawing) drawing.svg = document.addImage(new TextEncoder().encode(text), 'svg');
}

function firstDrawing(document: WordDocument): Drawing | null {
  for (const block of document.body) {
    if (block.kind !== 'paragraph') continue;
    for (const inline of block.children) {
      if (inline.kind !== 'run') continue;
      for (const item of inline.content) if (item.kind === 'drawing') return item;
    }
  }
  return null;
}

/** The SVG text of the drawing a document shows (its sidecar part), or null for a document that has none. */
export async function svgOfDocument(document: WordDocument): Promise<string | null> {
  const part = firstDrawing(document)?.svg;
  return part ? new TextDecoder().decode(await document.media(part)).replace(/^﻿/, '') : null;
}

/** The scene kept in a document's extension. */
export const sceneOf = (extensions: Extensions): Scene | null => (extensions.svg ? readSvg(extensions.svg.source) : null);

/** The drawing's file: plain SVG text, or gzip-compressed for .svgz. */
export async function svgBytes(text: string, compressed: boolean): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return compressed ? gzip(bytes) : bytes;
}

export { writeSvg };

/** The drawing in a stored document's bytes (a .wdoc made from a drawing, or an SVG file): its SVG text, a picture of it and its size. Null if it isn't one. */
export async function storedDrawing(bytes: Uint8Array): Promise<{ svg: string; png: Uint8Array; width: number; height: number } | null> {
  try {
    const text = isWdoc(bytes) ? ((await readWdoc(bytes)).extensions.svg?.source ?? null) : (await svgText(bytes)).text;
    if (text === null) return null;
    const scene = readSvg(text);
    return { svg: text, png: await sceneToPng(scene), width: scene.width, height: scene.height };
  } catch {
    return null;
  }
}

/** A stored drawing's bytes with the drawing in them replaced by this SVG: the picture the document shows is made again. Null if the bytes aren't a drawing's. */
export async function rewriteStoredDrawing(bytes: Uint8Array, svg: string): Promise<Uint8Array | null> {
  if (!isWdoc(bytes)) return null;
  const wdoc = await readWdoc(bytes);
  if (!wdoc.extensions.svg) return null;
  const { document, extensions } = await sceneToDocument(readSvg(svg), svg, wdoc.extensions.svg.gzip === true);
  return writeWdoc({ ...wdoc, document: await document.write(), extensions: { ...wdoc.extensions, ...extensions } });
}

/** The bytes of a new stored drawing (a .wdoc) holding this SVG. */
export async function newStoredDrawing(svg: string): Promise<Uint8Array> {
  const { document, extensions } = await sceneToDocument(readSvg(svg), svg);
  return writeWdoc({ manifest: { version: 1, lens: 'svg', origin: 'svg', pagesCurrent: false }, document: await document.write(), original: null, extensions });
}
