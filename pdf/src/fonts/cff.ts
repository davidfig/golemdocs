// SPDX-License-Identifier: MIT
// Compact Font Format programs (Adobe TN 5176, charstrings TN 5177): a PDF's /FontFile3 of
// subtype Type1C or CIDFontType0C, or the 'CFF ' table of an OpenType font. Reads the glyph
// names (charset), the built-in encoding, the CID-keyed font dictionaries, and turns a glyph's
// Type 2 charstring into its outline. Hints are skipped.

import { encoding } from './encodings.ts';
import { OutlineBuilder, type Outline } from './outline.ts';

/** Subroutine calls nest at most this deep (the format allows 10). */
const MAX_DEPTH = 16;

interface Private {
  subrs: Uint8Array[];
  bias: number;
}

export class CffFont {
  /** Glyph space to text space. */
  fontMatrix: number[] = [0.001, 0, 0, 0.001, 0, 0];
  /** CID-keyed (has a ROS): `charset` holds CIDs rather than names. */
  readonly cid: boolean;
  /** The built-in encoding: glyph ids by code (simple fonts). */
  readonly encoding = new Map<number, number>();
  private readonly charStrings: Uint8Array[];
  private readonly globalSubrs: Uint8Array[];
  private readonly globalBias: number;
  /** Per glyph: its name (simple fonts) or CID (CID-keyed fonts). */
  private readonly charset: (string | number)[] = [];
  private readonly byName = new Map<string, number>();
  private readonly byCid = new Map<number, number>();
  private readonly privates: Private[] = [];
  /** Which of `privates` each glyph uses (CID-keyed fonts); all use the first otherwise. */
  private fdSelect?: Uint8Array;

  private constructor(private readonly data: Uint8Array) {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let at = data[2]; // header size
    const names = readIndex(data, v, at);
    const topDicts = readIndex(data, v, names.end);
    const strings = readIndex(data, v, topDicts.end);
    const globals = readIndex(data, v, strings.end);
    this.globalSubrs = globals.items;
    this.globalBias = bias(globals.items.length);
    const stringAt = (sid: number) => (sid < STANDARD_STRINGS.length ? STANDARD_STRINGS[sid] : latin1(strings.items[sid - STANDARD_STRINGS.length] ?? new Uint8Array()));

    const top = readDict(topDicts.items[0] ?? new Uint8Array());
    this.cid = top.has(op(12, 30));
    const matrix = top.get(op(12, 7));
    if (matrix?.length === 6) this.fontMatrix = matrix;
    const csOffset = top.get(17)?.[0];
    this.charStrings = csOffset ? readIndex(data, v, csOffset).items : [];
    const nGlyphs = this.charStrings.length;

    // charset: glyph 0 is .notdef (CID 0).
    const charsetOffset = top.get(15)?.[0] ?? 0;
    const ids: number[] = [0];
    if (charsetOffset > 2) {
      at = charsetOffset;
      const format = data[at++];
      if (format === 0) {
        while (ids.length < nGlyphs) {
          ids.push(v.getUint16(at));
          at += 2;
        }
      } else if (format === 1 || format === 2) {
        while (ids.length < nGlyphs && at < data.length) {
          const first = v.getUint16(at);
          const left = format === 1 ? data[at + 2] : v.getUint16(at + 2);
          at += format === 1 ? 3 : 4;
          for (let k = 0; k <= left && ids.length < nGlyphs; k++) ids.push(first + k);
        }
      }
    } else {
      // Predefined ISOAdobe charset (0): SIDs 1..228 in order. Expert charsets (1, 2) are rare in PDFs.
      for (let sid = 1; ids.length < nGlyphs; sid++) ids.push(sid);
    }
    ids.forEach((id, gid) => {
      if (this.cid) {
        this.charset[gid] = id;
        if (!this.byCid.has(id)) this.byCid.set(id, gid);
      } else {
        const name = stringAt(id);
        this.charset[gid] = name;
        if (!this.byName.has(name)) this.byName.set(name, gid);
      }
    });

    if (this.cid) {
      const fdArray = top.get(op(12, 36))?.[0];
      for (const fd of fdArray ? readIndex(data, v, fdArray).items : []) this.privates.push(this.readPrivate(v, readDict(fd)));
      const fdSelect = top.get(op(12, 37))?.[0];
      if (fdSelect) this.fdSelect = readFdSelect(data, v, fdSelect, nGlyphs);
    } else {
      this.privates.push(this.readPrivate(v, top));
      this.readEncoding(v, top.get(16)?.[0] ?? 0);
    }
  }

