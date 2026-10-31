// SPDX-License-Identifier: MIT
// DEFLATE decoder (RFC 1950/1951), synchronous and tolerant: a truncated or corrupt stream
// yields everything decoded before the damage, which is what viewers show for broken PDFs.
//
// Huffman codes decode through a 10-bit lookup table, falling back to canonical decoding
// for the rare longer codes.

export class InflateError extends Error {}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const FAST_BITS = 10;

/**
 * Most bytes one stream may inflate to. DEFLATE expands up to ~1000:1, so without a limit a
 * small hostile stream could exhaust memory; past this the stream is treated as damaged.
 */
export const MAX_OUTPUT = 1 << 29;

class Huffman {
  /** For codes up to FAST_BITS: (symbol << 4) | length, indexed by bit-reversed code; 0 = slow path. */
  readonly fast = new Uint32Array(1 << FAST_BITS);
  readonly counts = new Uint16Array(16);
  readonly symbols: Uint16Array;

  constructor(lengths: ArrayLike<number>) {
    this.symbols = new Uint16Array(lengths.length);
    for (let i = 0; i < lengths.length; i++) this.counts[lengths[i]]++;
    this.counts[0] = 0;
    const offsets = new Uint16Array(16);
    for (let len = 1; len < 16; len++) offsets[len] = offsets[len - 1] + this.counts[len - 1];
    for (let i = 0; i < lengths.length; i++) if (lengths[i]) this.symbols[offsets[lengths[i]]++] = i;

    // Canonical codes, then fill the fast table with each short code's reversed bits.
    let code = 0;
    const next = new Uint16Array(16);
    for (let len = 1; len < 16; len++) {
      code = (code + this.counts[len - 1]) << 1;
      next[len] = code;
    }
    for (let sym = 0; sym < lengths.length; sym++) {
      const len = lengths[sym];
      if (!len || len > FAST_BITS) continue;
      const c = next[len]++;
      let rev = 0;
      for (let k = 0; k < len; k++) rev |= ((c >> k) & 1) << (len - 1 - k);
      for (let fill = rev; fill < 1 << FAST_BITS; fill += 1 << len) this.fast[fill] = (sym << 4) | len;
    }
  }
}

let FIXED_LIT: Huffman | undefined;
let FIXED_DIST: Huffman | undefined;

function fixedTables(): [Huffman, Huffman] {
  if (!FIXED_LIT) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288);
    FIXED_LIT = new Huffman(l);
    FIXED_DIST = new Huffman(new Uint8Array(30).fill(5));
  }
  return [FIXED_LIT, FIXED_DIST!];
}

class Inflater {
  pos = 0;
  bitBuf = 0;
  bitCount = 0;
  out: Uint8Array;
  outLen = 0;

  constructor(
    readonly input: Uint8Array,
    sizeHint: number,
  ) {
    this.out = new Uint8Array(Math.min(MAX_OUTPUT, Math.max(1024, sizeHint)));
  }

  private need(n: number): void {
    while (this.bitCount < n) {
      if (this.pos >= this.input.length) {
        if (this.bitCount === 0 || this.pos > this.input.length + 4) throw new InflateError('unexpected end of data');
        this.pos++; // pad with zero bits so a final short code can still decode
        this.bitCount += 8;
        continue;
      }
      this.bitBuf |= this.input[this.pos++] << this.bitCount;
      this.bitCount += 8;
    }
  }

  bits(n: number): number {
    if (n === 0) return 0;
    this.need(n);
    const v = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCount -= n;
    return v;
  }

  private decode(h: Huffman): number {
    if (this.bitCount < FAST_BITS) this.fill();
    const e = h.fast[this.bitBuf & ((1 << FAST_BITS) - 1)];
    if (e && (e & 15) <= this.bitCount) {
      const len = e & 15;
      this.bitBuf >>>= len;
      this.bitCount -= len;
      return e >> 4;
    }
    // Canonical decode, one bit at a time.
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.bits(1);
      const count = h.counts[len];
      if (code - count < first) return h.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new InflateError('invalid Huffman code');
  }

  /** Tops up the bit buffer without failing at the end of input. */
  private fill(): void {
    while (this.bitCount <= 24 && this.pos < this.input.length) {
      this.bitBuf |= this.input[this.pos++] << this.bitCount;
      this.bitCount += 8;
    }
  }

