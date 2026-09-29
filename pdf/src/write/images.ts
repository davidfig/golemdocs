// Image XObjects (§8.9.5) from JPEG, PNG or raw pixels. JPEGs, and PNGs without
// transparency or interlacing, are embedded without decoding (DCTDecode; FlateDecode with the
// PNG predictor); other PNGs are decoded and split into color and alpha (SMask).

import { N, PdfDict, PdfRef, PdfStream, PdfString } from '../core/objects.ts';
import type { PdfDocument } from '../document.ts';
import { applyPredictor } from '../filters/filters.ts';
import { inflate } from '../filters/inflate.ts';

export class ImageFormatError extends Error {}

export interface PdfImage {
  readonly ref: PdfRef;
  readonly width: number;
  readonly height: number;
}

/** A plain Uint8Array view (Node Buffers' slice() shares memory). */
const plain = (b: Uint8Array): Uint8Array => (Object.getPrototypeOf(b) === Uint8Array.prototype ? b : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));

/** Embeds a JPEG or PNG, detected from its signature. */
export function embedImage(doc: PdfDocument, bytes: Uint8Array): PdfImage {
  bytes = plain(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return embedJpeg(doc, bytes);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return embedPng(doc, bytes);
  throw new ImageFormatError('unsupported image format (JPEG and PNG are supported)');
}

export function embedJpeg(doc: PdfDocument, bytes: Uint8Array): PdfImage {
  bytes = plain(bytes);
  let p = 2;
  let info: { width: number; height: number; bpc: number; components: number } | undefined;
  let adobe = false;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = bytes[p + 1];
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      p += 2;
      continue;
    }
    const len = (bytes[p + 2] << 8) | bytes[p + 3];
    if (marker === 0xee && String.fromCharCode(...bytes.subarray(p + 4, p + 9)) === 'Adobe') adobe = true;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      info = {
        bpc: bytes[p + 4],
        height: (bytes[p + 5] << 8) | bytes[p + 6],
        width: (bytes[p + 7] << 8) | bytes[p + 8],
        components: bytes[p + 9],
      };
      break;
    }
    if (marker === 0xda) break;
    p += 2 + len;
  }
  if (!info || !info.width || !info.height) throw new ImageFormatError('JPEG without a frame header');
  const cs = info.components === 1 ? 'DeviceGray' : info.components === 4 ? 'DeviceCMYK' : 'DeviceRGB';
  const dict = new PdfDict({
    Type: N('XObject'),
    Subtype: N('Image'),
    Width: info.width,
    Height: info.height,
    ColorSpace: N(cs),
    BitsPerComponent: info.bpc === 12 ? 8 : info.bpc,
    Filter: N('DCTDecode'),
  });
  // Adobe's CMYK JPEGs store inverted values.
  if (info.components === 4 && adobe) dict.set('Decode', [1, 0, 1, 0, 1, 0, 1, 0]);
  return { ref: doc.add(new PdfStream(dict, bytes)), width: info.width, height: info.height };
}

interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  palette?: Uint8Array;
  trns?: Uint8Array;
  idat: Uint8Array;
}

