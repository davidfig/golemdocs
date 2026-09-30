// TrueType/OpenType font files (the sfnt container): enough of the tables to embed a font in
// a PDF, map characters to glyphs, measure them, and subset TrueType outlines.

export class FontFormatError extends Error {}

interface TableRecord {
  offset: number;
  length: number;
}

export class TrueTypeFont {
  readonly tables = new Map<string, TableRecord>();
  readonly view: DataView;
  /** CFF outlines ('OTTO'): embedded whole, since only TrueType outlines are subset here. */
  readonly isCff: boolean;
  unitsPerEm = 1000;
  numGlyphs = 0;
  /** Font-wide metrics in font units. */
  ascent = 0;
  descent = 0;
  lineGap = 0;
  capHeight = 0;
  xHeight = 0;
  bbox: [number, number, number, number] = [0, 0, 0, 0];
  italicAngle = 0;
  fixedPitch = false;
  weight = 400;
  postscriptName = '';
  familyName = '';
  /** OS/2 fsType embedding bits (bit 1 = restricted license, bit 9 = bitmap only). */
  embeddingFlags = 0;
  private advances: Uint16Array = new Uint16Array(0);
  private cmap = new Map<number, number>();
  private locaOffsets?: Uint32Array;

  readonly bytes: Uint8Array;

  private constructor(bytes: Uint8Array) {
    // A plain view: Node Buffers' slice() shares memory, which would corrupt subsetting.
    this.bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    bytes = this.bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = this.tag(0);
    if (tag === 'ttcf') throw new FontFormatError('TrueType collections (.ttc) are not supported; extract one font first');
    if (tag !== '\0\x01\0\0' && tag !== 'true' && tag !== 'OTTO') throw new FontFormatError('not a TrueType/OpenType font');
    this.isCff = tag === 'OTTO';
    const count = this.view.getUint16(4);
    for (let i = 0; i < count; i++) {
      const rec = 12 + i * 16;
      this.tables.set(this.tag(rec), { offset: this.view.getUint32(rec + 8), length: this.view.getUint32(rec + 12) });
    }
  }

  static parse(bytes: Uint8Array): TrueTypeFont {
    const f = new TrueTypeFont(bytes);
    try {
      f.read();
    } catch (e) {
      if (e instanceof FontFormatError) throw e;
      throw new FontFormatError(`damaged font (${(e as Error).message})`);
    }
    return f;
  }

  private tag(at: number): string {
    return String.fromCharCode(this.bytes[at], this.bytes[at + 1], this.bytes[at + 2], this.bytes[at + 3]);
  }

  table(tag: string): TableRecord | undefined {
    return this.tables.get(tag);
  }

  private require(tag: string): TableRecord {
    const t = this.tables.get(tag);
    if (!t) throw new FontFormatError(`missing '${tag}' table`);
    return t;
  }

  private read(): void {
    const v = this.view;
    const head = this.require('head');
    this.unitsPerEm = v.getUint16(head.offset + 18) || 1000;
    this.bbox = [v.getInt16(head.offset + 36), v.getInt16(head.offset + 38), v.getInt16(head.offset + 40), v.getInt16(head.offset + 42)];
    const maxp = this.require('maxp');
    this.numGlyphs = v.getUint16(maxp.offset + 4);

    const hhea = this.require('hhea');
    this.ascent = v.getInt16(hhea.offset + 4);
    this.descent = v.getInt16(hhea.offset + 6);
    this.lineGap = v.getInt16(hhea.offset + 8);
    const numberOfHMetrics = v.getUint16(hhea.offset + 34);
    const hmtx = this.require('hmtx');
    this.advances = new Uint16Array(this.numGlyphs);
    let last = 0;
    for (let g = 0; g < this.numGlyphs; g++) {
      if (g < numberOfHMetrics && hmtx.offset + g * 4 + 2 <= this.bytes.length) last = v.getUint16(hmtx.offset + g * 4);
      this.advances[g] = last;
    }

    const os2 = this.tables.get('OS/2');
    if (os2 && os2.length >= 78) {
      this.weight = v.getUint16(os2.offset + 4);
      this.embeddingFlags = v.getUint16(os2.offset + 8);
      const version = v.getUint16(os2.offset);
      const typoAscender = v.getInt16(os2.offset + 68);
      const typoDescender = v.getInt16(os2.offset + 70);
      const useTypo = (v.getUint16(os2.offset + 62) & 0x80) !== 0;
      if (useTypo) {
        this.ascent = typoAscender;
        this.descent = typoDescender;
      }
      if (version >= 2 && os2.length >= 96) {
        this.xHeight = v.getInt16(os2.offset + 86);
        this.capHeight = v.getInt16(os2.offset + 88);
      }
    }
    if (!this.capHeight) this.capHeight = this.ascent;

    const post = this.tables.get('post');
    if (post) {
      this.italicAngle = v.getInt32(post.offset + 4) / 65536;
      this.fixedPitch = v.getUint32(post.offset + 12) !== 0;
    }
    this.readName();
    this.readCmap();
    if (!this.isCff) this.readLoca();
  }

