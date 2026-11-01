// The workbook's strings: the shared strings as read, then every string added after. Kept as the bytes they came as (UTF-8,
// still XML-escaped when they came from a file) with an offset each, so reading a sheet of a million strings makes no
// JavaScript strings; one is decoded only when something shows or compares it. See docs/spreadsheets.md.

const decoder = new TextDecoder();

export class StringPool {
  private bytes: Uint8Array = new Uint8Array(1 << 16);
  private used = 0;
  /** Where string i starts; string i ends where i + 1 starts. */
  private offsets: Uint32Array = new Uint32Array(1 << 12);
  /** Bit i set: string i is still XML-escaped (from a file); clear: plain text (added by an edit). */
  private escaped: Uint8Array = new Uint8Array(1 << 9);
  private n = 0;
  private cache = new Map<number, string>();

  get count(): number {
    return this.n;
  }

  /** Bytes held, for measurements. */
  get byteLength(): number {
    return this.bytes.byteLength + this.offsets.byteLength + this.escaped.byteLength;
  }

  /** The arrays behind the pool, trimmed to what is used (for the memory image). */
  state(): { bytes: Uint8Array; offsets: Uint32Array; escaped: Uint8Array } {
    return { bytes: this.bytes.subarray(0, this.used), offsets: this.offsets.subarray(0, this.n), escaped: this.escaped.subarray(0, (this.n + 7) >> 3) };
  }

  /** A pool on arrays from the memory image (views, not copies: adding a string copies them first, as they are full). */
  static from(state: { bytes: Uint8Array; offsets: Uint32Array; escaped: Uint8Array }): StringPool {
    const pool = new StringPool();
    pool.bytes = state.bytes;
    pool.used = state.bytes.length;
    pool.offsets = state.offsets;
    pool.n = state.offsets.length;
    pool.escaped = state.escaped.slice();
    return pool;
  }

  /** Adds `source[start, end)`, escaped XML text as it is in a file. Returns its id. */
  addEscaped(source: Uint8Array, start: number, end: number): number {
    return this.push(source, start, end, true);
  }

  /** Adds several pieces of escaped XML text as one string (a rich string's runs). */
  addEscapedPieces(source: Uint8Array, ranges: readonly number[]): number {
    let length = 0;
    for (let i = 0; i < ranges.length; i += 2) length += ranges[i + 1] - ranges[i];
    this.reserve(length);
    const id = this.begin(true);
    for (let i = 0; i < ranges.length; i += 2) {
      this.bytes.set(source.subarray(ranges[i], ranges[i + 1]), this.used);
      this.used += ranges[i + 1] - ranges[i];
    }
    return id;
  }

  /** Adds plain text (typed by someone). */
  add(text: string): number {
    const encoded = new TextEncoder().encode(text);
    const id = this.push(encoded, 0, encoded.length, false);
    this.cache.set(id, text);
    return id;
  }

  get(id: number): string {
    let text = this.cache.get(id);
    if (text !== undefined) return text;
    // An index past the table (a damaged file) is an empty string rather than a failure.
    if (!(id >= 0 && id < this.n)) return '';
    const start = this.offsets[id];
    const end = id + 1 < this.n ? this.offsets[id + 1] : this.used;
    text = decoder.decode(this.bytes.subarray(start, end));
    if (this.escaped[id >> 3] & (1 << (id & 7))) text = unescapeXml(text);
    if (this.cache.size > 4096) this.cache.clear();
    this.cache.set(id, text);
    return text;
  }

  private push(source: Uint8Array, start: number, end: number, escaped: boolean): number {
    this.reserve(end - start);
    const id = this.begin(escaped);
    this.bytes.set(source.subarray(start, end), this.used);
    this.used += end - start;
    return id;
  }

  private begin(escaped: boolean): number {
    const id = this.n++;
    if (id >= this.offsets.length) this.offsets = grow(this.offsets, this.offsets.length * 2);
    if (id >> 3 >= this.escaped.length) this.escaped = grow(this.escaped, this.escaped.length * 2);
    this.offsets[id] = this.used;
    if (escaped) this.escaped[id >> 3] |= 1 << (id & 7);
    return id;
  }

  private reserve(length: number): void {
    if (this.used + length <= this.bytes.length) return;
    this.bytes = grow(this.bytes, Math.max(this.bytes.length * 2, this.used + length));
  }
}

function grow<T extends Uint8Array | Uint32Array>(array: T, length: number): T {
  const bigger = new (array.constructor as new (n: number) => T)(length);
  bigger.set(array);
  return bigger;
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** XML entities and Excel's own `_xHHHH_` escapes (for control characters) to text. */
export function unescapeXml(text: string): string {
  if (text.includes('&')) {
    text = text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, name: string) => {
      if (name[0] !== '#') return NAMED[name] ?? whole;
      const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    });
  }
  if (text.includes('_x')) text = text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return text;
}
