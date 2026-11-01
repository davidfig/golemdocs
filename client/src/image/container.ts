// The memory image (docs/spreadsheets.md, "The memory image"): a cache of a document as it is held in memory, kept next to
// the file it was made from so the next open maps it instead of parsing the file. Generic: a kind (a spreadsheet today)
// gives its schema version and its sections; this knows only the container.
//
//   "GOLEMIMG" | container version (u32) | header length (u32) | header (JSON, padded to 8) | sections, each 8-byte aligned
//
// The header names the kind, the kind's schema version, the source's fingerprint (SHA-256 and length) and where each
// section is. A section is a typed array, raw bytes or JSON; typed sections are aligned so they map as views on the one
// buffer, with no copy. An image is used only if the container version, the kind's schema version and the fingerprint all
// match (`openImage`); anything else means the file is read again and a new image made. Images are never upgraded.

export const CONTAINER_VERSION = 1;
const MAGIC = 'GOLEMIMG';

export type SectionType = 'u8' | 'u16' | 'u32' | 'i32' | 'f32' | 'f64' | 'json';
type View = Uint8Array | Uint16Array | Uint32Array | Int32Array | Float32Array | Float64Array;
const ARRAYS = { u8: Uint8Array, u16: Uint16Array, u32: Uint32Array, i32: Int32Array, f32: Float32Array, f64: Float64Array } as const;

export interface Fingerprint {
  sha256: string;
  size: number;
}

interface Header {
  kind: string;
  schema: number;
  fingerprint: Fingerprint;
  sections: { name: string; type: SectionType; offset: number; length: number }[];
}

/** The SHA-256 of a file, as hex: what an image is tied to. */
export async function fingerprint(bytes: Uint8Array): Promise<Fingerprint> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return { sha256: Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(''), size: bytes.length };
}

/** Collects sections and writes the image. */
export class ImageWriter {
  private sections: { name: string; type: SectionType; bytes: Uint8Array }[] = [];

  constructor(
    private readonly kind: string,
    private readonly schema: number,
    private readonly source: Fingerprint,
  ) {}

  array(name: string, data: View): void {
    const type = (Object.entries(ARRAYS).find(([, A]) => data instanceof A)?.[0] ?? 'u8') as SectionType;
    this.sections.push({ name, type, bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
  }

  json(name: string, value: unknown): void {
    this.sections.push({ name, type: 'json', bytes: new TextEncoder().encode(JSON.stringify(value)) });
  }

  /** The image as one buffer. */
  finish(): Uint8Array {
    const align = (n: number) => (n + 7) & ~7;
    // Offsets are relative to the start of the section area, which starts 8-aligned after the header.
    let at = 0;
    const placed = this.sections.map((s) => {
      const offset = at;
      at = align(at + s.bytes.length);
      return { name: s.name, type: s.type, offset, length: s.bytes.length };
    });
    const header: Header = { kind: this.kind, schema: this.schema, fingerprint: this.source, sections: placed };
    const headerBytes = new TextEncoder().encode(JSON.stringify(header));
    const start = align(16 + headerBytes.length);
    const out = new Uint8Array(start + at);
    out.set(new TextEncoder().encode(MAGIC), 0);
    const view = new DataView(out.buffer);
    view.setUint32(8, CONTAINER_VERSION, true);
    view.setUint32(12, headerBytes.length, true);
    out.set(headerBytes, 16);
    this.sections.forEach((s, i) => out.set(s.bytes, start + placed[i].offset));
    return out;
  }
}

/** An image whose sections can be read. Typed sections are views on the image's buffer: never write to them. */
export class Image {
  private readonly index: Map<string, Header['sections'][number]>;

  private constructor(
    private readonly bytes: Uint8Array,
    readonly header: Header,
    private readonly start: number,
  ) {
    this.index = new Map(header.sections.map((s) => [s.name, s]));
  }

  /** Reads the header; null if this is not an image this version understands. */
  static parse(bytes: Uint8Array): Image | null {
    if (bytes.length < 16 || new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(8, true) !== CONTAINER_VERSION) return null;
    const length = view.getUint32(12, true);
    if (16 + length > bytes.length) return null;
    let header: Header;
    try {
      header = JSON.parse(new TextDecoder().decode(bytes.subarray(16, 16 + length)));
    } catch {
      return null;
    }
    // Views need the buffer's own alignment: a copy if this one is not 8-aligned.
    if (bytes.byteOffset % 8) bytes = bytes.slice();
    return new Image(bytes, header, (16 + length + 7) & ~7);
  }

  has(name: string): boolean {
    return this.index.has(name);
  }

  array<T extends View>(name: string): T {
    const s = this.index.get(name);
    if (!s || s.type === 'json') throw new Error(`image: no array section ${name}`);
    const A = ARRAYS[s.type];
    return new A(this.bytes.buffer as ArrayBuffer, this.bytes.byteOffset + this.start + s.offset, s.length / A.BYTES_PER_ELEMENT) as T;
  }

  json<T>(name: string): T {
    const s = this.index.get(name);
    if (!s || s.type !== 'json') throw new Error(`image: no JSON section ${name}`);
    return JSON.parse(new TextDecoder().decode(this.bytes.subarray(this.start + s.offset, this.start + s.offset + s.length)));
  }
}

/** The image if it was made from exactly this source by this schema of this kind; otherwise null. */
export function openImage(bytes: Uint8Array | null | undefined, kind: string, schema: number, source: Fingerprint): Image | null {
  if (!bytes) return null;
  const image = Image.parse(bytes);
  if (!image) return null;
  const h = image.header;
  if (h.kind !== kind || h.schema !== schema || h.fingerprint.sha256 !== source.sha256 || h.fingerprint.size !== source.size) return null;
  return image;
}
