// Image XObjects to bytes a browser can decode: DCT streams pass through as JPEG; raw pixel
// data (any filter chain that ends in samples) is converted to RGB(A) and written as PNG.

import { PdfDict, PdfRef, PdfStream, type PdfObject } from '../core/objects.ts';
import type { PdfDocument } from '../document.ts';
import { decodeStream, filterChain } from '../filters/filters.ts';
import { DEVICE_GRAY, cmykToRgb, parseColorSpace } from './color.ts';
import { encodePng } from './png.ts';

export interface ImageBytes {
  bytes: Uint8Array;
  mime: 'image/jpeg' | 'image/png';
}

export interface ImageOptions {
  /** Mirror horizontally / vertically (raw images only; JPEG passes through unmirrored). */
  flipX?: boolean;
  flipY?: boolean;
  /** Fill color (0xRRGGBB) and alpha for stencil masks (/ImageMask). */
  maskColor?: number;
  /** Larger images are subsampled to about this many pixels (default 6 million). */
  maxPixels?: number;
}

/** What `imageBytes` accepts: the image's reference or stream, optionally with the drawing's options. */
export type ImageSource = PdfRef | PdfStream | ({ stream: PdfStream } & ImageOptions);

/** The image as JPEG or PNG bytes; null when unsupported (JPEG 2000, CCITT, JBIG2) or damaged. */
export function imageBytes(doc: PdfDocument, image: ImageSource, options: ImageOptions = {}): ImageBytes | null {
  try {
    let stream: PdfObject | undefined;
    let opts = options;
    if (image instanceof PdfRef || image instanceof PdfStream) stream = doc.resolve(image);
    else {
      stream = image.stream;
      opts = { ...image, ...options };
    }
    if (!(stream instanceof PdfStream)) return null;
    return convert(doc, stream, opts);
  } catch {
    return null;
  }
}

/** True if `imageBytes` can produce something for this stream (checked without decoding pixels). */
export function imageSupported(doc: PdfDocument, stream: PdfStream): boolean {
  const chain = filterChain(stream.dict, (o) => doc.resolve(o));
  const last = chain[chain.length - 1]?.name;
  return last !== 'JPXDecode' && last !== 'CCITTFaxDecode' && last !== 'JBIG2Decode';
}

const num = (doc: PdfDocument, o: PdfObject | undefined, d: number): number => doc.number(o) ?? d;

function decodeArray(doc: PdfDocument, dict: PdfDict): number[] | undefined {
  const a = doc.array(dict.get('Decode') ?? dict.get('D'));
  return a && a.every((x) => typeof doc.resolve(x) === 'number') ? a.map((x) => doc.number(x)!) : undefined;
}