  static parse(data: Uint8Array): CffFont {
    return new CffFont(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }

  get glyphCount(): number {
    return this.charStrings.length;
  }

  /** The glyph with this name (simple fonts), or -1. */
  glyphByName(name: string): number {
    return this.byName.get(name) ?? -1;
  }

  /** The glyph with this CID (CID-keyed fonts; in any other font the CID is the glyph id), or -1. */
  glyphByCid(cid: number): number {
    if (!this.cid) return cid < this.charStrings.length ? cid : -1;
    return this.byCid.get(cid) ?? -1;
  }

  /** The glyph's outline in glyph space (multiply by fontMatrix for text space), or null if there is no such glyph. */
  outline(gid: number): Outline | null {
    const cs = this.charStrings[gid];
    if (!cs) return null;
    const out = new OutlineBuilder();
    this.run(cs, out, this.privates[this.fdSelect?.[gid] ?? 0] ?? { subrs: [], bias: 0 }, new Type2State(), 0, 0, 0);
    return out.done();
  }

  private readPrivate(v: DataView, dict: Map<number, number[]>): Private {
    const [size, offset] = dict.get(18) ?? [0, 0];
    if (!size) return { subrs: [], bias: 0 };
    const priv = readDict(this.data.subarray(offset, offset + size));
    const subrsAt = priv.get(19)?.[0];
    const subrs = subrsAt ? readIndex(this.data, v, offset + subrsAt).items : [];
    return { subrs, bias: bias(subrs.length) };
  }

  private readEncoding(v: DataView, offset: number): void {
    if (offset <= 1) {
      // Standard (0) or Expert (1) encoding: codes by glyph name.
      if (offset === 0) encoding('StandardEncoding').forEach((name, code) => {
        const gid = name ? this.byName.get(name) : undefined;
        if (gid !== undefined) this.encoding.set(code, gid);
      });
      return;
    }
    let at = offset;
    const format = this.data[at++];
    if ((format & 0x7f) === 0) {
      const n = this.data[at++];
      for (let gid = 1; gid <= n; gid++) this.encoding.set(this.data[at++], gid);
    } else if ((format & 0x7f) === 1) {
      const ranges = this.data[at++];
      let gid = 1;
      for (let r = 0; r < ranges; r++) {
        const first = this.data[at++];
        const left = this.data[at++];
        for (let k = 0; k <= left; k++) this.encoding.set(first + k, gid++);
      }
    }
    if (format & 0x80) {
      // Supplements: more codes for glyphs, by name.
      const n = this.data[at++];
      for (let k = 0; k < n; k++, at += 3) {
        const code = this.data[at];
        const sid = v.getUint16(at + 1);
        const gid = this.byName.get(sid < STANDARD_STRINGS.length ? STANDARD_STRINGS[sid] : '');
        if (gid !== undefined) this.encoding.set(code, gid);
      }
    }
  }

  /** Interprets a Type 2 charstring. Returns false once endchar is reached. */
  private run(cs: Uint8Array, out: OutlineBuilder, priv: Private, st: Type2State, dx: number, dy: number, depth: number): boolean {
    if (depth > MAX_DEPTH) return false;
    const s = st.stack;
    /** The first stack-clearing operator may carry the glyph's width before its arguments: drops it. */
    const width = (extra: boolean) => {
      if (!st.started && extra) s.shift();
      st.started = true;
    };
    const line = (x: number, y: number) => {
      st.x = x;
      st.y = y;
      out.lineTo(x + dx, y + dy);
    };
    const curve = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => {
      st.x = x;
      st.y = y;
      out.curveTo(x1 + dx, y1 + dy, x2 + dx, y2 + dy, x + dx, y + dy);
    };
    const stems = () => {
      width(s.length % 2 === 1);
      st.stems += s.length >> 1;
      s.length = 0;
    };
    for (let i = 0; i < cs.length; ) {
      const v = cs[i++];
      if (v >= 32 || v === 28) {
        if (v === 28) {
          s.push((((cs[i] << 8) | cs[i + 1]) << 16) >> 16);
          i += 2;
        } else if (v <= 246) s.push(v - 139);
        else if (v <= 250) s.push((v - 247) * 256 + cs[i++] + 108);
        else if (v <= 254) s.push(-(v - 251) * 256 - cs[i++] - 108);
        else {
          s.push(((cs[i] << 24) | (cs[i + 1] << 16) | (cs[i + 2] << 8) | cs[i + 3]) / 65536);
          i += 4;
        }
        continue;
      }
      switch (v) {
        case 1: // hstem
        case 3: // vstem
        case 18: // hstemhm
        case 23: // vstemhm
          stems();
          break;
        case 19: // hintmask
        case 20: // cntrmask
          // Stems given just before it are vstems.
          stems();
          i += (st.stems + 7) >> 3;
          break;
        case 21: // rmoveto
          width(s.length > 2);
          st.x += s[s.length - 2] ?? 0;
          st.y += s[s.length - 1] ?? 0;
          out.moveTo(st.x + dx, st.y + dy);
          s.length = 0;
          break;
        case 22: // hmoveto
          width(s.length > 1);
          st.x += s[s.length - 1] ?? 0;
          out.moveTo(st.x + dx, st.y + dy);
          s.length = 0;
          break;
        case 4: // vmoveto
          width(s.length > 1);
          st.y += s[s.length - 1] ?? 0;
          out.moveTo(st.x + dx, st.y + dy);
          s.length = 0;
          break;
        case 5: // rlineto
          for (let k = 0; k + 1 < s.length; k += 2) line(st.x + s[k], st.y + s[k + 1]);
          s.length = 0;
          break;
        case 6: // hlineto
        case 7: // vlineto
          for (let k = 0; k < s.length; k++) {
            if ((k % 2 === 0) === (v === 6)) line(st.x + s[k], st.y);
            else line(st.x, st.y + s[k]);
          }
          s.length = 0;
          break;
        case 8: // rrcurveto
          for (let k = 0; k + 5 < s.length; k += 6) this.rcurve(st, curve, s, k);
          s.length = 0;
          break;
        case 24: {
          // rcurveline
          let k = 0;
          for (; k + 7 < s.length; k += 6) this.rcurve(st, curve, s, k);
          if (k + 1 < s.length) line(st.x + s[k], st.y + s[k + 1]);
          s.length = 0;
          break;
        }
        case 25: {
          // rlinecurve
          let k = 0;
          for (; k + 7 < s.length; k += 2) line(st.x + s[k], st.y + s[k + 1]);
          if (k + 5 < s.length) this.rcurve(st, curve, s, k);
          s.length = 0;
          break;
        }
        case 26: {
          // vvcurveto
          let k = 0;
          let x = st.x;
          if (s.length % 4 === 1) x += s[k++];
          for (; k + 3 < s.length; k += 4) {
            const x1 = x;
            const y1 = st.y + s[k];
            const x2 = x1 + s[k + 1];
            const y2 = y1 + s[k + 2];
            curve(x1, y1, x2, y2, x2, y2 + s[k + 3]);
            x = st.x;
          }
          s.length = 0;
          break;
        }
        case 27: {
          // hhcurveto
          let k = 0;
          let y = st.y;
          if (s.length % 4 === 1) y += s[k++];
          for (; k + 3 < s.length; k += 4) {
            const x1 = st.x + s[k];
            const y1 = y;
            const x2 = x1 + s[k + 1];
            const y2 = y1 + s[k + 2];
            curve(x1, y1, x2, y2, x2 + s[k + 3], y2);
            y = st.y;
          }
          s.length = 0;
          break;
        }
        case 30: // vhcurveto
        case 31: {
          // hvcurveto: curves alternate starting horizontal and vertical
          let horizontal = v === 31;
          for (let k = 0; k + 3 < s.length; k += 4) {
            const last = k + 5 === s.length;
            if (horizontal) {
              const x1 = st.x + s[k];
              const y1 = st.y;
              const x2 = x1 + s[k + 1];
              const y2 = y1 + s[k + 2];
              curve(x1, y1, x2, y2, x2 + (last ? s[k + 4] : 0), y2 + s[k + 3]);
            } else {
              const x1 = st.x;
              const y1 = st.y + s[k];
              const x2 = x1 + s[k + 1];
              const y2 = y1 + s[k + 2];
              curve(x1, y1, x2, y2, x2 + s[k + 3], y2 + (last ? s[k + 4] : 0));
            }
            horizontal = !horizontal;
          }
          s.length = 0;
          break;
        }
        case 10: // callsubr
        case 29: {
          // callgsubr
          const n = (s.pop() ?? 0) + (v === 10 ? priv.bias : this.globalBias);
          const subr = (v === 10 ? priv.subrs : this.globalSubrs)[n];
          if (subr && !this.run(subr, out, priv, st, dx, dy, depth + 1)) return false;
          break;
        }
        case 11: // return
          return true;
        case 14: {
          // endchar, with four arguments the same as Type 1's seac
          width(s.length === 1 || s.length === 5);
          if (s.length >= 4 && !this.cid) {
            const [adx, ady, bchar, achar] = s.slice(-4);
            const names = encoding('StandardEncoding');
            const base = this.byName.get(names[bchar] ?? '');
            const accent = this.byName.get(names[achar] ?? '');
            out.close();
            if (base !== undefined) this.run(this.charStrings[base], out, priv, new Type2State(), dx, dy, depth + 1);
            if (accent !== undefined) this.run(this.charStrings[accent], out, priv, new Type2State(), dx + adx, dy + ady, depth + 1);
          }
          out.close();
          return false;
        }
        case 12: {
          const e = cs[i++];
          this.escape(e, st, curve, s);
          break;
        }
        default:
          s.length = 0;
      }
    }
    return true;
  }

  private rcurve(st: Type2State, curve: (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => void, s: number[], k: number): void {
    const x1 = st.x + s[k];
    const y1 = st.y + s[k + 1];
    const x2 = x1 + s[k + 2];
    const y2 = y1 + s[k + 3];
    curve(x1, y1, x2, y2, x2 + s[k + 4], y2 + s[k + 5]);
  }

  /** The escaped (12 x) operators: flex curves and arithmetic. */
  private escape(e: number, st: Type2State, curve: (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => void, s: number[]): void {
    const x0 = st.x;
    const y0 = st.y;
    switch (e) {
      case 35: {
        // flex: two curves, all coordinates given
        if (s.length < 12) break;
        const p: number[] = [];
        let x = x0;
        let y = y0;
        for (let k = 0; k < 12; k += 2) p.push((x += s[k]), (y += s[k + 1]));
        curve(p[0], p[1], p[2], p[3], p[4], p[5]);
        curve(p[6], p[7], p[8], p[9], p[10], p[11]);
        break;
      }
      case 34: {
        // hflex
        if (s.length < 7) break;
        const [d1, d2, d3, d4, d5, d6, d7] = s;
        const x1 = x0 + d1;
        const x2 = x1 + d2;
        const y2 = y0 + d3;
        const x3 = x2 + d4;
        const x4 = x3 + d5;
        const x5 = x4 + d6;
        const x6 = x5 + d7;
        curve(x1, y0, x2, y2, x3, y2);
        curve(x4, y2, x5, y0, x6, y0);
        break;
      }
      case 36: {
        // hflex1
        if (s.length < 9) break;
        const [d1, d2, d3, d4, d5, d6, d7, d8, d9] = s;
        const x1 = x0 + d1;
        const y1 = y0 + d2;
        const x2 = x1 + d3;
        const y2 = y1 + d4;
        const x3 = x2 + d5;
        const x4 = x3 + d6;
        const x5 = x4 + d7;
        const y5 = y2 + d8;
        const x6 = x5 + d9;
        curve(x1, y1, x2, y2, x3, y2);
        curve(x4, y2, x5, y5, x6, y0);
        break;
      }
      case 37: {
        // flex1: the last point moves along whichever axis the curve travels further
        if (s.length < 11) break;
        const p: number[] = [];
        let x = x0;
        let y = y0;
        for (let k = 0; k < 10; k += 2) p.push((x += s[k]), (y += s[k + 1]));
        const dx = p[8] - x0;
        const dy = p[9] - y0;
        const [ex, ey] = Math.abs(dx) > Math.abs(dy) ? [p[8] + s[10], y0] : [x0, p[9] + s[10]];
        curve(p[0], p[1], p[2], p[3], p[4], p[5]);
        curve(p[6], p[7], p[8], p[9], ex, ey);
        break;
      }
      // Arithmetic: rare in fonts, but cheap.
      case 9:
        s.push(Math.abs(s.pop() ?? 0));
        return;
      case 10:
        s.push((s.pop() ?? 0) + (s.pop() ?? 0));
        return;
      case 11: {
        const b = s.pop() ?? 0;
        s.push((s.pop() ?? 0) - b);
        return;
      }
      case 12: {
        const b = s.pop() ?? 1;
        const a = s.pop() ?? 0;
        s.push(b ? a / b : 0);
        return;
      }
      case 14:
        s.push(-(s.pop() ?? 0));
        return;
      case 18:
        s.pop();
        return;
      case 24:
        s.push((s.pop() ?? 0) * (s.pop() ?? 0));
        return;
      case 27:
        s.push(s[s.length - 1] ?? 0);
        return;
      case 28: {
        const b = s.pop() ?? 0;
        const a = s.pop() ?? 0;
        s.push(b, a);
        return;
      }
    }
    s.length = 0;
  }
}

class Type2State {
  stack: number[] = [];
  x = 0;
  y = 0;
  stems = 0;
  /** Past the first stack-clearing operator (which may carry the width). */
  started = false;
}

function op(a: number, b: number): number {
  return a === 12 ? 1200 + b : a;
}

function bias(count: number): number {
  return count < 1240 ? 107 : count < 33900 ? 1131 : 32768;
}

function readIndex(data: Uint8Array, v: DataView, at: number): { items: Uint8Array[]; end: number } {
  if (at + 2 > data.length) return { items: [], end: at };
  const count = v.getUint16(at);
  if (count === 0) return { items: [], end: at + 2 };
  const size = data[at + 2];
  const offsetAt = at + 3;
  const readOffset = (i: number) => {
    let n = 0;
    for (let k = 0; k < size; k++) n = n * 256 + data[offsetAt + i * size + k];
    return n;
  };
  const base = offsetAt + (count + 1) * size - 1;
  const items: Uint8Array[] = [];
  for (let i = 0; i < count; i++) items.push(data.subarray(base + readOffset(i), base + readOffset(i + 1)));
  return { items, end: base + readOffset(count) };
}

/** A DICT's operands by operator (two-byte operators as 1200 + the second byte). */
function readDict(data: Uint8Array): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let operands: number[] = [];
  for (let i = 0; i < data.length; ) {
    const b = data[i++];
    if (b <= 21) {
      out.set(b === 12 ? 1200 + data[i++] : b, operands);
      operands = [];
    } else if (b === 28) {
      operands.push((((data[i] << 8) | data[i + 1]) << 16) >> 16);
      i += 2;
    } else if (b === 29) {
      operands.push((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]);
      i += 4;
    } else if (b === 30) {
      // A real number, as nibbles.
      let s = '';
      for (let done = false; !done && i < data.length; ) {
        const byte = data[i++];
        for (const nibble of [byte >> 4, byte & 15]) {
          if (nibble === 15) {
            done = true;
            break;
          }
          s += ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', 'E', 'E-', '', '-'][nibble];
        }
      }
      operands.push(Number(s) || 0);
    } else if (b >= 32 && b <= 246) operands.push(b - 139);
    else if (b >= 247 && b <= 250) operands.push((b - 247) * 256 + data[i++] + 108);
    else if (b >= 251 && b <= 254) operands.push(-(b - 251) * 256 - data[i++] - 108);
  }
  return out;
}

function readFdSelect(data: Uint8Array, v: DataView, at: number, nGlyphs: number): Uint8Array {
  const out = new Uint8Array(nGlyphs);
  const format = data[at];
  if (format === 0) for (let g = 0; g < nGlyphs; g++) out[g] = data[at + 1 + g];
  else if (format === 3) {
    const ranges = v.getUint16(at + 1);
    for (let r = 0; r < ranges; r++) {
      const first = v.getUint16(at + 3 + r * 3);
      const fd = data[at + 5 + r * 3];
      const end = v.getUint16(at + 6 + r * 3);
      for (let g = first; g < Math.min(end, nGlyphs); g++) out[g] = fd;
    }
  }
  return out;
}

function latin1(data: Uint8Array): string {
  return String.fromCharCode(...data);
}

/** The CFF standard strings (TN 5176, Appendix A): SIDs 0-390. */
const STANDARD_STRINGS: string[] = (
  '.notdef space exclam quotedbl numbersign dollar percent ampersand quoteright parenleft parenright asterisk plus comma hyphen period slash ' +
  'zero one two three four five six seven eight nine colon semicolon less equal greater question at ' +
  'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore quoteleft ' +
  'a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde ' +
  'exclamdown cent sterling fraction yen florin section currency quotesingle quotedblleft guillemotleft guilsinglleft guilsinglright fi fl ' +
  'endash dagger daggerdbl periodcentered paragraph bullet quotesinglbase quotedblbase quotedblright guillemotright ellipsis perthousand ' +
  'questiondown grave acute circumflex tilde macron breve dotaccent dieresis ring cedilla hungarumlaut ogonek caron emdash ' +
  'AE ordfeminine Lslash Oslash OE ordmasculine ae dotlessi lslash oslash oe germandbls ' +
  'onesuperior logicalnot mu trademark Eth onehalf plusminus Thorn onequarter divide brokenbar degree thorn threequarters twosuperior ' +
  'registered minus eth multiply threesuperior copyright ' +
  'Aacute Acircumflex Adieresis Agrave Aring Atilde Ccedilla Eacute Ecircumflex Edieresis Egrave Iacute Icircumflex Idieresis Igrave ' +
  'Ntilde Oacute Ocircumflex Odieresis Ograve Otilde Scaron Uacute Ucircumflex Udieresis Ugrave Yacute Ydieresis Zcaron ' +
  'aacute acircumflex adieresis agrave aring atilde ccedilla eacute ecircumflex edieresis egrave iacute icircumflex idieresis igrave ' +
  'ntilde oacute ocircumflex odieresis ograve otilde scaron uacute ucircumflex udieresis ugrave yacute ydieresis zcaron ' +
  'exclamsmall Hungarumlautsmall dollaroldstyle dollarsuperior ampersandsmall Acutesmall parenleftsuperior parenrightsuperior ' +
  'twodotenleader onedotenleader zerooldstyle oneoldstyle twooldstyle threeoldstyle fouroldstyle fiveoldstyle sixoldstyle ' +
  'sevenoldstyle eightoldstyle nineoldstyle commasuperior threequartersemdash periodsuperior questionsmall asuperior bsuperior ' +
  'centsuperior dsuperior esuperior isuperior lsuperior msuperior nsuperior osuperior rsuperior ssuperior tsuperior ff ffi ffl ' +
  'parenleftinferior parenrightinferior Circumflexsmall hyphensuperior Gravesmall ' +
  'Asmall Bsmall Csmall Dsmall Esmall Fsmall Gsmall Hsmall Ismall Jsmall Ksmall Lsmall Msmall Nsmall Osmall Psmall Qsmall Rsmall ' +
  'Ssmall Tsmall Usmall Vsmall Wsmall Xsmall Ysmall Zsmall colonmonetary onefitted rupiah Tildesmall exclamdownsmall centoldstyle ' +
  'Lslashsmall Scaronsmall Zcaronsmall Dieresissmall Brevesmall Caronsmall Dotaccentsmall Macronsmall figuredash hypheninferior ' +
  'Ogoneksmall Ringsmall Cedillasmall questiondownsmall oneeighth threeeighths fiveeighths seveneighths onethird twothirds ' +
  'zerosuperior foursuperior fivesuperior sixsuperior sevensuperior eightsuperior ninesuperior ' +
  'zeroinferior oneinferior twoinferior threeinferior fourinferior fiveinferior sixinferior seveninferior eightinferior nineinferior ' +
  'centinferior dollarinferior periodinferior commainferior Agravesmall Aacutesmall Acircumflexsmall Atildesmall Adieresissmall ' +
  'Aringsmall AEsmall Ccedillasmall Egravesmall Eacutesmall Ecircumflexsmall Edieresissmall Igravesmall Iacutesmall ' +
  'Icircumflexsmall Idieresissmall Ethsmall Ntildesmall Ogravesmall Oacutesmall Ocircumflexsmall Otildesmall Odieresissmall ' +
  'OEsmall Oslashsmall Ugravesmall Uacutesmall Ucircumflexsmall Udieresissmall Yacutesmall Thornsmall Ydieresissmall ' +
  '001.000 001.001 001.002 001.003 Black Bold Book Light Medium Regular Roman Semibold'
).split(' ');
