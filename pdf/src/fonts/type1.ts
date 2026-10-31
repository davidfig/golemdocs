// SPDX-License-Identifier: MIT
// Type 1 font programs (Adobe Type 1 Font Format; a PDF's /FontFile): the cleartext part's
// encoding and font matrix, the eexec-encrypted private part's subroutines and charstrings, and
// a charstring interpreter that turns a glyph into its outline. Hints are skipped: the outline is
// all a renderer drawing at any size needs.

import { encoding } from './encodings.ts';
import { OutlineBuilder, type Outline } from './outline.ts';

const EEXEC_KEY = 55665;
const CHARSTRING_KEY = 4330;
/** Subroutine calls nest at most this deep (the format allows 10). */
const MAX_DEPTH = 16;

export class Type1Font {
  /** Glyph space to text space. */
  fontMatrix: number[] = [0.001, 0, 0, 0.001, 0, 0];
  /** The font's own encoding: glyph names by code. */
  readonly encoding: (string | undefined)[] = [];
  private readonly charStrings = new Map<string, Uint8Array>();
  private readonly subrs: Uint8Array[] = [];
  private lenIV = 4;

  private constructor() {}

  /** Parses a /FontFile stream's data (Length1 and Length2 tell where the encrypted part starts and ends; a PFB's segment headers work too). */
  static parse(data: Uint8Array, length1?: number): Type1Font {
    const font = new Type1Font();
    const { clear, encrypted } = split(data, length1);
    font.readClear(latin1(clear));
    font.readPrivate(decrypt(isHex(encrypted) ? fromHex(encrypted) : encrypted, EEXEC_KEY, 4));
    return font;
  }

  get glyphNames(): Iterable<string> {
    return this.charStrings.keys();
  }

  has(name: string): boolean {
    return this.charStrings.has(name);
  }

  /** The glyph's outline in glyph space (multiply by fontMatrix for text space), or null if the font has no such glyph. */
  outline(name: string): Outline | null {
    const cs = this.charStrings.get(name);
    if (!cs) return null;
    const out = new OutlineBuilder();
    this.run(cs, out, 0, 0, 0);
    return out.done();
  }

