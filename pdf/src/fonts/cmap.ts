// SPDX-License-Identifier: MIT
// CMaps (§9.7.5, §9.10.3): the character-code to CID maps of composite fonts, and ToUnicode
// maps. Parsed from the PostScript-like CMap syntax; of the predefined CMaps only Identity
// and the Unicode-based (Uni*-UCS2/UTF16) ones are understood without an embedded CMap.

import { PdfName, PdfString } from '../core/objects.ts';
import { Keyword, Parser } from '../core/parser.ts';

interface CodespaceRange {
  bytes: number;
  low: number;
  high: number;
  lowBytes: number[];
  highBytes: number[];
}

export class CMap {
  readonly codespace: CodespaceRange[] = [];
  /** code (with its byte length packed as length * 2^32 + code) to CID. */
  private readonly cids = new Map<number, number>();
  private readonly cidRanges: { bytes: number; low: number; high: number; cid: number }[] = [];
  /** code (packed like cids) to Unicode text. */
  private readonly unicode = new Map<number, string>();
  vertical = false;
  /** Identity mapping: 2-byte codes are CIDs (Identity-H/V). */
  identity = false;
  /** Codes are UTF-16BE (predefined Uni*-UCS2 / UTF16 CMaps). */
  unicodeCodes = false;
  name = '';

  static identityCMap(vertical = false): CMap {
    const c = new CMap();
    c.identity = true;
    c.vertical = vertical;
    c.name = vertical ? 'Identity-V' : 'Identity-H';
    c.addCodespace(2, [0, 0], [0xff, 0xff]);
    return c;
  }

  /** A predefined CMap by name; undefined for those not built in. */
  static predefined(name: string): CMap | undefined {
    if (name === 'Identity-H' || name === 'Identity-V') return CMap.identityCMap(name.endsWith('-V'));
    if (/^Uni.*-(UCS2|UTF16)-[HV]$/.test(name)) {
      const c = new CMap();
      c.name = name;
      c.unicodeCodes = true;
      c.vertical = name.endsWith('-V');
      if (name.includes('UTF16')) {
        c.addCodespace(2, [0, 0], [0xd7, 0xff]);
        c.addCodespace(4, [0xd8, 0, 0xdc, 0], [0xdb, 0xff, 0xdf, 0xff]);
        c.addCodespace(2, [0xe0, 0], [0xff, 0xff]);
      } else c.addCodespace(2, [0, 0], [0xff, 0xff]);
      return c;
    }
    return undefined;
  }

  /** Parses an embedded CMap or ToUnicode stream. `parent` resolves `usecmap`. */
  static parse(data: Uint8Array, parent?: (name: string) => CMap | undefined): CMap {
    const c = new CMap();
    const p = new Parser(data);
    const stack: unknown[] = [];
    for (;;) {
      let t;
      try {
        t = p.readToken();
      } catch {
        break;
      }
      if (t === undefined) break;
      if (!(t instanceof Keyword)) {
        if (t !== null && typeof t === 'object' && 'punct' in t) {
          if (t.punct === '[') stack.push('[');
          else if (t.punct === ']') {
            const i = stack.lastIndexOf('[');
            if (i >= 0) stack.push(stack.splice(i).slice(1));
          }
          continue;
        }
        stack.push(t);
        continue;
      }
      const op = t.value;
      switch (op) {
        case 'endcodespacerange':
          for (let i = 0; i + 1 < stack.length; i += 2) {
            const lo = stack[i], hi = stack[i + 1];
            if (lo instanceof PdfString && hi instanceof PdfString && lo.bytes.length === hi.bytes.length && lo.bytes.length) {
              c.addCodespace(lo.bytes.length, [...lo.bytes], [...hi.bytes]);
            }
          }
          break;
        case 'endbfchar':
          for (let i = 0; i + 1 < stack.length; i += 2) {
            const src = stack[i], dst = stack[i + 1];
            if (!(src instanceof PdfString)) continue;
            const text = dst instanceof PdfString ? utf16be(dst.bytes) : dst instanceof PdfName ? dst.name : undefined;
            if (text !== undefined) c.unicode.set(pack(src.bytes), text);
          }
          break;
        case 'endbfrange':
          for (let i = 0; i + 2 < stack.length; i += 3) {
            const lo = stack[i], hi = stack[i + 1], dst = stack[i + 2];
            if (!(lo instanceof PdfString) || !(hi instanceof PdfString)) continue;
            const n = lo.bytes.length;
            const start = value(lo.bytes), end = value(hi.bytes);
            if (end < start || end - start > 0xffff) continue;
            for (let code = start; code <= end; code++) {
              const k = code + n * 2 ** 32;
              if (Array.isArray(dst)) {
                const d = dst[code - start];
                if (d instanceof PdfString) c.unicode.set(k, utf16be(d.bytes));
              } else if (dst instanceof PdfString && dst.bytes.length) {
                // Increment the destination's last byte (carrying, as most readers do).
                const b = Uint8Array.from(dst.bytes);
                let add = code - start;
                for (let j = b.length - 1; j >= 0 && add; j--) {
                  const s = b[j] + add;
                  b[j] = s & 0xff;
                  add = s >> 8;
                }
                c.unicode.set(k, utf16be(b));
              }
            }
          }
          break;
        case 'endcidchar':
          for (let i = 0; i + 1 < stack.length; i += 2) {
            const src = stack[i], cid = stack[i + 1];
            if (src instanceof PdfString && typeof cid === 'number') c.cids.set(pack(src.bytes), cid);
          }
          break;
        case 'endcidrange':
          for (let i = 0; i + 2 < stack.length; i += 3) {
            const lo = stack[i], hi = stack[i + 1], cid = stack[i + 2];
            if (lo instanceof PdfString && hi instanceof PdfString && typeof cid === 'number') {
              c.cidRanges.push({ bytes: lo.bytes.length, low: value(lo.bytes), high: value(hi.bytes), cid });
            }
          }
          break;
        case 'usecmap': {
          const n = stack[stack.length - 1];
          const base = n instanceof PdfName ? (parent?.(n.name) ?? CMap.predefined(n.name)) : undefined;
          if (base) c.inherit(base);
          break;
        }
        case 'def': {
          const [key, v] = stack.slice(-2);
          if (key instanceof PdfName && key.name === 'WMode' && v === 1) c.vertical = true;
          if (key instanceof PdfName && key.name === 'CMapName' && v instanceof PdfName) c.name = v.name;
          break;
        }
      }
      if (op.startsWith('end') || op === 'usecmap' || op === 'def' || op === 'begincmap') stack.length = 0;
      else if (op.startsWith('begin')) {
        // begin* takes a count operand we don't need
        stack.length = 0;
      }
    }
    return c;
  }

