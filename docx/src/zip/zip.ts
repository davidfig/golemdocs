// SPDX-License-Identifier: MIT
// Minimal ZIP container support for OOXML packages: stored and deflated entries, UTF-8 (or
// code page 437) names, no encryption. ZIP64 is read and written when needed (a spreadsheet's sheet can inflate past 4GB).
//
// Reading goes through the central directory and inflates lazily, so parts nobody asks for
// are never decompressed. Writing can reuse an entry's compressed bytes verbatim, so
// untouched parts (media, themes, ...) round-trip without recompression.

import { crc32 } from './crc32.ts';
import { deflateRaw, inflateRaw } from './deflate.ts';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const STORED = 0;
const DEFLATED = 8;
const UTF8_FLAG = 1 << 11;

export class ZipError extends Error {}

export class ZipEntry {
  constructor(
    readonly name: string,
    readonly method: number,
    readonly crc: number,
    readonly size: number,
    /** The entry's bytes as stored in the archive (compressed if method is DEFLATED). */
    readonly raw: Uint8Array,
  ) {}

  private data: Promise<Uint8Array> | null = null;

  /** Uncompressed contents. Inflated once, on first request. */
  read(): Promise<Uint8Array> {
    if (!this.data) {
      this.data = (async () => {
        let out: Uint8Array;
        try {
          out = this.method === STORED ? this.raw : await inflateRaw(this.raw, this.size);
        } catch (e) {
          throw new ZipError(`${this.name}: corrupt compressed data (${(e as Error).message})`);
        }
        if (out.length !== this.size) throw new ZipError(`${this.name}: size mismatch (${out.length} != ${this.size})`);
        if (crc32(out) !== this.crc) throw new ZipError(`${this.name}: CRC mismatch (corrupt file)`);
        return out;
      })();
    }
    return this.data;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.read());
  }

  /**
   * Uncompressed contents in pieces, for parts too big to hold whole (a spreadsheet's sheet can inflate to a gigabyte).
   * Nothing is kept: each call inflates again. The size and CRC are checked as the last piece goes by.
   */
  async *stream(): AsyncGenerator<Uint8Array> {
    if (this.method === STORED) {
      if (crc32(this.raw) !== this.crc) throw new ZipError(`${this.name}: CRC mismatch (corrupt file)`);
      yield this.raw;
      return;
    }
    const reader = new Blob([this.raw as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();
    let length = 0;
    let crc = 0;
    try {
      for (;;) {
        let piece: ReadableStreamReadResult<Uint8Array>;
        try {
          piece = await reader.read();
        } catch (e) {
          throw new ZipError(`${this.name}: corrupt compressed data (${(e as Error).message})`);
        }
        if (piece.done) break;
        length += piece.value.length;
        if (length > this.size) throw new ZipError(`${this.name}: inflates past its declared size of ${this.size} bytes`);
        crc = crc32(piece.value, crc);
        yield piece.value;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    if (length !== this.size) throw new ZipError(`${this.name}: size mismatch (${length} != ${this.size})`);
    if (crc !== this.crc) throw new ZipError(`${this.name}: CRC mismatch (corrupt file)`);
  }
}

/** Characters 0x80-0xFF of code page 437, which ZIP names are in when they don't say they are UTF-8. */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

/**
 * An entry's name. Flagged as UTF-8, it is; otherwise it is UTF-8 if it reads as that (macOS and
 * many tools write UTF-8 without saying so), and else code page 437 (Windows' own ZIP folders).
 */
function decodeName(bytes: Uint8Array, flags: number): string {
  if (flags & UTF8_FLAG || bytes.every((b) => b < 0x80)) return new TextDecoder().decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return Array.from(bytes, (b) => (b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80])).join('');
  }
}

export class ZipArchive {
  readonly entries = new Map<string, ZipEntry>();
  /** Entries that can't be read (encrypted, compressed in a way not supported, damaged), when read with `lenient`. */
  readonly unreadable: string[] = [];

  /**
   * Reads a ZIP's directory. `lenient`: an entry that can't be read is listed in `unreadable` rather
   * than failing the whole archive (an import of someone's ZIP, not a document's own package).
   */
  static read(input: Uint8Array, options: { lenient?: boolean } = {}): ZipArchive {
    if (input.length >= 8 && input[0] === 0xd0 && input[1] === 0xcf && input[2] === 0x11 && input[3] === 0xe0) {
      throw new ZipError('this is an encrypted document or a legacy binary .doc, not a .docx package');
    }
    try {
      return ZipArchive.parse(input, options.lenient ?? false);
    } catch (e) {
      if (e instanceof ZipError) throw e;
      throw new ZipError(`corrupt ZIP file (${(e as Error).message})`);
    }
  }

  private static parse(input: Uint8Array, lenient: boolean): ZipArchive {
    // Plain Uint8Array view (not a Node Buffer), so entry data behaves the same everywhere.
    const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // The end-of-central-directory record is at the end, before an optional comment (<64KB).
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
      if (view.getUint32(i, true) === END_OF_CENTRAL_DIRECTORY) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError('not a ZIP file (no end of central directory)');

    let count = view.getUint16(eocd + 10, true);
    let directoryOffset = view.getUint32(eocd + 16, true);
    // ZIP64 (Excel writes it for big parts): a locator just before the record points at a 64-bit record with the real numbers.
    if (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR) {
      const record = Number(view.getBigUint64(eocd - 20 + 8, true));
      if (record + 56 > bytes.length || view.getUint32(record, true) !== ZIP64_END) throw new ZipError('corrupt ZIP64 end of central directory');
      count = Number(view.getBigUint64(record + 32, true));
      directoryOffset = Number(view.getBigUint64(record + 48, true));
    } else if (count === 0xffff || directoryOffset === 0xffffffff) {
      throw new ZipError('corrupt ZIP64 archive (no locator)');
    }

    const archive = new ZipArchive();
    let p = directoryOffset;
    for (let i = 0; i < count; i++) {
      if (view.getUint32(p, true) !== CENTRAL_HEADER) throw new ZipError('corrupt central directory');
      const flags = view.getUint16(p + 8, true);
      const method = view.getUint16(p + 10, true);
      const crc = view.getUint32(p + 16, true);
      let compressedSize = view.getUint32(p + 20, true);
      let size = view.getUint32(p + 24, true);
      const nameLength = view.getUint16(p + 28, true);
      const extraLength = view.getUint16(p + 30, true);
      const commentLength = view.getUint16(p + 32, true);
      let localOffset = view.getUint32(p + 42, true);
      const name = decodeName(bytes.subarray(p + 46, p + 46 + nameLength), flags);
      if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
        // The 64-bit values are in the ZIP64 extra field, in this order, for those whose 32-bit field is all ones.
        for (let e = p + 46 + nameLength; e + 4 <= p + 46 + nameLength + extraLength; ) {
          const id = view.getUint16(e, true);
          const length = view.getUint16(e + 2, true);
          if (id === 0x0001) {
            let at = e + 4;
            const next = () => Number(view.getBigUint64((at += 8) - 8, true));
            if (size === 0xffffffff) size = next();
            if (compressedSize === 0xffffffff) compressedSize = next();
            if (localOffset === 0xffffffff) localOffset = next();
            break;
          }
          e += 4 + length;
        }
      }
      p += 46 + nameLength + extraLength + commentLength;

      const problem =
        flags & 1
          ? 'encrypted (password-protected) documents are not supported'
          : method !== STORED && method !== DEFLATED
            ? `${name}: unsupported compression method ${method}`
            : localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL_HEADER
              ? `${name}: corrupt local header`
              : null;
      if (problem) {
        if (!lenient) throw new ZipError(problem);
        if (!name.endsWith('/')) archive.unreadable.push(name);
        continue;
      }
      const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
      if (name.endsWith('/')) continue; // directory entry
      archive.entries.set(name, new ZipEntry(name, method, crc, size, bytes.subarray(dataStart, dataStart + compressedSize)));
    }
    return archive;
  }
}

