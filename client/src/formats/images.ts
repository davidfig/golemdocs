// Pictures for the formats that carry them as separate files or embedded data (HTML data: URIs,
// EPUB, MHTML): recognising a picture's type and pixel size from its bytes, data: URIs, and
// gathering a document's pictures for writing.

import type { Block, Inline, WordDocument } from '@golemdocs/docx';

export type ImageType = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp';

export interface ImageData {
  bytes: Uint8Array;
  type: ImageType;
  /** Pixel size as displayed (a JPEG's rotation tag applied), 0 when the header couldn't be read. */
  width: number;
  height: number;
}

export const MIME: Record<ImageType, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

/** The name a picture called `name` is kept under (see `toPng`): GIF, BMP and SVG open, and are saved, as PNG. */
export function keptPictureName(name: string): string {
  return /\.(gif|bmp|svg)$/i.test(name) ? name.replace(/\.[^.]*$/, '.png') : name;
}

/** The picture a byte string holds: its type by signature, and its pixel size. Null for anything else. */
export function sniffImage(bytes: Uint8Array): ImageData | null {
  const u16be = (i: number) => (bytes[i] << 8) | bytes[i + 1];
  const u16le = (i: number) => bytes[i] | (bytes[i + 1] << 8);
  const u32be = (i: number) => ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
  const ascii = (i: number, s: string) => [...s].every((c, k) => bytes[i + k] === c.charCodeAt(0));
  if (bytes.length < 12) return null;
  if (ascii(1, 'PNG') && bytes[0] === 0x89) return { bytes, type: 'png', width: u32be(16), height: u32be(20) };
  if (ascii(0, 'GIF8')) return { bytes, type: 'gif', width: u16le(6), height: u16le(8) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Walk the segments to the start-of-frame marker, which holds the size.
    let i = 2;
    let orientation = 1;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1];
      if (marker === 0xe1) orientation = exifOrientation(bytes, i + 4, i + 2 + u16be(i + 2)) || orientation;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const width = u16be(i + 7);
        const height = u16be(i + 5);
        // Orientations 5-8 turn the picture a quarter turn: browsers show it that way, so its size is swapped.
        return orientation >= 5 ? { bytes, type: 'jpeg', width: height, height: width } : { bytes, type: 'jpeg', width, height };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) i += marker === 0xff ? 1 : 2;
      else i += 2 + u16be(i + 2);
    }
    return { bytes, type: 'jpeg', width: 0, height: 0 };
  }
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    let width = 0;
    let height = 0;
    if (ascii(12, 'VP8 ')) {
      width = u16le(26) & 0x3fff;
      height = u16le(28) & 0x3fff;
    } else if (ascii(12, 'VP8L')) {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    } else if (ascii(12, 'VP8X')) {
      width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    }
    return { bytes, type: 'webp', width, height };
  }
  // "BM", then (after the file header) the size of a known info header: text that starts "BM" is not a bitmap.
  if (bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.length >= 26) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const info = view.getUint32(14, true);
    // The oldest (OS/2) header has 16-bit sizes; the rest 32-bit, the height negative for a top-down picture.
    if (info === 12) return { bytes, type: 'bmp', width: view.getUint16(18, true), height: view.getUint16(20, true) };
    if (BMP_INFO_SIZES.includes(info)) return { bytes, type: 'bmp', width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
  }
  return null;
}

const BMP_INFO_SIZES = [40, 52, 56, 64, 108, 124];

/** The rotation tag (1-8) in a JPEG's Exif data, which starts at `from` and ends before `end`; 0 when there is none. */
function exifOrientation(bytes: Uint8Array, from: number, end: number): number {
  const ascii = (i: number, text: string) => [...text].every((c, k) => bytes[i + k] === c.charCodeAt(0));
  if (!ascii(from, 'Exif\0\0')) return 0;
  const tiff = from + 6;
  const little = bytes[tiff] === 0x49;
  const u16 = (i: number) => (little ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]);
  const u32 = (i: number) => (little ? (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0 : ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0);
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 0;
  const count = u16(ifd);
  for (let k = 0; k < count && ifd + 2 + k * 12 + 12 <= end; k++) {
    const entry = ifd + 2 + k * 12;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 0;
    }
  }
  return 0;
}

/** The bytes of a `data:` URI, or null when it isn't one (or is malformed). */
export function decodeDataUri(uri: string): Uint8Array | null {
  const m = /^data:([^,]*?)(;base64)?,([\s\S]*)$/i.exec(uri.trim());
  if (!m) return null;
  try {
    if (m[2]) return Uint8Array.from(atob(m[3].replace(/\s/g, '')), (c) => c.charCodeAt(0));
    // Percent escapes are bytes (not UTF-8 text, which binary data isn't); the rest is text, as UTF-8.
    const encoder = new TextEncoder();
    const parts = m[3].split(/(%[0-9a-f]{2})/i);
    const chunks = parts.map((part, i) => (i % 2 ? Uint8Array.of(parseInt(part.slice(1), 16)) : encoder.encode(part)));
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  } catch {
    return null;
  }
}

export function toDataUri(image: ImageData): string {
  let binary = '';
  for (let i = 0; i < image.bytes.length; i += 8192) binary += String.fromCharCode(...image.bytes.subarray(i, i + 8192));
  return `data:${MIME[image.type]};base64,${btoa(binary)}`;
}

/** Every picture the document draws (of the types above), by package part. Unreadable or unknown ones are left out. */
export async function collectImages(doc: WordDocument): Promise<Map<string, ImageData>> {
  const found = new Map<string, ImageData>();
  const inlines = async (list: readonly Inline[]): Promise<void> => {
    for (const inline of list) {
      if (inline.kind === 'run') {
        for (const item of inline.content) {
          if (item.kind !== 'drawing' || !item.image || found.has(item.image)) continue;
          const image = sniffImage(await doc.media(item.image).catch(() => new Uint8Array(0)));
          if (image) found.set(item.image, image);
        }
      } else if (inline.kind === 'hyperlink' || inline.kind === 'wrapper') await inlines(inline.children);
    }
  };
  const blocks = async (list: readonly Block[]): Promise<void> => {
    for (const block of list) {
      if (block.kind === 'paragraph') await inlines(block.children);
      else if (block.kind === 'wrapper') await blocks(block.children);
      else if (block.kind === 'table') {
        for (const row of block.rows) if (row.kind === 'row') for (const cell of row.cells) if (cell.kind === 'cell') await blocks(cell.children);
      }
    }
  };
  await blocks(doc.body);
  return found;
}