function readPng(bytes: Uint8Array): PngInfo {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8;
  const idat: Uint8Array[] = [];
  let info: Partial<PngInfo> = {};
  while (p + 8 <= bytes.length) {
    const len = v.getUint32(p);
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    const data = bytes.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      info = { width: v.getUint32(p + 8), height: v.getUint32(p + 12), bitDepth: bytes[p + 16], colorType: bytes[p + 17], interlace: bytes[p + 20] };
    } else if (type === 'PLTE') info.palette = data;
    else if (type === 'tRNS') info.trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!info.width || !info.height) throw new ImageFormatError('PNG without IHDR');
  const total = idat.reduce((n, d) => n + d.length, 0);
  const all = new Uint8Array(total);
  let o = 0;
  for (const d of idat) {
    all.set(d, o);
    o += d.length;
  }
  return { ...(info as PngInfo), idat: all };
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function embedPng(doc: PdfDocument, bytes: Uint8Array): PdfImage {
  const png = readPng(plain(bytes));
  const { width, height, bitDepth: bd, colorType } = png;
  const channels = CHANNELS[colorType];
  if (!channels) throw new ImageFormatError(`unsupported PNG color type ${colorType}`);
  const hasAlpha = colorType === 4 || colorType === 6;
  const colorSpace = (): PdfDict['entries'] extends Map<string, infer V> ? V : never => {
    if (colorType === 3) {
      if (!png.palette) throw new ImageFormatError('indexed PNG without a palette');
      return [N('Indexed'), N('DeviceRGB'), png.palette.length / 3 - 1, new PdfString(png.palette.slice(), true)];
    }
    return N(colorType === 0 || colorType === 4 ? 'DeviceGray' : 'DeviceRGB');
  };
  const base = { Type: N('XObject'), Subtype: N('Image'), Width: width, Height: height };

  // Fast path: the IDAT stream is already a valid FlateDecode stream with PNG predictors.
  if (!png.interlace && !hasAlpha && !(colorType === 3 && png.trns)) {
    const dict = new PdfDict({
      ...base,
      ColorSpace: colorSpace(),
      BitsPerComponent: bd,
      Filter: N('FlateDecode'),
      DecodeParms: new PdfDict({ Predictor: 15, Colors: channels, BitsPerComponent: bd, Columns: width }),
    });
    if (png.trns && (colorType === 0 || colorType === 2)) {
      // A single transparent color: a color-key mask.
      const key: number[] = [];
      for (let i = 0; i + 1 < png.trns.length; i += 2) {
        const val = (png.trns[i] << 8) | png.trns[i + 1];
        key.push(val, val);
      }
      dict.set('Mask', key);
    }
    return { ref: doc.add(new PdfStream(dict, png.idat)), width, height };
  }

  // Decode to samples, then split color from alpha.
  const samples = decodePngSamples(png, channels);
  const out16 = bd === 16;
  const bytesPer = out16 ? 2 : 1;
  const colorChannels = hasAlpha ? channels - 1 : channels;
  const n = width * height;
  const color = new Uint8Array(n * colorChannels * bytesPer);
  const alpha = hasAlpha || (colorType === 3 && png.trns) ? new Uint8Array(n * bytesPer) : undefined;
  const scale = bd < 8 && colorType !== 3 ? 255 / ((1 << bd) - 1) : 1;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < colorChannels; c++) {
      const s = samples[i * channels + c] * scale;
      if (out16) {
        color[(i * colorChannels + c) * 2] = s >> 8;
        color[(i * colorChannels + c) * 2 + 1] = s & 0xff;
      } else color[i * colorChannels + c] = s;
    }
    if (alpha) {
      if (colorType === 3) alpha[i] = png.trns![samples[i]] ?? 255;
      else if (out16) {
        const s = samples[i * channels + channels - 1];
        alpha[i * 2] = s >> 8;
        alpha[i * 2 + 1] = s & 0xff;
      } else alpha[i] = samples[i * channels + channels - 1];
    }
  }
  const dict = new PdfDict({ ...base, ColorSpace: colorSpace(), BitsPerComponent: out16 ? 16 : 8 });
  if (png.trns && (colorType === 0 || colorType === 2)) {
    // Interlaced, with a transparent color: a color-key mask in the (rescaled) sample values.
    const key: number[] = [];
    for (let i = 0; i + 1 < png.trns.length; i += 2) {
      const val = Math.round(((png.trns[i] << 8) | png.trns[i + 1]) * scale);
      key.push(val, val);
    }
    dict.set('Mask', key);
  }
  if (alpha) {
    const smask = new PdfDict({ ...base, ColorSpace: N('DeviceGray'), BitsPerComponent: out16 ? 16 : 8 });
    dict.set('SMask', doc.add(new PdfStream(smask, alpha)));
  }
  return { ref: doc.add(new PdfStream(dict, color)), width, height };
}

/** Inflates and unfilters a PNG (including Adam7 interlacing) to one sample per array slot. */
function decodePngSamples(png: PngInfo, channels: number): Uint16Array {
  const { width, height, bitDepth: bd } = png;
  const raw = inflate(png.idat, width * height * channels * Math.ceil(bd / 8) + height).data;
  const out = new Uint16Array(width * height * channels);
  const passes = png.interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  let offset = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * channels * bd) / 8);
    const len = (rowBytes + 1) * ph;
    const rows = applyPredictor(raw.subarray(offset, offset + len), 15, channels, bd, pw);
    offset += len;
    for (let y = 0; y < ph; y++) {
      const row = rows.subarray(y * rowBytes, (y + 1) * rowBytes);
      for (let x = 0; x < pw; x++) {
        const dst = ((y0 + y * dy) * width + x0 + x * dx) * channels;
        for (let c = 0; c < channels; c++) {
          const k = x * channels + c;
          let s: number;
          if (bd === 8) s = row[k];
          else if (bd === 16) s = (row[k * 2] << 8) | row[k * 2 + 1];
          else s = (row[(k * bd) >> 3] >> (8 - bd - ((k * bd) & 7))) & ((1 << bd) - 1);
          out[dst + c] = s;
        }
      }
    }
  }
  return out;
}

/** Embeds raw 8-bit pixels: 1 (gray), 3 (RGB) or 4 (RGBA, alpha becomes a soft mask) channels. */
export function embedPixels(doc: PdfDocument, pixels: { width: number; height: number; channels: 1 | 3 | 4; data: Uint8Array }): PdfImage {
  const { width, height, channels, data } = pixels;
  const n = width * height;
  if (data.length < n * channels) throw new ImageFormatError('pixel data too short');
  const base = { Type: N('XObject'), Subtype: N('Image'), Width: width, Height: height, BitsPerComponent: 8 };
  if (channels !== 4) {
    const dict = new PdfDict({ ...base, ColorSpace: N(channels === 1 ? 'DeviceGray' : 'DeviceRGB') });
    return { ref: doc.add(new PdfStream(dict, data.subarray(0, n * channels))), width, height };
  }
  const rgb = new Uint8Array(n * 3);
  const alpha = new Uint8Array(n);
  let opaque = true;
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = data[i * 4];
    rgb[i * 3 + 1] = data[i * 4 + 1];
    rgb[i * 3 + 2] = data[i * 4 + 2];
    alpha[i] = data[i * 4 + 3];
    if (alpha[i] !== 255) opaque = false;
  }
  const dict = new PdfDict({ ...base, ColorSpace: N('DeviceRGB') });
  if (!opaque) dict.set('SMask', doc.add(new PdfStream(new PdfDict({ ...base, ColorSpace: N('DeviceGray') }), alpha)));
  return { ref: doc.add(new PdfStream(dict, rgb)), width, height };
}