  private readName(): void {
    const t = this.tables.get('name');
    if (!t) return;
    const v = this.view;
    const count = v.getUint16(t.offset + 2);
    const strings = t.offset + v.getUint16(t.offset + 4);
    const found = new Map<number, string>();
    for (let i = 0; i < count; i++) {
      const r = t.offset + 6 + i * 12;
      const platform = v.getUint16(r);
      const enc = v.getUint16(r + 2);
      const id = v.getUint16(r + 6);
      const len = v.getUint16(r + 8);
      const off = strings + v.getUint16(r + 10);
      if (id !== 1 && id !== 6) continue;
      let s = '';
      if (platform === 3 || platform === 0) {
        for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(v.getUint16(off + k));
      } else if (platform === 1 && enc === 0) {
        for (let k = 0; k < len; k++) s += String.fromCharCode(this.bytes[off + k]);
      } else continue;
      if (!found.has(id) || platform === 3) found.set(id, s);
    }
    this.familyName = found.get(1) ?? '';
    this.postscriptName = (found.get(6) ?? this.familyName).replace(/[^\x21-\x7e]|[[\](){}<>/%]/g, '');
  }

  private readCmap(): void {
    const t = this.tables.get('cmap');
    if (!t) return;
    const v = this.view;
    const n = v.getUint16(t.offset + 2);
    // Prefer full Unicode (3,10 or 0,4+), then BMP (3,1 or 0,x), then symbol (3,0).
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < n; i++) {
      const r = t.offset + 4 + i * 8;
      const platform = v.getUint16(r);
      const enc = v.getUint16(r + 2);
      const score = platform === 3 && enc === 10 ? 4 : platform === 0 && enc >= 4 ? 3 : platform === 3 && enc === 1 ? 2 : platform === 0 ? 2 : platform === 3 && enc === 0 ? 1 : 0;
      if (score > bestScore) {
        bestScore = score;
        best = t.offset + v.getUint32(r + 4);
      }
    }
    if (best < 0) return;
    const format = v.getUint16(best);
    const map = this.cmap;
    if (format === 4) {
      const segX2 = v.getUint16(best + 6);
      const ends = best + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const rangeOffsets = deltas + segX2;
      for (let s = 0; s < segX2; s += 2) {
        const end = v.getUint16(ends + s);
        const start = v.getUint16(starts + s);
        const delta = v.getInt16(deltas + s);
        const ro = v.getUint16(rangeOffsets + s);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g: number;
          if (ro === 0) g = (c + delta) & 0xffff;
          else {
            const at = rangeOffsets + s + ro + (c - start) * 2;
            g = at + 1 < this.bytes.length ? v.getUint16(at) : 0;
            if (g) g = (g + delta) & 0xffff;
          }
          if (g) map.set(c, g);
        }
      }
    } else if (format === 12) {
      const groups = v.getUint32(best + 12);
      for (let i = 0; i < groups; i++) {
        const r = best + 16 + i * 12;
        const start = v.getUint32(r);
        const end = v.getUint32(r + 4);
        const gid = v.getUint32(r + 8);
        for (let c = start; c <= end && c - start < 0x10000; c++) map.set(c, gid + c - start);
      }
    } else if (format === 0) {
      for (let c = 0; c < 256; c++) {
        const g = this.bytes[best + 6 + c];
        if (g) map.set(c, g);
      }
    } else if (format === 6) {
      const first = v.getUint16(best + 6);
      const count = v.getUint16(best + 8);
      for (let i = 0; i < count; i++) {
        const g = v.getUint16(best + 10 + i * 2);
        if (g) map.set(first + i, g);
      }
    }
    // Symbol fonts map their characters at U+F000..F0FF; also make them reachable as Latin-1.
    if (bestScore === 1) for (const [c, g] of [...map]) if (c >= 0xf000 && c <= 0xf0ff && !map.has(c - 0xf000)) map.set(c - 0xf000, g);
  }

  private readLoca(): void {
    const head = this.require('head');
    const loca = this.require('loca');
    const long = this.view.getInt16(head.offset + 50) === 1;
    const offsets = new Uint32Array(this.numGlyphs + 1);
    for (let i = 0; i <= this.numGlyphs; i++) {
      const at = loca.offset + i * (long ? 4 : 2);
      if (at + (long ? 4 : 2) > loca.offset + loca.length) {
        offsets[i] = offsets[i - 1] ?? 0;
        continue;
      }
      offsets[i] = long ? this.view.getUint32(at) : this.view.getUint16(at) * 2;
    }
    this.locaOffsets = offsets;
  }

  /** Glyph for a Unicode code point (0 = .notdef). */
  glyphForCodePoint(cp: number): number {
    return this.cmap.get(cp) ?? 0;
  }

  /** Every mapped code point, for building reverse maps. */
  get codePoints(): Map<number, number> {
    return this.cmap;
  }

  /** Advance width in font units. */
  advance(gid: number): number {
    return this.advances[gid] ?? 0;
  }

  /** Scale from font units to 1/1000 em (PDF glyph space). */
  get scale(): number {
    return 1000 / this.unitsPerEm;
  }

  private glyphData(gid: number): Uint8Array {
    const glyf = this.require('glyf');
    const o = this.locaOffsets!;
    if (gid >= this.numGlyphs) return new Uint8Array(0);
    const start = glyf.offset + o[gid];
    const end = glyf.offset + o[gid + 1];
    if (end <= start || end > this.bytes.length) return new Uint8Array(0);
    return this.bytes.subarray(start, end);
  }

  /**
   * Whether the font program holds an outline for this glyph (and, for a composite glyph, for
   * every glyph it is built from). A subset font keeps its glyph count but leaves the glyphs it
   * dropped empty. CFF outlines aren't read: false.
   */
  hasOutline(gid: number, depth = 0): boolean {
    if (this.isCff || !this.locaOffsets || !this.tables.has('glyf') || gid <= 0 || gid >= this.numGlyphs || depth > 8) return false;
    const data = this.glyphData(gid);
    if (!data.length) return false;
    return this.components(data).every((c) => this.hasOutline(c.gid, depth + 1));
  }

  /**
   * The outline of a glyph as an SVG path in font units (y up), for drawing it where no font is available to the
   * drawing surface. TrueType outlines only; '' for an empty glyph, a CFF font or a glyph out of range.
   */
  glyphPath(gid: number, depth = 0): string {
    if (this.isCff || !this.locaOffsets || !this.tables.has('glyf') || gid < 0 || gid >= this.numGlyphs || depth > 8) return '';
    const data = this.glyphData(gid);
    if (data.length < 10) return '';
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const contours = v.getInt16(0);
    if (contours < 0) return this.compositePath(data, v, depth);
    if (contours === 0) return '';
    const ends: number[] = [];
    let p = 10;
    for (let i = 0; i < contours; i++, p += 2) ends.push(v.getUint16(p));
    const points = ends[ends.length - 1] + 1;
    p += 2 + v.getUint16(p); // instructions
    const flags: number[] = [];
    while (flags.length < points) {
      const f = data[p++];
      flags.push(f);
      if (f & 8) for (let r = data[p++]; r > 0 && flags.length < points; r--) flags.push(f);
    }
    const coordinates = (short: number, same: number): number[] => {
      const out: number[] = [];
      let value = 0;
      for (const f of flags) {
        if (f & short) {
          const d = data[p++];
          value += f & same ? d : -d;
        } else if (!(f & same)) {
          value += v.getInt16(p);
          p += 2;
        }
        out.push(value);
      }
      return out;
    };
    const xs = coordinates(2, 16);
    const ys = coordinates(4, 32);
    const fmt = (n: number) => String(Math.round(n * 100) / 100);
    let d = '';
    let start = 0;
    for (const end of ends) {
      const pts = [];
      for (let i = start; i <= end; i++) pts.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) !== 0 });
      start = end + 1;
      if (pts.length < 2) continue;
      // Begin at an on-curve point (or the midpoint of two off-curve ones).
      let first = pts.findIndex((q) => q.on);
      const ring = pts.slice();
      if (first < 0) {
        ring.unshift({ x: (pts[0].x + pts[pts.length - 1].x) / 2, y: (pts[0].y + pts[pts.length - 1].y) / 2, on: true });
        first = 0;
      }
      const rotated = ring.slice(first).concat(ring.slice(0, first));
      d += `M${fmt(rotated[0].x)} ${fmt(rotated[0].y)}`;
      let i = 1;
      const n = rotated.length;
      while (i <= n) {
        const q = rotated[i % n];
        if (q.on) {
          d += `L${fmt(q.x)} ${fmt(q.y)}`;
          i++;
        } else {
          const next = rotated[(i + 1) % n];
          const end = next.on ? next : { x: (q.x + next.x) / 2, y: (q.y + next.y) / 2 };
          d += `Q${fmt(q.x)} ${fmt(q.y)} ${fmt(end.x)} ${fmt(end.y)}`;
          i += next.on ? 2 : 1;
        }
      }
      d += 'Z';
    }
    return d;
  }

  /** A composite glyph's outline: its components, each scaled and moved. */
  private compositePath(data: Uint8Array, v: DataView, depth: number): string {
    let d = '';
    let p = 10;
    for (;;) {
      if (p + 4 > data.length) break;
      const flags = v.getUint16(p);
      const gid = v.getUint16(p + 2);
      p += 4;
      let dx = 0;
      let dy = 0;
      if (flags & 1) {
        if (flags & 2) {
          dx = v.getInt16(p);
          dy = v.getInt16(p + 2);
        }
        p += 4;
      } else {
        if (flags & 2) {
          dx = v.getInt8(p);
          dy = v.getInt8(p + 1);
        }
        p += 2;
      }
      let a = 1;
      let b = 0;
      let c = 0;
      let e = 1;
      const f2 = (o: number) => v.getInt16(p + o) / 16384;
      if (flags & 8) {
        a = e = f2(0);
        p += 2;
      } else if (flags & 0x40) {
        a = f2(0);
        e = f2(2);
        p += 4;
      } else if (flags & 0x80) {
        a = f2(0);
        b = f2(2);
        c = f2(4);
        e = f2(6);
        p += 8;
      }
      const part = this.glyphPath(gid, depth + 1);
      if (part) d += transformPath(part, a, b, c, e, dx, dy);
      if (!(flags & 0x20)) break;
    }
    return d;
  }

  /** Glyphs a composite glyph refers to. */
  private components(data: Uint8Array): { gidAt: number; gid: number }[] {
    if (data.length < 10) return [];
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (v.getInt16(0) >= 0) return []; // simple glyph
    const out: { gidAt: number; gid: number }[] = [];
    let p = 10;
    for (;;) {
      if (p + 4 > data.length) break;
      const flags = v.getUint16(p);
      out.push({ gidAt: p + 2, gid: v.getUint16(p + 2) });
      p += 4 + (flags & 1 ? 4 : 2);
      if (flags & 8) p += 2;
      else if (flags & 0x40) p += 4;
      else if (flags & 0x80) p += 8;
      if (!(flags & 0x20)) break;
    }
    return out;
  }

  /**
   * A TrueType font with just these glyphs, renumbered in the given order (glyph 0, .notdef,
   * is always kept first). Components of composite glyphs are added as needed. Returns the
   * font program and the final old-to-new glyph map.
   */
  subset(gids: Iterable<number>): { data: Uint8Array; map: Map<number, number> } {
    if (this.isCff) throw new FontFormatError('CFF fonts are embedded whole');
    const order: number[] = [0];
    const map = new Map<number, number>([[0, 0]]);
    const want = (g: number) => {
      if (g < this.numGlyphs && !map.has(g)) {
        map.set(g, order.length);
        order.push(g);
      }
    };
    for (const g of gids) want(g);
    for (let i = 0; i < order.length; i++) for (const c of this.components(this.glyphData(order[i]))) want(c.gid);

    // glyf + loca (long offsets), with composite references renumbered.
    const glyphs = order.map((g) => {
      const data = this.glyphData(g).slice();
      const comps = this.components(data);
      if (comps.length) {
        const dv = new DataView(data.buffer);
        for (const c of comps) dv.setUint16(c.gidAt, map.get(c.gid) ?? 0);
      }
      return data;
    });
    const glyfLen = glyphs.reduce((n, g) => n + ((g.length + 3) & ~3), 0);
    const glyf = new Uint8Array(glyfLen);
    const loca = new Uint8Array((order.length + 1) * 4);
    const locaView = new DataView(loca.buffer);
    let off = 0;
    glyphs.forEach((g, i) => {
      locaView.setUint32(i * 4, off);
      glyf.set(g, off);
      off += (g.length + 3) & ~3;
    });
    locaView.setUint32(order.length * 4, off);

    const hmtx = new Uint8Array(order.length * 4);
    const hmtxView = new DataView(hmtx.buffer);
    const lsbOf = (g: number) => {
      const d = this.glyphData(g);
      return d.length >= 4 ? new DataView(d.buffer, d.byteOffset).getInt16(2) : 0;
    };
    order.forEach((g, i) => {
      hmtxView.setUint16(i * 4, this.advance(g));
      hmtxView.setInt16(i * 4 + 2, lsbOf(g));
    });

    const copy = (tag: string) => {
      const t = this.tables.get(tag);
      return t ? this.bytes.slice(t.offset, t.offset + t.length) : undefined;
    };
    const head = copy('head')!;
    new DataView(head.buffer).setInt16(50, 1); // long loca
    new DataView(head.buffer).setUint32(8, 0); // checkSumAdjustment, set below
    const hhea = copy('hhea')!;
    new DataView(hhea.buffer).setUint16(34, order.length);
    const maxp = copy('maxp')!;
    new DataView(maxp.buffer).setUint16(4, order.length);
    const post = new Uint8Array(32);
    const postSrc = copy('post');
    if (postSrc) post.set(postSrc.subarray(0, 32));
    new DataView(post.buffer).setUint32(0, 0x00030000); // version 3: no glyph names

    const tables: [string, Uint8Array][] = [
      ['head', head],
      ['hhea', hhea],
      ['maxp', maxp],
      ['hmtx', hmtx],
      ['loca', loca],
      ['glyf', glyf],
      ['post', post],
    ];
    for (const tag of ['cvt ', 'fpgm', 'prep', 'OS/2']) {
      const t = copy(tag);
      if (t) tables.push([tag, t]);
    }
    return { data: writeSfnt(tables), map };
  }
}

