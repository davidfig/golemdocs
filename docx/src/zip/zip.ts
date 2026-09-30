// Minimal ZIP container support for OOXML packages: stored and deflated entries, UTF-8
// names, no encryption, no ZIP64 (Word never produces packages over 4GB).
//
// Reading goes through the central directory and inflates lazily, so parts nobody asks for
// are never decompressed. Writing can reuse an entry's compressed bytes verbatim, so
// untouched parts (media, themes, ...) round-trip without recompression.

import { crc32 } from './crc32.ts';
import { deflateRaw, inflateRaw } from './deflate.ts';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
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
}

export class ZipArchive {
  readonly entries = new Map<string, ZipEntry>();

  static read(input: Uint8Array): ZipArchive {
    if (input.length >= 8 && input[0] === 0xd0 && input[1] === 0xcf && input[2] === 0x11 && input[3] === 0xe0) {
      throw new ZipError('this is an encrypted document or a legacy binary .doc, not a .docx package');
    }
    try {
      return ZipArchive.parse(input);
    } catch (e) {
      if (e instanceof ZipError) throw e;
      throw new ZipError(`corrupt ZIP file (${(e as Error).message})`);
    }
  }

  private static parse(input: Uint8Array): ZipArchive {
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

    const count = view.getUint16(eocd + 10, true);
    const directoryOffset = view.getUint32(eocd + 16, true);
    if (count === 0xffff || directoryOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported');

    const archive = new ZipArchive();
    const decoder = new TextDecoder();
    let p = directoryOffset;
    for (let i = 0; i < count; i++) {
      if (view.getUint32(p, true) !== CENTRAL_HEADER) throw new ZipError('corrupt central directory');
      const flags = view.getUint16(p + 8, true);
      const method = view.getUint16(p + 10, true);
      const crc = view.getUint32(p + 16, true);
      const compressedSize = view.getUint32(p + 20, true);
      const size = view.getUint32(p + 24, true);
      const nameLength = view.getUint16(p + 28, true);
      const extraLength = view.getUint16(p + 30, true);
      const commentLength = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength));
      p += 46 + nameLength + extraLength + commentLength;

      if (flags & 1) throw new ZipError('encrypted (password-protected) documents are not supported');
      if (method !== STORED && method !== DEFLATED) throw new ZipError(`${name}: unsupported compression method ${method}`);
      if (view.getUint32(localOffset, true) !== LOCAL_HEADER) throw new ZipError(`${name}: corrupt local header`);
      const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
      if (name.endsWith('/')) continue; // directory entry
      archive.entries.set(name, new ZipEntry(name, method, crc, size, bytes.subarray(dataStart, dataStart + compressedSize)));
    }
    return archive;
  }
}

/** An entry to write: new contents, or an existing entry copied without recompression. */
export type ZipInput =
  | { name: string; data: Uint8Array; compress?: boolean }
  | { name: string; entry: ZipEntry };

/** Builds a ZIP archive. Entries are written in the given order. */
export async function writeZip(inputs: ZipInput[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const prepared = await Promise.all(
    inputs.map(async (input) => {
      const name = encoder.encode(input.name);
      if ('entry' in input) {
        const { entry } = input;
        return { name, method: entry.method, crc: entry.crc, size: entry.size, raw: entry.raw };
      }
      const compress = input.compress ?? true;
      const raw = compress ? await deflateRaw(input.data) : input.data;
      return { name, method: compress ? DEFLATED : STORED, crc: crc32(input.data), size: input.data.length, raw };
    }),
  );

  if (prepared.length > 0xffff) throw new ZipError('too many entries (ZIP64 is not supported)');
  let total = 22;
  for (const e of prepared) total += 30 + e.name.length + e.raw.length + 46 + e.name.length;
  if (total > 0xffffffff) throw new ZipError('archive too large (ZIP64 is not supported)');
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  // DOS timestamp 1980-01-01 00:00, like Word: output depends only on contents.
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;

  let p = 0;
  const offsets: number[] = [];
  for (const e of prepared) {
    offsets.push(p);
    view.setUint32(p, LOCAL_HEADER, true);
    view.setUint16(p + 4, 20, true); // version needed: 2.0
    view.setUint16(p + 6, UTF8_FLAG, true);
    view.setUint16(p + 8, e.method, true);
    view.setUint16(p + 10, DOS_TIME, true);
    view.setUint16(p + 12, DOS_DATE, true);
    view.setUint32(p + 14, e.crc, true);
    view.setUint32(p + 18, e.raw.length, true);
    view.setUint32(p + 22, e.size, true);
    view.setUint16(p + 26, e.name.length, true);
    view.setUint16(p + 28, 0, true);
    out.set(e.name, p + 30);
    out.set(e.raw, p + 30 + e.name.length);
    p += 30 + e.name.length + e.raw.length;
  }

  const directoryStart = p;
  prepared.forEach((e, i) => {
    view.setUint32(p, CENTRAL_HEADER, true);
    view.setUint16(p + 4, 20, true); // version made by
    view.setUint16(p + 6, 20, true); // version needed
    view.setUint16(p + 8, UTF8_FLAG, true);
    view.setUint16(p + 10, e.method, true);
    view.setUint16(p + 12, DOS_TIME, true);
    view.setUint16(p + 14, DOS_DATE, true);
    view.setUint32(p + 16, e.crc, true);
    view.setUint32(p + 20, e.raw.length, true);
    view.setUint32(p + 24, e.size, true);
    view.setUint16(p + 28, e.name.length, true);
    // extra length, comment length, disk number, internal attrs: 0
    view.setUint32(p + 38, 0, true); // external attrs
    view.setUint32(p + 42, offsets[i], true);
    out.set(e.name, p + 46);
    p += 46 + e.name.length;
  });

  view.setUint32(p, END_OF_CENTRAL_DIRECTORY, true);
  view.setUint16(p + 8, prepared.length, true);
  view.setUint16(p + 10, prepared.length, true);
  view.setUint32(p + 12, p - directoryStart, true);
  view.setUint32(p + 16, directoryStart, true);
  return out;
}
