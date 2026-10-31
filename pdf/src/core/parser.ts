// SPDX-License-Identifier: MIT
// Tokenizer and object parser for PDF syntax (§7.2, §7.3), shared by the file reader and the
// content stream parser. Lenient where real files are sloppy (bad stream lengths, stray
// tokens, malformed numbers), strict only where guessing would silently corrupt data.

import { PdfDict, PdfName, PdfRef, PdfStream, PdfString, type PdfObject } from './objects.ts';

export class PdfSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} (at byte ${offset})`);
  }
}

// Character classes: 1 = whitespace, 2 = delimiter, 0 = regular.
const CLASS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) CLASS[c] = 1;
for (const c of '()<>[]{}/%') CLASS[c.charCodeAt(0)] = 2;

export const isWhitespace = (b: number): boolean => CLASS[b] === 1;
export const isDelimiter = (b: number): boolean => CLASS[b] === 2;
export const isRegular = (b: number): boolean => CLASS[b] === 0;

const HEX = new Int8Array(256).fill(-1);
for (let i = 0; i < 16; i++) {
  HEX['0123456789abcdef'.charCodeAt(i)] = i;
  HEX['0123456789ABCDEF'.charCodeAt(i)] = i;
}

/** A bare keyword in a token stream: an operator in content streams, `obj`/`R`/... in files. */
export class Keyword {
  constructor(readonly value: string) {}
}

/** Array/dictionary punctuation. */
export type Punct = '[' | ']' | '<<' | '>>' | '{' | '}';

export type Token = PdfObject | Keyword | { punct: Punct } | undefined;

const EOF_TOKEN = undefined;
const SKIP = Symbol('skip');

/** Deepest nesting of arrays and dictionaries parsed; hostile files nest far deeper to exhaust the stack. */
const MAX_DEPTH = 256;

export interface ParserOptions {
  /** Resolves an indirect /Length (the object may not be parsed yet). */
  resolveLength?: (ref: PdfRef) => number | undefined;
  /** Never read `n g R` as a reference (content streams have none). */
  noRefs?: boolean;
}

export class Parser {
  private depth = 0;

  constructor(
    readonly bytes: Uint8Array,
    public pos = 0,
    readonly options: ParserOptions = {},
  ) {}

  get atEnd(): boolean {
    return this.pos >= this.bytes.length;
  }

  error(message: string, offset = this.pos): never {
    throw new PdfSyntaxError(message, offset);
  }

  /** Skips whitespace and comments. */
  skipSpace(): void {
    const b = this.bytes;
    let p = this.pos;
    while (p < b.length) {
      const c = b[p];
      if (CLASS[c] === 1) p++;
      else if (c === 0x25 /* % */) {
        while (p < b.length && b[p] !== 10 && b[p] !== 13) p++;
      } else break;
    }
    this.pos = p;
  }

  /** The run of regular characters at pos, as a binary string. */
  readRegular(): string {
    const b = this.bytes;
    const start = this.pos;
    let p = start;
    while (p < b.length && CLASS[b[p]] === 0) p++;
    this.pos = p;
    return latin1(b, start, p);
  }

  /** Reads the next token: an object other than array/dict, a keyword, or punctuation. */
  readToken(): Token {
    // A loop rather than recursion: a run of stray bytes can be as long as the file.
    for (;;) {
      const t = this.readTokenOnce();
      if (t !== SKIP) return t;
    }
  }

  /** One token, or SKIP after consuming a stray byte. */
  private readTokenOnce(): Token | typeof SKIP {
    this.skipSpace();
    const b = this.bytes;
    if (this.pos >= b.length) return EOF_TOKEN;
    const c = b[this.pos];
    switch (c) {
      case 0x2f /* / */:
        return this.readName();
      case 0x28 /* ( */:
        return this.readLiteralString();
      case 0x3c /* < */:
        if (b[this.pos + 1] === 0x3c) {
          this.pos += 2;
          return { punct: '<<' };
        }
        return this.readHexString();
      case 0x3e /* > */:
        if (b[this.pos + 1] === 0x3e) {
          this.pos += 2;
          return { punct: '>>' };
        }
        this.pos++;
        return SKIP; // stray '>'
      case 0x5b:
        this.pos++;
        return { punct: '[' };
      case 0x5d:
        this.pos++;
        return { punct: ']' };
      case 0x7b:
        this.pos++;
        return { punct: '{' };
      case 0x7d:
        this.pos++;
        return { punct: '}' };
      case 0x29 /* ) */:
        this.pos++;
        return SKIP; // stray ')'
    }
    if ((c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2e || c === 0x2b) {
      const n = this.readPlainNumber();
      if (n !== undefined) return n;
    }
    const start = this.pos;
    const word = this.readRegular();
    if (!word) {
      this.pos++;
      return SKIP;
    }
    const n = parseNumber(word);
    if (n !== undefined) return n;
    switch (word) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'null':
        return null;
    }
    if (word.length > 256) this.error('runaway token', start);
    return new Keyword(word);
  }

  /** Fast path for well-formed numbers; undefined (pos unchanged) for anything unusual. */
  private readPlainNumber(): number | undefined {
    const b = this.bytes;
    let p = this.pos;
    let neg = false;
    if (b[p] === 0x2d || b[p] === 0x2b) neg = b[p++] === 0x2d;
    let int = 0;
    let digits = 0;
    while (p < b.length && b[p] >= 0x30 && b[p] <= 0x39) {
      int = int * 10 + b[p++] - 0x30;
      digits++;
    }
    let fraction = false;
    if (b[p] === 0x2e) {
      p++;
      fraction = true;
      while (p < b.length && b[p] >= 0x30 && b[p] <= 0x39) {
        p++;
        digits++;
      }
    }
    // Must have a digit and end at a delimiter or whitespace.
    if (!digits || digits > 15 || (p < b.length && CLASS[b[p]] === 0)) return undefined;
    // Integers are exact as accumulated; decimals go through Number() for correct rounding.
    const value = fraction ? Math.abs(Number(latin1(b, this.pos, p))) : int;
    this.pos = p;
    return neg ? -value : value;
  }

  readName(): PdfName {
    const b = this.bytes;
    let p = ++this.pos;
    let s = '';
    let runStart = p;
    while (p < b.length && CLASS[b[p]] === 0) {
      if (b[p] === 0x23 /* # */ && HEX[b[p + 1]] >= 0 && HEX[b[p + 2]] >= 0) {
        s += latin1(b, runStart, p) + String.fromCharCode((HEX[b[p + 1]] << 4) | HEX[b[p + 2]]);
        p += 3;
        runStart = p;
      } else p++;
    }
    s += latin1(b, runStart, p);
    this.pos = p;
    return PdfName.of(s);
  }

  readLiteralString(): PdfString {
    const b = this.bytes;
    let p = this.pos + 1;
    const out: number[] = [];
    let depth = 1;
    while (p < b.length) {
      let c = b[p++];
      if (c === 0x28) depth++;
      else if (c === 0x29) {
        if (--depth === 0) break;
      } else if (c === 0x5c /* \ */) {
        c = b[p++];
        switch (c) {
          case 0x6e: c = 10; break; // n
          case 0x72: c = 13; break; // r
          case 0x74: c = 9; break; // t
          case 0x62: c = 8; break; // b
          case 0x66: c = 12; break; // f
          case 13: // line continuation
            if (b[p] === 10) p++;
            continue;
          case 10:
            continue;
          default:
            if (c >= 0x30 && c <= 0x37) {
              let v = c - 0x30;
              for (let k = 0; k < 2 && b[p] >= 0x30 && b[p] <= 0x37; k++) v = v * 8 + b[p++] - 0x30;
              c = v & 0xff;
            }
          // anything else (including ( ) \) stands for itself
        }
      } else if (c === 13) {
        // an unescaped end-of-line is always read as \n
        if (b[p] === 10) p++;
        c = 10;
      }
      out.push(c);
    }
    this.pos = p;
    return new PdfString(Uint8Array.from(out));
  }

  readHexString(): PdfString {
    const b = this.bytes;
    let p = this.pos + 1;
    const out: number[] = [];
    let hi = -1;
    while (p < b.length && b[p] !== 0x3e) {
      const v = HEX[b[p++]];
      if (v < 0) continue; // whitespace (or garbage)
      if (hi < 0) hi = v;
      else {
        out.push((hi << 4) | v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi << 4);
    this.pos = p + 1;
    return new PdfString(Uint8Array.from(out), true);
  }

  /** Parses one complete object, including arrays, dictionaries and `n g R` references. */
  parseObject(): PdfObject {
    return this.complete(this.readToken());
  }

  /** Completes a token already read into an object (reading the rest of an array or dictionary). */
  complete(t: Token): PdfObject {
    if (t === undefined) this.error('unexpected end of data');
    if (t instanceof Keyword) this.error(`unexpected keyword '${t.value}'`, this.pos - t.value.length);
    if (typeof t === 'number') return Number.isInteger(t) && t >= 0 && !this.options.noRefs ? this.maybeRef(t) : t;
    if (t !== null && typeof t === 'object' && 'punct' in t) {
      if (t.punct === '[' || t.punct === '<<') {
        if (this.depth >= MAX_DEPTH) this.error('arrays and dictionaries nested too deeply');
        this.depth++;
        try {
          return t.punct === '[' ? this.parseArray() : this.parseDict();
        } finally {
          this.depth--;
        }
      }
      this.error(`unexpected '${t.punct}'`, this.pos - 1);
    }
    return t;
  }

  /** After an integer: `n g R` becomes a reference; otherwise pos is restored. */
  private maybeRef(num: number): PdfObject {
    const save = this.pos;
    this.skipSpace();
    const b = this.bytes;
    if (b[this.pos] >= 0x30 && b[this.pos] <= 0x39) {
      const genWord = this.readRegular();
      if (/^\d+$/.test(genWord)) {
        this.skipSpace();
        if (b[this.pos] === 0x52 /* R */ && (this.pos + 1 >= b.length || CLASS[b[this.pos + 1]] !== 0)) {
          this.pos++;
          return new PdfRef(num, Number(genWord));
        }
      }
    }
    this.pos = save;
    return num;
  }

  private parseArray(): PdfObject[] {
    const out: PdfObject[] = [];
    for (;;) {
      const t = this.readToken();
      if (t === undefined) this.error('unterminated array');
      if (t !== null && typeof t === 'object' && 'punct' in t && t.punct === ']') return out;
      if (t instanceof Keyword) {
        if (t.value === 'endobj' || t.value === 'stream') {
          // Missing ']': give back the keyword and end the array here.
          this.pos -= t.value.length;
          return out;
        }
        continue; // stray keyword
      }
      out.push(this.complete(t));
    }
  }

  private parseDict(): PdfDict {
    const dict = new PdfDict();
    for (;;) {
      const t = this.readToken();
      if (t === undefined) this.error('unterminated dictionary');
      if (t !== null && typeof t === 'object' && 'punct' in t && t.punct === '>>') return dict;
      if (t instanceof Keyword && (t.value === 'endobj' || t.value === 'stream')) {
        this.pos -= t.value.length;
        return dict;
      }
      if (!(t instanceof PdfName)) continue; // non-name key: skip it
      // Peek for a missing value (`/Key >>`).
      this.skipSpace();
      if (this.bytes[this.pos] === 0x3e && this.bytes[this.pos + 1] === 0x3e) {
        this.pos += 2;
        return dict;
      }
      const v = this.parseObject();
      if (v !== null) dict.entries.set(t.name, v);
    }
  }

  /** Expects a keyword (e.g. `obj`) at pos; returns false (pos unchanged) if absent. */
  expectKeyword(word: string): boolean {
    const save = this.pos;
    this.skipSpace();
    if (this.readRegular() === word) return true;
    this.pos = save;
    return false;
  }

  /**
   * Parses `num gen obj <object> endobj` at pos. The object may be a stream; its data is
   * sliced (not copied) from the input.
   */
  parseIndirect(): { num: number; gen: number; object: PdfObject } {
    const start = this.pos;
    this.skipSpace();
    const num = Number(this.readRegular());
    this.skipSpace();
    const gen = Number(this.readRegular());
    if (!Number.isInteger(num) || !Number.isInteger(gen) || !this.expectKeyword('obj')) {
      this.error('expected "n g obj"', start);
    }
    let object = this.parseObject();
    if (object instanceof PdfDict) {
      this.skipSpace();
      if (this.startsWith('stream')) object = this.parseStreamBody(object);
    }
    this.expectKeyword('endobj'); // tolerate its absence
    return { num, gen, object };
  }

  private startsWith(word: string, at = this.pos): boolean {
    const b = this.bytes;
    for (let i = 0; i < word.length; i++) if (b[at + i] !== word.charCodeAt(i)) return false;
    return true;
  }

  private parseStreamBody(dict: PdfDict): PdfStream {
    const b = this.bytes;
    let p = this.pos + 6; // 'stream'
    while (b[p] === 0x20) p++; // some writers put spaces before the EOL
    if (b[p] === 13) p++;
    if (b[p] === 10) p++;
    const start = p;

    let length: number | undefined;
    const l = dict.get('Length');
    if (typeof l === 'number') length = l;
    else if (l instanceof PdfRef) length = this.options.resolveLength?.(l);

    let end = -1;
    if (length !== undefined && Number.isInteger(length) && length >= 0 && start + length <= b.length) {
      let q = start + length;
      while (q < b.length && CLASS[b[q]] === 1) q++;
      if (this.startsWith('endstream', q)) end = start + length;
    }
    if (end < 0) {
      // Wrong or missing /Length: find the endstream keyword and drop the EOL before it.
      const found = indexOf(b, ENDSTREAM, start);
      if (found < 0) this.error('stream without endstream', start);
      end = found;
      if (end > start && b[end - 1] === 10) end--;
      if (end > start && b[end - 1] === 13) end--;
    }
    this.pos = end;
    this.skipSpace();
    if (this.startsWith('endstream')) this.pos += 9;
    return new PdfStream(dict, b.subarray(start, end));
  }
}

const ENDSTREAM = Uint8Array.from('endstream', (c) => c.charCodeAt(0));

/** Number syntax (§7.3.3), lenient about doubled signs; undefined if the word isn't numeric. */
export function parseNumber(word: string): number | undefined {
  const c = word.charCodeAt(0);
  if (!((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e)) return undefined;
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return Number(word);
  // Malformed but seen in the wild: "--5", "5-", "1.2.3", "-.": take the leading numeric part.
  const m = /^[+-]*(\d*\.?\d*)/.exec(word);
  if (!m || !/\d/.test(m[1])) return /^[+-]*\.?$/.test(word) ? 0 : undefined;
  const v = Number(m[1]);
  return word.startsWith('-') ? -v : v; // "--5" is -5, as Adobe reads it
}

export function latin1(b: Uint8Array, start: number, end: number): string {
  if (end - start < 64) {
    let s = '';
    for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
    return s;
  }
  let s = '';
  for (let i = start; i < end; i += 0x8000) s += String.fromCharCode(...b.subarray(i, Math.min(end, i + 0x8000)));
  return s;
}

export function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  const last = haystack.length - needle.length;
  outer: for (let i = haystack.indexOf(first, from); i >= 0 && i <= last; i = haystack.indexOf(first, i + 1)) {
    for (let k = 1; k < needle.length; k++) if (haystack[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

export function lastIndexOf(haystack: Uint8Array, needle: Uint8Array, from = haystack.length - needle.length): number {
  for (let i = Math.min(from, haystack.length - needle.length); i >= 0; i--) {
    let k = 0;
    while (k < needle.length && haystack[i + k] === needle[k]) k++;
    if (k === needle.length) return i;
  }
  return -1;
}

export const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
