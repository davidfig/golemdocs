// The colour of a picture at a point, with the shapes drawn over it (what the eyedropper picks up).

import { decodeImage, makeCanvas } from './imageCodec.ts';
import type { Point, Shape } from './imageDraw.ts';
import { EFFECT_TOOLS } from './imageDraw.ts';
import { paintLayers } from './imageLayers.ts';

const hex = (n: number): string => n.toString(16).padStart(2, '0');

/** `#rrggbb` at a point of the picture's pixels, or null outside it or where it is see-through. */
export async function samplePicture(bytes: Uint8Array, shapes: readonly Shape[], at: Point): Promise<string | null> {
  const bitmap = await decodeImage(bytes);
  try {
    const x = Math.floor(at.x);
    const y = Math.floor(at.y);
    if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) return null;
    const { context } = makeCanvas(bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    // The fills among the shapes find their regions in the picture as it is without them.
    const base = shapes.some((s) => s.tool === 'fill' || EFFECT_TOOLS.includes(s.tool as never)) ? context.getImageData(0, 0, bitmap.width, bitmap.height) : null;
    paintLayers(context, shapes, false, undefined, base);
    const [r, g, b, a] = context.getImageData(x, y, 1, 1).data;
    return a === 0 ? null : `#${hex(r)}${hex(g)}${hex(b)}`;
  } finally {
    bitmap.close();
  }
}
