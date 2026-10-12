// CCITTFaxDecode (§7.4.6): ITU-T T.4 (Group 3, one- and two-dimensional) and T.6 (Group 4) bilevel
// images, as the rows of 1-bit samples the rest of the image code reads. Black is 0 unless
// /BlackIs1 says otherwise. Damaged data ends the image early; the rest of it is white.

export interface CcittParams {
  /** < 0: Group 4; 0: Group 3 one-dimensional; > 0: Group 3 mixed (a tag bit after each end-of-line). */
  k: number;
  /** Pixels per row. */
  columns: number;
  /** Rows to decode; 0 when the image's own height should decide (or the data's end). */
  rows: number;
  byteAlign: boolean;
  blackIs1: boolean;
}

// Run-length codes as bit strings (T.4 tables 2 and 3), decoded through a lookup of (length, code).
const WHITE_TERMINATING =
  '00110101 000111 0111 1000 1011 1100 1110 1111 10011 10100 00111 01000 001000 000011 110100 110101 101010 101011 0100111 0001100 0001000 0010111 0000011 0000100 0101000 0101011 0010011 0100100 0011000 00000010 00000011 00011010 00011011 00010010 00010011 00010100 00010101 00010110 00010111 00101000 00101001 00101010 00101011 00101100 00101101 00000100 00000101 00001010 00001011 01010010 01010011 01010100 01010101 00100100 00100101 01011000 01011001 01011010 01011011 01001010 01001011 00110010 00110011 00110100'.split(' ');
const WHITE_MAKEUP =
  '11011 10010 010111 0110111 00110110 00110111 01100100 01100101 01101000 01100111 011001100 011001101 011010010 011010011 011010100 011010101 011010110 011010111 011011000 011011001 011011010 011011011 010011000 010011001 010011010 011000 010011011'.split(' ');
const BLACK_TERMINATING =
  '0000110111 010 11 10 011 0011 0010 00011 000101 000100 0000100 0000101 0000111 00000100 00000111 000011000 0000010111 0000011000 0000001000 00001100111 00001101000 00001101100 00000110111 00000101000 00000010111 00000011000 000011001010 000011001011 000011001100 000011001101 000001101000 000001101001 000001101010 000001101011 000011010010 000011010011 000011010100 000011010101 000011010110 000011010111 000001101100 000001101101 000011011010 000011011011 000001010100 000001010101 000001010110 000001010111 000001100100 000001100101 000001010010 000001010011 000000100100 000000110111 000000111000 000000100111 000000101000 000001011000 000001011001 000000101011 000000101100 000001011010 000001100110 000001100111'.split(' ');
const BLACK_MAKEUP =
  '0000001111 000011001000 000011001001 000001011011 000000110011 000000110100 000000110101 0000001101100 0000001101101 0000001001010 0000001001011 0000001001100 0000001001101 0000001110010 0000001110011 0000001110100 0000001110101 0000001110110 0000001110111 0000001010010 0000001010011 0000001010100 0000001010101 0000001011010 0000001011011 0000001100100 0000001100101'.split(' ');
const EXTENDED_MAKEUP = '00000001000 00000001100 00000001101 000000010010 000000010011 000000010100 000000010101 000000010110 000000010111 000000011100 000000011101 000000011110 000000011111'.split(' ');

const key = (length: number, code: number) => length * 8192 + code;

function table(terminating: string[], makeup: string[]): Map<number, number> {
  const map = new Map<number, number>();
  const add = (bits: string, run: number) => map.set(key(bits.length, parseInt(bits, 2)), run);
  terminating.forEach((bits, run) => add(bits, run));
  makeup.forEach((bits, i) => add(bits, 64 * (i + 1)));
  EXTENDED_MAKEUP.forEach((bits, i) => add(bits, 1792 + 64 * i));
  return map;
}

const WHITE = table(WHITE_TERMINATING, WHITE_MAKEUP);
const BLACK = table(BLACK_TERMINATING, BLACK_MAKEUP);

