// Stream filters (§7.4). Decoding is synchronous and hand-written; image codecs (DCT, JPX,
// CCITT, JBIG2) are left encoded for whoever consumes the image. Encoding uses the platform's
// Compression Streams API for Flate, and is only needed when saving.

import { PdfDict, PdfName, PdfStream, type PdfObject } from '../core/objects.ts';
import { inflate } from './inflate.ts';

export class FilterError extends Error {}

/** Inline-image abbreviations (§8.9.7). */
const ABBREVIATIONS: Record<string, string> = {
  AHx: 'ASCIIHexDecode',
  A85: 'ASCII85Decode',
  LZW: 'LZWDecode',
  Fl: 'FlateDecode',
  RL: 'RunLengthDecode',
  CCF: 'CCITTFaxDecode',
  DCT: 'DCTDecode',
};

/** Filters whose output is an image format rather than raw samples. */
export const IMAGE_FILTERS = new Set(['DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode']);

export interface FilterStep {
  name: string;
  parms?: PdfDict;
}

type Resolve = (o: PdfObject | undefined) => PdfObject | undefined;
const identity: Resolve = (o) => o;

/** The stream's filter chain, with DecodeParms paired up and abbreviations expanded. */
export function filterChain(dict: PdfDict, resolve: Resolve = identity): FilterStep[] {
  const f = resolve(dict.get('Filter') ?? dict.get('F'));
  const p = resolve(dict.get('DecodeParms') ?? dict.get('DP'));
  const names = Array.isArray(f) ? f.map(resolve) : f === undefined ? [] : [f];
  const parms = Array.isArray(p) ? p.map(resolve) : [p];
  const steps: FilterStep[] = [];
  names.forEach((n, i) => {
    if (!(n instanceof PdfName)) return;
    const parm = parms[i];
    steps.push({ name: ABBREVIATIONS[n.name] ?? n.name, parms: parm instanceof PdfDict ? parm : undefined });
  });
  return steps;
}

export interface DecodeResult {
  data: Uint8Array;
  /** Filters not applied (image codecs, or unsupported), outermost first. */
  remaining: FilterStep[];
  /** Set when a filter hit damaged data; `data` holds what could be decoded. */
  error?: string;
}

/**
 * Applies the stream's filters, stopping before an image codec (or an unknown filter).
 * `resolve` follows indirect references in /Filter and /DecodeParms.
 */
export function decodeStream(stream: PdfStream, resolve: Resolve = identity): DecodeResult {
  return decodeData(stream.data, filterChain(stream.dict, resolve), resolve);
}

export function decodeData(input: Uint8Array, chain: FilterStep[], resolve: Resolve = identity): DecodeResult {
  let data = input;
  let error: string | undefined;
  for (let i = 0; i < chain.length; i++) {
    const { name, parms } = chain[i];
    const num = (key: string, fallback: number): number => {
      const v = resolve(parms?.get(key));
      return typeof v === 'number' ? v : fallback;
    };
    switch (name) {
      case 'FlateDecode': {
        const r = inflate(data);
        data = r.data;
        error ??= r.error;
        data = applyPredictor(data, num('Predictor', 1), num('Colors', 1), num('BitsPerComponent', 8), num('Columns', 1));
        break;
      }
      case 'LZWDecode':
        data = lzwDecode(data, num('EarlyChange', 1));
        data = applyPredictor(data, num('Predictor', 1), num('Colors', 1), num('BitsPerComponent', 8), num('Columns', 1));
        break;
      case 'ASCIIHexDecode':
        data = asciiHexDecode(data);
        break;
      case 'ASCII85Decode':
        data = ascii85Decode(data);
        break;
      case 'RunLengthDecode':
        data = runLengthDecode(data);
        break;
      case 'Crypt': {
        // Only the Identity crypt filter reaches here; the document decrypts everything else.
        const cf = parms?.get('Name');
        if (cf instanceof PdfName && cf.name !== 'Identity') return { data, remaining: chain.slice(i), error };
        break;
      }
      default:
        return { data, remaining: chain.slice(i), error };
    }
  }
  return { data, remaining: [], error };
}

