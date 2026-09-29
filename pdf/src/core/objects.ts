// The PDF object model (ISO 32000-2 §7.3): the eight basic types plus indirect references.
//
// Arrays are plain JS arrays and numbers plain JS numbers; names are interned, so they
// compare with ===. Strings keep their bytes (PDF strings are binary) and whether they were
// written as hex, so unmodified strings serialize the way they were read.

export type PdfObject = null | boolean | number | PdfName | PdfString | PdfObject[] | PdfDict | PdfStream | PdfRef;

export class PdfName {
  private static readonly table = new Map<string, PdfName>();

  /** Interned: PdfName.of('Type') === PdfName.of('Type'). */
  static of(name: string): PdfName {
    let n = PdfName.table.get(name);
    if (!n) {
      n = new PdfName(name);
      PdfName.table.set(name, n);
    }
    return n;
  }

  /**
   * The name's bytes as a binary string (one char per byte, #xx escapes decoded), without
   * the slash. Names are almost always ASCII; `text` decodes UTF-8 names.
   */
  private constructor(readonly name: string) {}

  get text(): string {
    if (!/[\x80-\xff]/.test(this.name)) return this.name;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(binaryToBytes(this.name));
    } catch {
      return this.name;
    }
  }

  toString(): string {
    return '/' + this.name;
  }
}

export class PdfRef {
  constructor(
    readonly num: number,
    readonly gen = 0,
  ) {}

  get key(): string {
    return this.gen === 0 ? String(this.num) : `${this.num}:${this.gen}`;
  }

  equals(other: unknown): boolean {
    return other instanceof PdfRef && other.num === this.num && other.gen === this.gen;
  }

  toString(): string {
    return `${this.num} ${this.gen} R`;
  }
}

export class PdfString {
  constructor(
    readonly bytes: Uint8Array,
    /** Written as <hex> rather than (literal). */
    readonly hex = false,
  ) {}

  /** A text string (§7.9.2.2): PDFDocEncoding when possible, otherwise UTF-16BE with a BOM. */
  static text(text: string): PdfString {
    const doc = encodePdfDoc(text);
    if (doc) return new PdfString(doc);
    const out = new Uint8Array(2 + text.length * 2);
    out[0] = 0xfe;
    out[1] = 0xff;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      out[2 + i * 2] = c >> 8;
      out[3 + i * 2] = c & 0xff;
    }
    return new PdfString(out);
  }

  /** Raw bytes from a binary string (one char per byte). */
  static binary(s: string, hex = false): PdfString {
    return new PdfString(binaryToBytes(s), hex);
  }

  /** Decodes as a text string: UTF-16BE or UTF-8 with a BOM, otherwise PDFDocEncoding. */
  get text(): string {
    const b = this.bytes;
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder().decode(b.subarray(3));
    return decodePdfDoc(b);
  }

  /** The bytes as a binary string (one char per byte). */
  get binary(): string {
    return bytesToBinary(this.bytes);
  }
}

export class PdfDict {
  readonly entries: Map<string, PdfObject>;

  constructor(entries?: Iterable<[string, PdfObject]> | Record<string, PdfObject>) {
    this.entries =
      entries === undefined
        ? new Map()
        : Symbol.iterator in entries
          ? new Map(entries as Iterable<[string, PdfObject]>)
          : new Map(Object.entries(entries));
  }