class Bits {
  pos = 0;
  constructor(readonly data: Uint8Array) {}
  get left(): number {
    return this.data.length * 8 - this.pos;
  }
  bit(): number {
    const b = (this.data[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }
  /** The next `n` bits without taking them (zeros past the end). */
  peek(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const at = this.pos + i;
      v = (v << 1) | (at < this.data.length * 8 ? (this.data[at >> 3] >> (7 - (at & 7))) & 1 : 0);
    }
    return v;
  }
  align(): void {
    this.pos = (this.pos + 7) & ~7;
  }
}

/** A run of one color: makeup codes (64 and up) add up until a terminating one. null on a code that isn't one. */
function readRun(bits: Bits, black: boolean): number | null {
  const codes = black ? BLACK : WHITE;
  let total = 0;
  for (;;) {
    let code = 0;
    let length = 0;
    let run: number | undefined;
    while (length < 13 && bits.left > 0) {
      code = (code << 1) | bits.bit();
      length++;
      run = codes.get(key(length, code));
      if (run !== undefined) break;
    }
    if (run === undefined) return null;
    total += run;
    if (run < 64) return total;
  }
}

const enum Mode {
  Pass,
  Horizontal,
  Vertical,
  End,
}

/** The next two-dimensional mode and, for vertical, its offset; End for an end-of-line or damage. */
function readMode(bits: Bits): { mode: Mode; delta: number } {
  if (bits.left <= 0) return { mode: Mode.End, delta: 0 };
  if (bits.bit()) return { mode: Mode.Vertical, delta: 0 };
  if (bits.left <= 0) return { mode: Mode.End, delta: 0 };
  const second = bits.bit();
  const third = bits.bit();
  if (second) return { mode: Mode.Vertical, delta: third ? 1 : -1 };
  if (third) return { mode: Mode.Horizontal, delta: 0 };
  if (bits.bit()) return { mode: Mode.Pass, delta: 0 };
  // 0000 so far: vertical by two or three, an extension, or the start of an end-of-line.
  if (bits.bit()) return { mode: Mode.Vertical, delta: bits.bit() ? 2 : -2 };
  if (bits.bit()) return { mode: Mode.Vertical, delta: bits.bit() ? 3 : -3 };
  return { mode: Mode.End, delta: 0 };
}

/** Where the colors change along a row (starting white), from the row above and the codes that follow. */
function row2D(bits: Bits, ref: number[], columns: number): number[] | null {
  const cur: number[] = [];
  let a0 = -1;
  let color = 0;
  let k = 0;
  while (a0 < columns) {
    // b1: the first change right of a0 that goes to the opposite color; b2: the one after it.
    while (k > 0 && ref[k - 1] > a0) k--;
    while (k < ref.length && (ref[k] <= a0 || (k & 1) !== color)) k++;
    const b1 = k < ref.length ? ref[k] : columns;
    const b2 = k + 1 < ref.length ? ref[k + 1] : columns;
    const { mode, delta } = readMode(bits);
    if (mode === Mode.End) return null;
    if (mode === Mode.Pass) a0 = b2;
    else if (mode === Mode.Vertical) {
      const a1 = Math.min(Math.max(b1 + delta, a0 < 0 ? 0 : a0), columns);
      cur.push(a1);
      a0 = a1;
      color ^= 1;
    } else {
      const r1 = readRun(bits, color === 1);
      const r2 = r1 === null ? null : readRun(bits, color === 0);
      if (r1 === null || r2 === null) return null;
      const start = a0 < 0 ? 0 : a0;
      cur.push(Math.min(start + r1, columns), Math.min(start + r1 + r2, columns));
      a0 = Math.min(start + r1 + r2, columns);
    }
  }
  return trim(cur, columns);
}

function row1D(bits: Bits, columns: number): number[] | null {
  const cur: number[] = [];
  let x = 0;
  let color = 0;
  while (x < columns) {
    const run = readRun(bits, color === 1);
    if (run === null) return null;
    x = Math.min(x + run, columns);
    cur.push(x);
    color ^= 1;
  }
  return trim(cur, columns);
}

/** Changes at the end of the row are not changes (an even count keeps colors lined up). */
function trim(changes: number[], columns: number): number[] {
  while (changes.length && changes[changes.length - 1] >= columns) changes.pop();
  return changes;
}

/** Decodes the data to packed 1-bit rows (each padded to a whole byte). */
export function ccittDecode(data: Uint8Array, params: CcittParams): Uint8Array {
  const { k, columns, byteAlign, blackIs1 } = params;
  const rowBytes = Math.ceil(columns / 8);
  const maxRows = params.rows > 0 ? params.rows : 1 << 20;
  const out: number[][] = [];
  const bits = new Bits(data);
  let ref: number[] = [];
  const endOfLine = () => bits.peek(12) === 1;
  /** Takes the fill bits and end-of-line code that may come before a row: eleven or more zeros, then a one. */
  const takeEol = (): boolean => {
    let at = bits.pos;
    while (at < data.length * 8 && ((data[at >> 3] >> (7 - (at & 7))) & 1) === 0) at++;
    if (at >= data.length * 8 || at - bits.pos < 11) return false;
    bits.pos = at + 1;
    return true;
  };
  for (let row = 0; row < maxRows && bits.left > 0; row++) {
    let changes: number[] | null;
    if (k < 0) {
      if (byteAlign) bits.align();
      // An end-of-line (two in a row, in a Group 4 image's end) is the end.
      if (endOfLine()) break;
      changes = row2D(bits, ref, columns);
    } else {
      const eol = takeEol();
      if (!eol && byteAlign) bits.align();
      if (bits.left <= 0) break;
      // Several end-of-lines in a row end the image.
      if (eol && takeEol()) break;
      const oneD = k === 0 || (eol ? bits.bit() === 1 : true);
      changes = oneD ? row1D(bits, columns) : row2D(bits, ref, columns);
    }
    if (!changes) break;
    out.push(changes);
    ref = changes;
  }
  const rows = params.rows > 0 ? params.rows : out.length;
  const bytes = new Uint8Array(rows * rowBytes);
  if (!blackIs1) bytes.fill(0xff);
  for (let r = 0; r < Math.min(rows, out.length); r++) {
    const changes = out[r];
    for (let i = 0; i < changes.length; i += 2) {
      const from = changes[i];
      const to = i + 1 < changes.length ? changes[i + 1] : columns;
      for (let x = from; x < to; x++) {
        const at = r * rowBytes + (x >> 3);
        if (blackIs1) bytes[at] |= 0x80 >> (x & 7);
        else bytes[at] &= ~(0x80 >> (x & 7));
      }
    }
  }
  return bytes;
}