// --- predictors (§7.4.4.4) ---------------------------------------------------------------

export function applyPredictor(data: Uint8Array, predictor: number, colors: number, bpc: number, columns: number): Uint8Array {
  if (predictor <= 1) return data;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) return tiffPredictor(data, colors, bpc, rowBytes);
  // PNG predictors: every row starts with its own filter type byte.
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  let prev = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r++) {
    const src = r * (rowBytes + 1);
    const type = data[src];
    const row = out.subarray(r * rowBytes, (r + 1) * rowBytes);
    const line = data.subarray(src + 1, src + 1 + rowBytes);
    switch (type) {
      case 0:
        row.set(line);
        break;
      case 1:
        for (let i = 0; i < rowBytes; i++) row[i] = line[i] + (i >= bpp ? row[i - bpp] : 0);
        break;
      case 2:
        for (let i = 0; i < rowBytes; i++) row[i] = line[i] + prev[i];
        break;
      case 3:
        for (let i = 0; i < rowBytes; i++) row[i] = line[i] + (((i >= bpp ? row[i - bpp] : 0) + prev[i]) >> 1);
        break;
      case 4:
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? row[i - bpp] : 0;
          const b = prev[i];
          const c = i >= bpp ? prev[i - bpp] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          row[i] = line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        break;
      default:
        row.set(line); // unknown filter type: pass through
    }
    prev = row;
  }
  return out;
}

function tiffPredictor(data: Uint8Array, colors: number, bpc: number, rowBytes: number): Uint8Array {
  const out = new Uint8Array(data); // a copy even if data is a Node Buffer
  const rows = Math.floor(out.length / rowBytes);
  for (let r = 0; r < rows; r++) {
    const row = out.subarray(r * rowBytes, (r + 1) * rowBytes);
    if (bpc === 8) {
      for (let i = colors; i < rowBytes; i++) row[i] = (row[i] + row[i - colors]) & 0xff;
    } else if (bpc === 16) {
      for (let i = colors * 2; i + 1 < rowBytes; i += 2) {
        const v = ((row[i] << 8) | row[i + 1]) + ((row[i - colors * 2] << 8) | row[i - colors * 2 + 1]);
        row[i] = (v >> 8) & 0xff;
        row[i + 1] = v & 0xff;
      }
    } else {
      // Sub-byte samples: unpack, accumulate per component, repack.
      const samples = Math.floor((rowBytes * 8) / bpc);
      const mask = (1 << bpc) - 1;
      const get = (k: number) => (row[(k * bpc) >> 3] >> (8 - bpc - ((k * bpc) & 7))) & mask;
      const values = new Uint16Array(samples);
      for (let k = 0; k < samples; k++) values[k] = (get(k) + (k >= colors ? values[k - colors] : 0)) & mask;
      row.fill(0);
      for (let k = 0; k < samples; k++) row[(k * bpc) >> 3] |= values[k] << (8 - bpc - ((k * bpc) & 7));
    }
  }
  return out;
}

// --- simple filters ------------------------------------------------------------------------

export function asciiHexDecode(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / 2));
  let n = 0;
  let hi = -1;
  for (const c of data) {
    if (c === 0x3e) break; // '>' EOD
    const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else {
      out[n++] = (hi << 4) | v;
      hi = -1;
    }
  }
  if (hi >= 0) out[n++] = hi << 4;
  return out.slice(0, n);
}