function convert(doc: PdfDocument, stream: PdfStream, opts: ImageOptions): ImageBytes | null {
  const dict = stream.dict;
  const r = decodeStream(stream, (o) => doc.resolve(o));
  if (r.remaining.length) {
    const first = r.remaining[0].name;
    if (first === 'DCTDecode' && r.remaining.length === 1) return { bytes: r.data, mime: 'image/jpeg' };
    return null;
  }
  const w = num(doc, dict.get('Width') ?? dict.get('W'), 0);
  const h = num(doc, dict.get('Height') ?? dict.get('H'), 0);
  if (w < 1 || h < 1 || w > 65535 || h > 65535) return null;
  const stencil = doc.resolve(dict.get('ImageMask') ?? dict.get('IM')) === true;
  const maxPixels = opts.maxPixels ?? 6_000_000;
  const step = Math.max(1, Math.ceil(Math.sqrt((w * h) / maxPixels)));
  const ow = Math.ceil(w / step);
  const oh = Math.ceil(h / step);

  const flipX = !!opts.flipX;
  const flipY = !!opts.flipY;
  /** Output pixel index for source-sampled (ox, oy). */
  const at = (ox: number, oy: number) => (flipY ? oh - 1 - oy : oy) * ow + (flipX ? ow - 1 - ox : ox);

  if (stencil) {
    const bits = readBits(r.data, w, 1, 1);
    const dec = decodeArray(doc, dict) ?? [0, 1];
    const paintWhen = dec[0] === 1 ? 1 : 0; // sample value that paints
    const rgb = opts.maskColor ?? 0;
    const out = new Uint8Array(ow * oh * 4);
    for (let oy = 0; oy < oh; oy++)
      for (let ox = 0; ox < ow; ox++) {
        const s = bits(Math.min(h - 1, oy * step), Math.min(w - 1, ox * step), 0);
        const p = at(ox, oy) * 4;
        out[p] = (rgb >> 16) & 0xff;
        out[p + 1] = (rgb >> 8) & 0xff;
        out[p + 2] = rgb & 0xff;
        out[p + 3] = s === paintWhen ? 255 : 0;
      }
    return { bytes: encodePng(ow, oh, 4, out), mime: 'image/png' };
  }

  const cs = parseColorSpace(doc, dict.get('ColorSpace') ?? dict.get('CS'));
  const n = Math.max(1, cs.n);
  let bpc = num(doc, dict.get('BitsPerComponent') ?? dict.get('BPC'), 8);
  if (![1, 2, 4, 8, 16].includes(bpc)) bpc = 8;
  const sample = readBits(r.data, w, n, bpc);
  const maxv = Math.pow(2, bpc) - 1;
  const dec = decodeArray(doc, dict);
  const dflt = cs.decode(bpc);
  const custom = dec && dec.length >= n * 2 && dec.some((v, i) => v !== dflt[i]);
  const d = custom ? dec! : dflt;

  const colorKey = doc.array(dict.get('Mask'))?.map((x) => doc.number(x) ?? 0);
  const keyed = colorKey && colorKey.length >= n * 2 ? colorKey : undefined;

  // Alpha sources: soft mask, explicit stencil mask, or color key.
  const smask = doc.resolve(dict.get('SMask'));
  const emask = doc.resolve(dict.get('Mask'));
  const alphaAt = smask instanceof PdfStream ? softMask(doc, smask) : emask instanceof PdfStream ? stencilMask(doc, emask) : undefined;
  const hasAlpha = !!alphaAt || !!keyed;

  const gray = cs === DEVICE_GRAY;
  const channels = hasAlpha ? 4 : gray ? 1 : 3;
  const out = new Uint8Array(ow * oh * channels);

  // Lookup table for one-component spaces.
  let lut: Uint8Array | undefined;
  if (n === 1) {
    const size = 1 << Math.min(bpc, 8);
    lut = new Uint8Array(size * 3);
    for (let i = 0; i < size; i++) {
      const raw = bpc > 8 ? i * 257 : i;
      const rgb = cs.toRgb([d[0] + (raw / maxv) * (d[1] - d[0])]);
      lut[i * 3] = Math.round(rgb[0] * 255);
      lut[i * 3 + 1] = Math.round(rgb[1] * 255);
      lut[i * 3 + 2] = Math.round(rgb[2] * 255);
    }
  }
  const comps = new Array<number>(n);
  const raws = new Array<number>(n);
  const fastCmyk = cs.name === 'DeviceCMYK' && !custom;
  const fastRgb = cs.name === 'DeviceRGB' && !custom;

  for (let oy = 0; oy < oh; oy++) {
    const sy = Math.min(h - 1, oy * step);
    for (let ox = 0; ox < ow; ox++) {
      const sx = Math.min(w - 1, ox * step);
      for (let k = 0; k < n; k++) raws[k] = sample(sy, sx, k);
      let r8: number, g8: number, b8: number;
      if (lut) {
        const idx = bpc > 8 ? raws[0] >> 8 : raws[0];
        r8 = lut[idx * 3];
        g8 = lut[idx * 3 + 1];
        b8 = lut[idx * 3 + 2];
      } else if (fastRgb) {
        r8 = Math.round((raws[0] / maxv) * 255);
        g8 = Math.round((raws[1] / maxv) * 255);
        b8 = Math.round((raws[2] / maxv) * 255);
      } else if (fastCmyk) {
        const c = cmykToRgb(raws[0] / maxv, raws[1] / maxv, raws[2] / maxv, raws[3] / maxv);
        r8 = Math.round(c[0] * 255);
        g8 = Math.round(c[1] * 255);
        b8 = Math.round(c[2] * 255);
      } else {
        for (let k = 0; k < n; k++) comps[k] = d[2 * k] + (raws[k] / maxv) * (d[2 * k + 1] - d[2 * k]);
        const c = cs.toRgb(comps);
        r8 = Math.round(c[0] * 255);
        g8 = Math.round(c[1] * 255);
        b8 = Math.round(c[2] * 255);
      }
      const p = at(ox, oy) * channels;
      if (channels === 1) out[p] = r8;
      else {
        out[p] = r8;
        out[p + 1] = g8;
        out[p + 2] = b8;
        if (channels === 4) {
          let a = 255;
          if (alphaAt) a = alphaAt(sx / w, sy / h);
          if (keyed) {
            let inside = true;
            for (let k = 0; k < n; k++) if (raws[k] < keyed[2 * k] || raws[k] > keyed[2 * k + 1]) inside = false;
            if (inside) a = 0;
          }
          out[p + 3] = a;
        }
      }
    }
  }
  return { bytes: encodePng(ow, oh, channels as 1 | 3 | 4, out), mime: 'image/png' };
}