  get(key: string): PdfObject | undefined {
    return this.entries.get(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Sets a key; undefined (or null, which PDF treats as absent) deletes it. */
  set(key: string, value: PdfObject | undefined): this {
    if (value === undefined || value === null) this.entries.delete(key);
    else this.entries.set(key, value);
    return this;
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  keys(): IterableIterator<string> {
    return this.entries.keys();
  }

  get size(): number {
    return this.entries.size;
  }

  [Symbol.iterator](): IterableIterator<[string, PdfObject]> {
    return this.entries[Symbol.iterator]();
  }

  /** The value if it is a name, else undefined. Does not follow references. */
  name(key: string): string | undefined {
    const v = this.entries.get(key);
    return v instanceof PdfName ? v.name : undefined;
  }

  /** The value if it is a number, else undefined. Does not follow references. */
  number(key: string): number | undefined {
    const v = this.entries.get(key);
    return typeof v === 'number' ? v : undefined;
  }

  /** Shallow copy (values are shared). */
  clone(): PdfDict {
    return new PdfDict(this.entries);
  }
}

export class PdfStream {
  constructor(
    readonly dict: PdfDict,
    /** The stream's bytes as stored: still encoded by the dictionary's /Filter chain. */
    public data: Uint8Array,
  ) {}

  /** The encoded length; /Length in the dictionary is ignored after parsing and rewritten on save. */
  get length(): number {
    return this.data.length;
  }
}

export const isDict = (o: unknown): o is PdfDict => o instanceof PdfDict;
export const isStream = (o: unknown): o is PdfStream => o instanceof PdfStream;
export const isName = (o: unknown, name?: string): o is PdfName => o instanceof PdfName && (name === undefined || o.name === name);
export const isRef = (o: unknown): o is PdfRef => o instanceof PdfRef;

/** The dictionary of a dict or stream. */
export function dictOf(o: unknown): PdfDict | undefined {
  return o instanceof PdfDict ? o : o instanceof PdfStream ? o.dict : undefined;
}

/** Name helper: `N('Type')`. */
export const N = PdfName.of;

// --- binary strings and PDFDocEncoding -------------------------------------------------------

export function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function bytesToBinary(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

/** Where PDFDocEncoding differs from Latin-1 (§D.3); 0 marks an undefined code. */
const PDF_DOC_HIGH: Record<number, number> = {
  0x18: 0x02d8, 0x19: 0x02c7, 0x1a: 0x02c6, 0x1b: 0x02d9, 0x1c: 0x02dd, 0x1d: 0x02db, 0x1e: 0x02da, 0x1f: 0x02dc,
  0x80: 0x2022, 0x81: 0x2020, 0x82: 0x2021, 0x83: 0x2026, 0x84: 0x2014, 0x85: 0x2013, 0x86: 0x0192, 0x87: 0x2044,
  0x88: 0x2039, 0x89: 0x203a, 0x8a: 0x2212, 0x8b: 0x2030, 0x8c: 0x201e, 0x8d: 0x201c, 0x8e: 0x201d, 0x8f: 0x2018,
  0x90: 0x2019, 0x91: 0x201a, 0x92: 0x2122, 0x93: 0xfb01, 0x94: 0xfb02, 0x95: 0x0141, 0x96: 0x0152, 0x97: 0x0160,
  0x98: 0x0178, 0x99: 0x017d, 0x9a: 0x0131, 0x9b: 0x0142, 0x9c: 0x0153, 0x9d: 0x0161, 0x9e: 0x017e, 0x9f: 0,
  0xa0: 0x20ac, 0xad: 0,
};

const PDF_DOC_DECODE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) t[i] = PDF_DOC_HIGH[i] ?? i;
  return t;
})();

const PDF_DOC_ENCODE = (() => {
  const m = new Map<number, number>();
  for (let i = 0; i < 256; i++) {
    const u = PDF_DOC_DECODE[i];
    // Control characters other than tab/newlines have no business in text strings.
    if (u && (i >= 0x20 || i === 9 || i === 10 || i === 13)) m.set(u, i);
  }
  return m;
})();

export function decodePdfDoc(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(PDF_DOC_DECODE[b] || b);
  return s;
}

/** PDFDocEncoding bytes, or null if the text has characters outside it. */
export function encodePdfDoc(text: string): Uint8Array | null {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const b = PDF_DOC_ENCODE.get(text.charCodeAt(i));
    if (b === undefined) return null;
    out[i] = b;
  }
  return out;
}