  private grow(extra: number): void {
    if (this.outLen + extra <= this.out.length) return;
    if (this.outLen + extra > MAX_OUTPUT) throw new InflateError('output too large');
    let size = this.out.length * 2;
    while (size < this.outLen + extra) size *= 2;
    const next = new Uint8Array(Math.min(size, MAX_OUTPUT));
    next.set(this.out.subarray(0, this.outLen));
    this.out = next;
  }

  run(): void {
    let final = 0;
    while (!final) {
      final = this.bits(1);
      const type = this.bits(2);
      if (type === 0) this.stored();
      else if (type === 1) this.codes(...fixedTables());
      else if (type === 2) this.dynamic();
      else throw new InflateError('invalid block type');
    }
  }

  private stored(): void {
    // Skip to a byte boundary, and give back whole bytes the bit buffer read ahead.
    this.pos -= this.bitCount >> 3;
    this.bitBuf = 0;
    this.bitCount = 0;
    const p = this.pos;
    if (p + 4 > this.input.length) throw new InflateError('truncated stored block');
    const len = this.input[p] | (this.input[p + 1] << 8);
    this.pos = p + 4;
    const avail = Math.min(len, this.input.length - this.pos);
    this.grow(avail);
    this.out.set(this.input.subarray(this.pos, this.pos + avail), this.outLen);
    this.outLen += avail;
    this.pos += avail;
    if (avail < len) throw new InflateError('truncated stored block');
  }

  private dynamic(): void {
    const nlen = this.bits(5) + 257;
    const ndist = this.bits(5) + 1;
    const ncode = this.bits(4) + 4;
    const cl = new Uint8Array(19);
    for (let i = 0; i < ncode; i++) cl[CODE_LENGTH_ORDER[i]] = this.bits(3);
    const clh = new Huffman(cl);
    const lengths = new Uint8Array(nlen + ndist);
    for (let i = 0; i < nlen + ndist; ) {
      const sym = this.decode(clh);
      if (sym < 16) lengths[i++] = sym;
      else {
        let repeat: number;
        let value = 0;
        if (sym === 16) {
          if (i === 0) throw new InflateError('repeat with no previous length');
          value = lengths[i - 1];
          repeat = 3 + this.bits(2);
        } else if (sym === 17) repeat = 3 + this.bits(3);
        else repeat = 11 + this.bits(7);
        if (i + repeat > lengths.length) throw new InflateError('too many code lengths');
        lengths.fill(value, i, i + repeat);
        i += repeat;
      }
    }
    this.codes(new Huffman(lengths.subarray(0, nlen)), new Huffman(lengths.subarray(nlen)));
  }

  private codes(lit: Huffman, dist: Huffman): void {
    for (;;) {
      const sym = this.decode(lit);
      if (sym < 256) {
        if (this.outLen === this.out.length) this.grow(1);
        this.out[this.outLen++] = sym;
      } else if (sym === 256) return;
      else {
        const li = sym - 257;
        if (li >= 29) throw new InflateError('invalid length code');
        const len = LENGTH_BASE[li] + this.bits(LENGTH_EXTRA[li]);
        const di = this.decode(dist);
        if (di >= 30) throw new InflateError('invalid distance code');
        const d = DIST_BASE[di] + this.bits(DIST_EXTRA[di]);
        if (d > this.outLen) throw new InflateError('distance too far back');
        this.grow(len);
        const out = this.out;
        let o = this.outLen;
        const from = o - d;
        if (d >= len) out.copyWithin(o, from, from + len);
        else for (let k = 0; k < len; k++) out[o + k] = out[from + k];
        this.outLen = o + len;
      }
    }
  }
}

export interface InflateResult {
  data: Uint8Array;
  /** Set when the stream was damaged; `data` holds what decoded before the damage. */
  error?: string;
}

/**
 * Inflates zlib-wrapped (RFC 1950) or raw (RFC 1951) DEFLATE data; a missing or invalid zlib
 * header falls back to raw. The Adler-32 checksum is not verified (it is often wrong in PDFs).
 */
export function inflate(input: Uint8Array, sizeHint = input.length * 4): InflateResult {
  const zlib = input.length >= 2 && (input[0] & 0x0f) === 8 && (input[0] >> 4) <= 7 && ((input[0] << 8) | input[1]) % 31 === 0 && !(input[1] & 0x20);
  const inf = new Inflater(input, sizeHint);
  if (zlib) inf.pos = 2;
  let error: string | undefined;
  try {
    inf.run();
  } catch (e) {
    if (!(e instanceof InflateError)) throw e;
    error = e.message;
  }
  return { data: inf.out.subarray(0, inf.outLen), error };
}