/** An entry to write: new contents, an existing entry copied without recompression, or contents already deflated (raw DEFLATE, with their CRC and size). */
export type ZipInput =
  | { name: string; data: Uint8Array; compress?: boolean }
  | { name: string; entry: ZipEntry }
  | { name: string; deflated: Uint8Array; crc: number; size: number };

const MAX32 = 0xffffffff;

/** Builds a ZIP archive. Entries are written in the given order; ZIP64 records are added only where a size, an offset or the count needs them. */
export async function writeZip(inputs: ZipInput[], options: { zip64?: boolean } = {}): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const prepared = await Promise.all(
    inputs.map(async (input) => {
      const name = encoder.encode(input.name);
      if ('entry' in input) {
        const { entry } = input;
        return { name, method: entry.method, crc: entry.crc, size: entry.size, raw: entry.raw };
      }
      if ('deflated' in input) return { name, method: DEFLATED, crc: input.crc, size: input.size, raw: input.deflated };
      const compress = input.compress ?? true;
      const raw = compress ? await deflateRaw(input.data) : input.data;
      return { name, method: compress ? DEFLATED : STORED, crc: crc32(input.data), size: input.data.length, raw };
    }),
  );

  // Sizes first, so the buffer is allocated once: a local header has a ZIP64 extra (20 bytes) when a size is too big for 32 bits.
  // `zip64` forces the 64-bit records for every entry (tests: nothing small needs them).
  const big = (e: (typeof prepared)[number]) => !!options.zip64 || e.size >= MAX32 || e.raw.length >= MAX32;
  let p = 0;
  const offsets: number[] = [];
  for (const e of prepared) {
    offsets.push(p);
    p += 30 + e.name.length + (big(e) ? 20 : 0) + e.raw.length;
  }
  const directoryStart = p;
  const centralExtra = prepared.map((e, i) => (big(e) ? 16 : 0) + (offsets[i] >= MAX32 ? 8 : 0));
  for (const [i, e] of prepared.entries()) p += 46 + e.name.length + (centralExtra[i] ? 4 + centralExtra[i] : 0);
  const directoryEnd = p;
  const zip64 = !!options.zip64 || prepared.length > 0xffff || directoryStart >= MAX32 || directoryEnd - directoryStart >= MAX32;
  const out = new Uint8Array(directoryEnd + (zip64 ? 56 + 20 : 0) + 22);
  const view = new DataView(out.buffer);

  // DOS timestamp 1980-01-01 00:00, like Word: output depends only on contents.
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;

  p = 0;
  for (const e of prepared) {
    const wide = big(e);
    view.setUint32(p, LOCAL_HEADER, true);
    view.setUint16(p + 4, wide ? 45 : 20, true); // version needed: 4.5 for ZIP64, else 2.0
    view.setUint16(p + 6, UTF8_FLAG, true);
    view.setUint16(p + 8, e.method, true);
    view.setUint16(p + 10, DOS_TIME, true);
    view.setUint16(p + 12, DOS_DATE, true);
    view.setUint32(p + 14, e.crc, true);
    view.setUint32(p + 18, wide ? MAX32 : e.raw.length, true);
    view.setUint32(p + 22, wide ? MAX32 : e.size, true);
    view.setUint16(p + 26, e.name.length, true);
    view.setUint16(p + 28, wide ? 20 : 0, true);
    out.set(e.name, p + 30);
    p += 30 + e.name.length;
    if (wide) {
      view.setUint16(p, 0x0001, true);
      view.setUint16(p + 2, 16, true);
      view.setBigUint64(p + 4, BigInt(e.size), true);
      view.setBigUint64(p + 12, BigInt(e.raw.length), true);
      p += 20;
    }
    out.set(e.raw, p);
    p += e.raw.length;
  }

  prepared.forEach((e, i) => {
    const wide = big(e);
    const farOffset = offsets[i] >= MAX32;
    view.setUint32(p, CENTRAL_HEADER, true);
    view.setUint16(p + 4, wide || farOffset ? 45 : 20, true); // version made by
    view.setUint16(p + 6, wide || farOffset ? 45 : 20, true); // version needed
    view.setUint16(p + 8, UTF8_FLAG, true);
    view.setUint16(p + 10, e.method, true);
    view.setUint16(p + 12, DOS_TIME, true);
    view.setUint16(p + 14, DOS_DATE, true);
    view.setUint32(p + 16, e.crc, true);
    view.setUint32(p + 20, wide ? MAX32 : e.raw.length, true);
    view.setUint32(p + 24, wide ? MAX32 : e.size, true);
    view.setUint16(p + 28, e.name.length, true);
    view.setUint16(p + 30, centralExtra[i] ? 4 + centralExtra[i] : 0, true);
    // comment length, disk number, internal attrs: 0
    view.setUint32(p + 38, 0, true); // external attrs
    view.setUint32(p + 42, farOffset ? MAX32 : offsets[i], true);
    out.set(e.name, p + 46);
    p += 46 + e.name.length;
    if (centralExtra[i]) {
      view.setUint16(p, 0x0001, true);
      view.setUint16(p + 2, centralExtra[i], true);
      let at = p + 4;
      if (wide) {
        view.setBigUint64(at, BigInt(e.size), true);
        view.setBigUint64(at + 8, BigInt(e.raw.length), true);
        at += 16;
      }
      if (farOffset) view.setBigUint64(at, BigInt(offsets[i]), true);
      p += 4 + centralExtra[i];
    }
  });

  if (zip64) {
    const record = p;
    view.setUint32(p, ZIP64_END, true);
    view.setBigUint64(p + 4, 44n, true); // size of the rest of the record
    view.setUint16(p + 12, 45, true);
    view.setUint16(p + 14, 45, true);
    view.setBigUint64(p + 24, BigInt(prepared.length), true);
    view.setBigUint64(p + 32, BigInt(prepared.length), true);
    view.setBigUint64(p + 40, BigInt(directoryEnd - directoryStart), true);
    view.setBigUint64(p + 48, BigInt(directoryStart), true);
    p += 56;
    view.setUint32(p, ZIP64_LOCATOR, true);
    view.setBigUint64(p + 8, BigInt(record), true);
    view.setUint32(p + 16, 1, true); // total number of disks
    p += 20;
  }
  view.setUint32(p, END_OF_CENTRAL_DIRECTORY, true);
  view.setUint16(p + 8, Math.min(prepared.length, 0xffff), true);
  view.setUint16(p + 10, Math.min(prepared.length, 0xffff), true);
  view.setUint32(p + 12, Math.min(directoryEnd - directoryStart, MAX32), true);
  view.setUint32(p + 16, Math.min(directoryStart, MAX32), true);
  return out;
}

/**
 * Deflates contents that arrive in pieces (a sheet written row by row), keeping only the compressed bytes: the result goes
 * to writeZip as a `deflated` input.
 */
export async function deflatePieces(pieces: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<{ deflated: Uint8Array; crc: number; size: number }> {
  const stream = new CompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const writer = stream.writable.getWriter();
  const chunks: Uint8Array[] = [];
  const reading = (async () => {
    const reader = stream.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  })();
  let crc = 0;
  let size = 0;
  for await (const piece of pieces) {
    crc = crc32(piece, crc);
    size += piece.length;
    await writer.write(piece);
  }
  await writer.close();
  await reading;
  const deflated = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    deflated.set(c, at);
    at += c.length;
  }
  return { deflated, crc, size };
}