export function ascii85Decode(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil((data.length * 4) / 5) + 4);
  let n = 0;
  const group = [0, 0, 0, 0, 0];
  let g = 0;
  let i = 0;
  // Skip an optional "<~" prefix.
  while (i < data.length && data[i] <= 0x20) i++;
  if (data[i] === 0x3c && data[i + 1] === 0x7e) i += 2;
  for (; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break; // '~>' EOD
    if (c <= 0x20) continue;
    if (c === 0x7a && g === 0) {
      // 'z' = four zero bytes
      out.fill(0, n, n + 4);
      n += 4;
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    group[g++] = c - 0x21;
    if (g === 5) {
      const v = (((group[0] * 85 + group[1]) * 85 + group[2]) * 85 + group[3]) * 85 + group[4];
      out[n++] = (v >>> 24) & 0xff;
      out[n++] = (v >>> 16) & 0xff;
      out[n++] = (v >>> 8) & 0xff;
      out[n++] = v & 0xff;
      g = 0;
    }
  }
  if (g > 1) {
    for (let k = g; k < 5; k++) group[k] = 84;
    const v = (((group[0] * 85 + group[1]) * 85 + group[2]) * 85 + group[3]) * 85 + group[4];
    for (let k = 0; k < g - 1; k++) out[n++] = (v >>> (24 - k * 8)) & 0xff;
  }
  return out.slice(0, n);
}

export function runLengthDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; ) {
    const len = data[i++];
    if (len === 128) break;
    if (len < 128) {
      for (let k = 0; k <= len && i < data.length; k++) out.push(data[i++]);
    } else {
      const b = data[i++];
      for (let k = 0; k < 257 - len; k++) out.push(b);
    }
  }
  return Uint8Array.from(out);
}

export function lzwDecode(data: Uint8Array, earlyChange = 1): Uint8Array {
  const out: number[] = [];
  // Dictionary entries as (prefix code, last byte, length); first byte cached for speed.
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) {
    prefix[i] = -1;
    suffix[i] = first[i] = i;
    length[i] = 1;
  }
  let next = 258;
  let codeLen = 9;
  let prev = -1;
  let bitBuf = 0;
  let bitCount = 0;
  const stack = new Uint8Array(4096);
  for (let i = 0; ; ) {
    while (bitCount < codeLen && i < data.length) {
      bitBuf = ((bitBuf << 8) | data[i++]) >>> 0;
      bitCount += 8;
    }
    if (bitCount < codeLen) break;
    const code = (bitBuf >>> (bitCount - codeLen)) & ((1 << codeLen) - 1);
    bitCount -= codeLen;
    bitBuf &= (1 << bitCount) - 1;
    if (code === 256) {
      next = 258;
      codeLen = 9;
      prev = -1;
      continue;
    }
    if (code === 257) break;
    let entry = code;
    let firstByte: number;
    if (code < next) firstByte = first[code];
    else if (code === next && prev >= 0) firstByte = first[prev];
    else break; // corrupt
    if (prev >= 0 && next < 4096) {
      prefix[next] = prev;
      suffix[next] = code < next ? first[code] : firstByte;
      first[next] = first[prev];
      length[next] = length[prev] + 1;
      next++;
    }
    // Emit entry's bytes (reversed through the stack).
    let sp = 0;
    for (let e = entry; e >= 0; e = prefix[e]) stack[sp++] = suffix[e];
    while (sp) out.push(stack[--sp]);
    prev = code;
    if (next + earlyChange >= 1 << codeLen && codeLen < 12) codeLen++;
  }
  return Uint8Array.from(out);
}

// --- encoding --------------------------------------------------------------------------------

type ByteTransform = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

/** zlib-wrapped DEFLATE, as FlateDecode expects. */
export async function flateEncode(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate') as unknown as ByteTransform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** PNG "Up" prediction of fixed-width rows, which helps Flate on xref streams and images. */
export function pngUpEncode(data: Uint8Array, rowBytes: number): Uint8Array {
  const rows = Math.ceil(data.length / rowBytes);
  const out = new Uint8Array(rows * (rowBytes + 1));
  for (let r = 0; r < rows; r++) {
    const o = r * (rowBytes + 1);
    out[o] = 2;
    for (let i = 0; i < rowBytes; i++) {
      const k = r * rowBytes + i;
      out[o + 1 + i] = (data[k] ?? 0) - (r ? data[k - rowBytes] : 0);
    }
  }
  return out;
}