  private readClear(text: string): void {
    const m = /\/FontMatrix\s*\[([^\]]*)\]/.exec(text);
    const nums = m?.[1].trim().split(/\s+/).map(Number);
    if (nums?.length === 6 && nums.every(Number.isFinite)) this.fontMatrix = nums;
    if (/\/Encoding\s+StandardEncoding\s+def/.test(text)) {
      encoding('StandardEncoding').forEach((name, code) => (this.encoding[code] = name || undefined));
      return;
    }
    for (const e of text.matchAll(/dup\s+(\d+)\s*\/([^\s/[\]{}()<>]+)\s+put/g)) {
      const code = Number(e[1]);
      if (code < 256) this.encoding[code] = e[2];
    }
  }

  private readPrivate(data: Uint8Array): void {
    const text = latin1(data);
    const len = /\/lenIV\s+(-?\d+)/.exec(text);
    if (len) this.lenIV = Number(len[1]);
    const subrs = text.search(/\/Subrs\s+\d+\s+array/);
    if (subrs >= 0) {
      const re = /dup\s+(\d+)\s+(\d+)\s+(RD|-\|)\s/y;
      let at = subrs;
      for (;;) {
        const next = text.indexOf('dup', at);
        if (next < 0) break;
        // Stop at the charstrings, which come after the subroutines.
        const cs = text.indexOf('/CharStrings', at);
        if (cs >= 0 && cs < next) break;
        re.lastIndex = next;
        const m = re.exec(text);
        if (!m) {
          at = next + 3;
          continue;
        }
        const start = re.lastIndex;
        const n = Number(m[2]);
        this.subrs[Number(m[1])] = this.decryptCharString(data.subarray(start, start + n));
        at = start + n;
      }
    }
    const csAt = text.indexOf('/CharStrings');
    if (csAt < 0) return;
    const begin = text.indexOf('begin', csAt);
    const re = /\s*\/([^\s/[\]{}()<>]+)\s+(\d+)\s+(RD|-\|)\s/y;
    let at = begin + 5;
    for (;;) {
      re.lastIndex = at;
      const m = re.exec(text);
      if (!m) break;
      const start = re.lastIndex;
      const n = Number(m[2]);
      this.charStrings.set(m[1], this.decryptCharString(data.subarray(start, start + n)));
      // Skip the ND (or |-) that ends the entry.
      at = start + n;
      const end = /\s*(ND|\|-|noaccess\s+def|def)/y;
      end.lastIndex = at;
      if (end.exec(text)) at = end.lastIndex;
    }
  }

  private decryptCharString(bytes: Uint8Array): Uint8Array {
    return this.lenIV < 0 ? bytes : decrypt(bytes, CHARSTRING_KEY, this.lenIV);
  }

  /** Interprets a charstring, drawing into `out` with its origin moved by (dx, dy). Returns false once endchar is reached. */
  private run(cs: Uint8Array, out: OutlineBuilder, dx: number, dy: number, depth: number, state = new Type1State()): boolean {
    if (depth > MAX_DEPTH) return false;
    const s = state.stack;
    const move = (x: number, y: number) => {
      state.x = x;
      state.y = y;
      if (state.flex) state.flexPoints.push(x, y);
      else out.moveTo(x + dx, y + dy);
    };
    for (let i = 0; i < cs.length; ) {
      const v = cs[i++];
      if (v >= 32) {
        if (v <= 246) s.push(v - 139);
        else if (v <= 250) s.push((v - 247) * 256 + cs[i++] + 108);
        else if (v <= 254) s.push(-(v - 251) * 256 - cs[i++] - 108);
        else {
          s.push(((cs[i] << 24) | (cs[i + 1] << 16) | (cs[i + 2] << 8) | cs[i + 3]) >> 0);
          i += 4;
        }
        continue;
      }
      switch (v) {
        case 13: // hsbw
          state.x = s[0] ?? 0;
          state.y = 0;
          state.sbx = state.x;
          s.length = 0;
          break;
        case 21: // rmoveto
          move(state.x + (s[0] ?? 0), state.y + (s[1] ?? 0));
          s.length = 0;
          break;
        case 22: // hmoveto
          move(state.x + (s[0] ?? 0), state.y);
          s.length = 0;
          break;
        case 4: // vmoveto
          move(state.x, state.y + (s[0] ?? 0));
          s.length = 0;
          break;
        case 5: // rlineto
          state.x += s[0] ?? 0;
          state.y += s[1] ?? 0;
          out.lineTo(state.x + dx, state.y + dy);
          s.length = 0;
          break;
        case 6: // hlineto
          state.x += s[0] ?? 0;
          out.lineTo(state.x + dx, state.y + dy);
          s.length = 0;
          break;
        case 7: // vlineto
          state.y += s[0] ?? 0;
          out.lineTo(state.x + dx, state.y + dy);
          s.length = 0;
          break;
        case 8: // rrcurveto
          state.curve(out, dx, dy, s[0], s[1], s[2], s[3], s[4], s[5]);
          s.length = 0;
          break;
        case 30: // vhcurveto
          state.curve(out, dx, dy, 0, s[0], s[1], s[2], s[3], 0);
          s.length = 0;
          break;
        case 31: // hvcurveto
          state.curve(out, dx, dy, s[0], 0, s[1], s[2], 0, s[3]);
          s.length = 0;
          break;
        case 9: // closepath
          out.close();
          s.length = 0;
          break;
        case 10: {
          // callsubr
          const n = s.pop() ?? -1;
          const subr = this.subrs[n];
          if (subr && !this.run(subr, out, dx, dy, depth + 1, state)) return false;
          break;
        }
        case 11: // return
          return true;
        case 14: // endchar
          out.close();
          return false;
        case 1: // hstem
        case 3: // vstem
          s.length = 0;
          break;
        case 12: {
          const e = cs[i++];
          if (e === 6) {
            // seac: an accented character built from two others in StandardEncoding
            const [asb, adx, ady, bchar, achar] = s.slice(-5);
            s.length = 0;
            const names = encoding('StandardEncoding');
            const base = this.charStrings.get(names[bchar] ?? '');
            const accent = this.charStrings.get(names[achar] ?? '');
            if (base) this.run(base, out, dx, dy, depth + 1);
            if (accent) this.run(accent, out, dx + adx + state.sbx - asb, dy + ady, depth + 1);
            return false;
          }
          if (e === 7) {
            // sbw
            state.x = s[0] ?? 0;
            state.y = s[1] ?? 0;
            state.sbx = state.x;
            s.length = 0;
          } else if (e === 12) {
            // div
            const b = s.pop() ?? 1;
            const a = s.pop() ?? 0;
            s.push(b ? a / b : 0);
          } else if (e === 16) {
            // callothersubr: flex (0, 1, 2) and hint replacement (3) are the ones fonts use
            const other = s.pop() ?? -1;
            const n = s.pop() ?? 0;
            const args = s.splice(Math.max(0, s.length - n), n);
            if (other === 1) {
              state.flex = true;
              state.flexPoints = [];
            } else if (other === 0 && state.flex) {
              state.flex = false;
              const p = state.flexPoints;
              // p[0..1] is the reference point; then two curves of three points each.
              if (p.length >= 14) {
                out.curveTo(p[2] + dx, p[3] + dy, p[4] + dx, p[5] + dy, p[6] + dx, p[7] + dy);
                out.curveTo(p[8] + dx, p[9] + dy, p[10] + dx, p[11] + dy, p[12] + dx, p[13] + dy);
              }
              // The end point, for the "pop pop setcurrentpoint" that follows.
              state.ps = [args[2] ?? state.y, args[1] ?? state.x];
            } else if (other === 2) {
              // a flex point: recorded by the rmoveto that comes before it
            } else {
              state.ps = args.slice();
            }
          } else if (e === 17) {
            // pop
            s.push(state.ps.pop() ?? 0);
          } else if (e === 33) {
            // setcurrentpoint
            state.x = s[0] ?? state.x;
            state.y = s[1] ?? state.y;
            s.length = 0;
          } else {
            // dotsection, vstem3, hstem3: hints
            s.length = 0;
          }
          break;
        }
        default:
          s.length = 0;
      }
    }
    return true;
  }
}