  private inherit(base: CMap): void {
    if (!this.codespace.length) this.codespace.push(...base.codespace);
    for (const [k, v] of base.cids) if (!this.cids.has(k)) this.cids.set(k, v);
    this.cidRanges.push(...base.cidRanges);
    for (const [k, v] of base.unicode) if (!this.unicode.has(k)) this.unicode.set(k, v);
    this.identity ||= base.identity;
    this.unicodeCodes ||= base.unicodeCodes;
    this.vertical ||= base.vertical;
  }

  addCodespace(bytes: number, lowBytes: number[], highBytes: number[]): void {
    this.codespace.push({ bytes, low: value(lowBytes), high: value(highBytes), lowBytes, highBytes });
  }

  get hasUnicode(): boolean {
    return this.unicode.size > 0;
  }

  /**
   * Splits a string into codes. Without codespace ranges (a bare ToUnicode map), the code
   * length is taken from the map's entries, defaulting to one byte.
   */
  *codes(bytes: Uint8Array, defaultBytes = 1): IterableIterator<{ code: number; bytes: number }> {
    const ranges = this.codespace;
    for (let i = 0; i < bytes.length; ) {
      let n = 0;
      if (ranges.length) {
        outer: for (let len = 1; len <= 4 && i + len <= bytes.length; len++) {
          for (const r of ranges) {
            if (r.bytes !== len) continue;
            let ok = true;
            for (let k = 0; k < len; k++) {
              const b = bytes[i + k];
              if (b < r.lowBytes[k] || b > r.highBytes[k]) {
                ok = false;
                break;
              }
            }
            if (ok) {
              n = len;
              break outer;
            }
          }
        }
        // No range matches: consume the shortest codespace length (§9.7.6.3).
        if (!n) n = Math.min(...ranges.map((r) => r.bytes), bytes.length - i);
      } else n = Math.min(defaultBytes, bytes.length - i);
      yield { code: value(bytes.subarray(i, i + n)), bytes: n };
      i += n;
    }
  }

  cid(code: number, bytes: number): number {
    if (this.identity || this.unicodeCodes) return code;
    const direct = this.cids.get(code + bytes * 2 ** 32);
    if (direct !== undefined) return direct;
    for (const r of this.cidRanges) if (r.bytes === bytes && code >= r.low && code <= r.high) return r.cid + code - r.low;
    return 0;
  }

  /** Unicode for a code; undefined if unmapped. */
  lookup(code: number, bytes: number): string | undefined {
    const u = this.unicode.get(code + bytes * 2 ** 32);
    if (u !== undefined) return u;
    if (this.unicodeCodes) return bytes === 4 ? String.fromCharCode(code >>> 16, code & 0xffff) : String.fromCharCode(code);
    return undefined;
  }

  /** Unicode lookup without knowing the code length (ToUnicode maps used with another CMap). */
  lookupAny(code: number, bytes: number): string | undefined {
    return this.unicode.get(code + bytes * 2 ** 32) ?? (bytes !== 2 ? this.unicode.get(code + 2 * 2 ** 32) : undefined) ?? (bytes !== 1 ? this.unicode.get(code + 2 ** 32) : undefined);
  }

  /** Every code with Unicode text: [code, its length in bytes, the text]. */
  *entries(): IterableIterator<[number, number, string]> {
    for (const [key, text] of this.unicode) yield [key % 2 ** 32, Math.floor(key / 2 ** 32), text];
  }

  /** Number of bytes the ToUnicode entries use most (for splitting without codespace ranges). */
  get typicalBytes(): number {
    let one = 0, two = 0;
    for (const k of this.unicode.keys()) {
      const n = Math.floor(k / 2 ** 32);
      if (n === 1) one++;
      else if (n === 2) two++;
    }
    return two > one ? 2 : 1;
  }
}

const pack = (b: Uint8Array): number => value(b) + b.length * 2 ** 32;

function value(b: ArrayLike<number>): number {
  let v = 0;
  for (let i = 0; i < b.length; i++) v = v * 256 + b[i];
  return v;
}

function utf16be(b: Uint8Array): string {
  if (b.length === 1) return String.fromCharCode(b[0]);
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  return s;
}
