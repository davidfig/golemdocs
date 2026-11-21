// Glyph instances kept small while their page isn't drawn (see PageShelf). Each instance is 20 bytes (x, y, size, glyph, color);
// neighbouring glyphs share most of those bytes (the same size and color, the same line, x rising slowly), so the bytes are first
// grouped by their place in the instance (all first bytes, then all second bytes...) and then deflated: about a sixth of the size.

import { deflateRaw, inflateRaw } from '@golemdocs/docx';

/** Packs `count` instances of `stride` bytes from the start of `data`. */
export async function packInstances(data: ArrayBuffer, count: number, stride: number): Promise<Uint8Array> {
  const from = new Uint8Array(data, 0, count * stride);
  const planes = new Uint8Array(from.length);
  for (let k = 0; k < stride; k++) {
    const plane = k * count;
    for (let i = 0, at = k; i < count; i++, at += stride) planes[plane + i] = from[at];
  }
  return deflateRaw(planes);
}

/** The instances `packInstances` packed, in a buffer of their own. */
export async function unpackInstances(packed: Uint8Array, count: number, stride: number): Promise<ArrayBuffer> {
  const planes = await inflateRaw(packed, count * stride);
  if (planes.length !== count * stride) throw new RangeError(`packed instances came out at ${planes.length} bytes, not ${count * stride}`);
  const out = new Uint8Array(count * stride);
  for (let k = 0; k < stride; k++) {
    const plane = k * count;
    for (let i = 0, at = k; i < count; i++, at += stride) out[at] = planes[plane + i];
  }
  return out.buffer;
}