type SampleReader = (row: number, col: number, comp: number) => number;

/** Random access to raw samples of an image with `n` components of `bpc` bits, rows byte-aligned. */
function readBits(data: Uint8Array, w: number, n: number, bpc: number): SampleReader {
  const rowBytes = Math.ceil((w * n * bpc) / 8);
  if (bpc === 8) return (row, col, comp) => data[row * rowBytes + col * n + comp] ?? 0;
  if (bpc === 16) return (row, col, comp) => {
    const i = row * rowBytes + (col * n + comp) * 2;
    return ((data[i] ?? 0) << 8) | (data[i + 1] ?? 0);
  };
  return (row, col, comp) => {
    const bit = (col * n + comp) * bpc;
    const byte = data[row * rowBytes + (bit >> 3)] ?? 0;
    return (byte >> (8 - bpc - (bit & 7))) & ((1 << bpc) - 1);
  };
}

/** A soft mask as alpha (0..255) at normalized image coordinates. */
function softMask(doc: PdfDocument, mask: PdfStream): ((u: number, v: number) => number) | undefined {
  const r = decodeStream(mask, (o) => doc.resolve(o));
  if (r.remaining.length) {
    // A JPEG soft mask can't be decoded here; treat as opaque.
    return undefined;
  }
  const w = num(doc, mask.dict.get('Width'), 0);
  const h = num(doc, mask.dict.get('Height'), 0);
  if (w < 1 || h < 1) return undefined;
  let bpc = num(doc, mask.dict.get('BitsPerComponent'), 8);
  if (![1, 2, 4, 8, 16].includes(bpc)) bpc = 8;
  const sample = readBits(r.data, w, 1, bpc);
  const maxv = Math.pow(2, bpc) - 1;
  const dec = decodeArray(doc, mask.dict) ?? [0, 1];
  return (u, v) => {
    const s = sample(Math.min(h - 1, Math.floor(v * h)), Math.min(w - 1, Math.floor(u * w)), 0) / maxv;
    return Math.round(Math.min(1, Math.max(0, dec[0] + s * (dec[1] - dec[0]))) * 255);
  };
}

/** An explicit /Mask stream (a stencil): painted where the (decoded) sample is 0. */
function stencilMask(doc: PdfDocument, mask: PdfStream): ((u: number, v: number) => number) | undefined {
  const r = decodeStream(mask, (o) => doc.resolve(o));
  if (r.remaining.length) return undefined;
  const w = num(doc, mask.dict.get('Width'), 0);
  const h = num(doc, mask.dict.get('Height'), 0);
  if (w < 1 || h < 1) return undefined;
  const sample = readBits(r.data, w, 1, 1);
  const paintWhen = (decodeArray(doc, mask.dict) ?? [0, 1])[0] === 1 ? 1 : 0;
  return (u, v) => (sample(Math.min(h - 1, Math.floor(v * h)), Math.min(w - 1, Math.floor(u * w)), 0) === paintWhen ? 255 : 0);
}