class Type1State {
  stack: number[] = [];
  x = 0;
  y = 0;
  /** The left side bearing hsbw set: seac places the accent from it. */
  sbx = 0;
  flex = false;
  flexPoints: number[] = [];
  /** What callothersubr left for pop. */
  ps: number[] = [];

  curve(out: OutlineBuilder, dx: number, dy: number, ...d: (number | undefined)[]): void {
    const [a = 0, b = 0, c = 0, e = 0, f = 0, g = 0] = d;
    const x1 = this.x + a;
    const y1 = this.y + b;
    const x2 = x1 + c;
    const y2 = y1 + e;
    this.x = x2 + f;
    this.y = y2 + g;
    out.curveTo(x1 + dx, y1 + dy, x2 + dx, y2 + dy, this.x + dx, this.y + dy);
  }
}

/** Splits a font file into its cleartext and encrypted parts. */
function split(data: Uint8Array, length1?: number): { clear: Uint8Array; encrypted: Uint8Array } {
  // PFB: segments of [0x80, type, length (4 bytes, little-endian)].
  if (data[0] === 0x80 && data[1] === 1) {
    const parts: Uint8Array[][] = [[], []];
    for (let at = 0; at + 6 <= data.length && data[at] === 0x80 && data[at + 1] !== 3; ) {
      const type = data[at + 1];
      const n = data[at + 2] | (data[at + 3] << 8) | (data[at + 4] << 16) | (data[at + 5] << 24);
      if (type === 1 || type === 2) parts[type - 1].push(data.subarray(at + 6, at + 6 + n));
      at += 6 + n;
    }
    return { clear: concat(parts[0]), encrypted: concat(parts[1]) };
  }
  // The encrypted part starts after "eexec" and the whitespace that follows it; Length1 is often wrong.
  let at = indexOf(data, 'eexec');
  if (at < 0) at = length1 ?? data.length;
  else {
    at += 5;
    while (at < data.length && (data[at] === 0x20 || data[at] === 0x0d || data[at] === 0x0a || data[at] === 0x09)) at++;
  }
  return { clear: data.subarray(0, at), encrypted: data.subarray(at) };
}

function indexOf(data: Uint8Array, word: string): number {
  outer: for (let i = 0; i + word.length <= data.length; i++) {
    for (let k = 0; k < word.length; k++) if (data[i + k] !== word.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

function decrypt(data: Uint8Array, key: number, skip: number): Uint8Array {
  const out = new Uint8Array(data.length);
  let r = key;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    out[i] = c ^ (r >> 8);
    r = ((c + r) * 52845 + 22719) & 0xffff;
  }
  return out.subarray(Math.min(skip, out.length));
}

/** Whether the encrypted part is written in hex (the first four bytes are hex digits). */
function isHex(data: Uint8Array): boolean {
  if (data.length < 4) return false;
  for (let i = 0; i < 4; i++) if (hexValue(data[i]) < 0) return false;
  return true;
}

function fromHex(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length >> 1);
  let n = 0;
  let high = -1;
  for (const b of data) {
    const v = hexValue(b);
    if (v < 0) continue;
    if (high < 0) high = v;
    else {
      out[n++] = (high << 4) | v;
      high = -1;
    }
  }
  return out.subarray(0, n);
}

function hexValue(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x37;
  if (b >= 0x61 && b <= 0x66) return b - 0x57;
  return -1;
}

function latin1(data: Uint8Array): string {
  let s = '';
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return s;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