function checksum(data: Uint8Array): number {
  let sum = 0;
  const padded = data.length % 4 ? new Uint8Array((data.length + 3) & ~3) : data;
  if (padded !== data) padded.set(data);
  const v = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
  return sum;
}

function writeSfnt(tables: [string, Uint8Array][]): Uint8Array {
  tables.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const n = tables.length;
  const headerLen = 12 + n * 16;
  const total = headerLen + tables.reduce((s, [, d]) => s + ((d.length + 3) & ~3), 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x00010000);
  v.setUint16(4, n);
  let pow = 1;
  let log = 0;
  while (pow * 2 <= n) {
    pow *= 2;
    log++;
  }
  v.setUint16(6, pow * 16);
  v.setUint16(8, log);
  v.setUint16(10, n * 16 - pow * 16);
  let off = headerLen;
  let headAt = -1;
  tables.forEach(([tag, data], i) => {
    const r = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[r + k] = tag.charCodeAt(k);
    v.setUint32(r + 4, checksum(data));
    v.setUint32(r + 8, off);
    v.setUint32(r + 12, data.length);
    out.set(data, off);
    if (tag === 'head') headAt = off;
    off += (data.length + 3) & ~3;
  });
  if (headAt >= 0) v.setUint32(headAt + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}

/** An SVG path of M, L, Q and Z commands with the affine transform [a b c e dx dy] applied to its points. */
function transformPath(path: string, a: number, b: number, c: number, e: number, dx: number, dy: number): string {
  return path.replace(/([MLQZ])([^MLQZ]*)/g, (_, cmd: string, args: string) => {
    if (cmd === 'Z') return 'Z';
    const nums = args.trim().split(/[\s,]+/).map(Number);
    const out: string[] = [];
    for (let i = 0; i < nums.length; i += 2) {
      const x = nums[i];
      const y = nums[i + 1];
      out.push(`${Math.round((a * x + c * y + dx) * 100) / 100} ${Math.round((b * x + e * y + dy) * 100) / 100}`);
    }
    return cmd + out.join(' ');
  });
}
