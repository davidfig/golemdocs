// Reads a color bitmap emoji font (CBDT/CBLC, as Noto Color Emoji ships): which character or sequence
// each glyph draws (cmap, then the GSUB ligatures that join ZWJ sequences, flags, keycaps and skin
// tones into one glyph), and each glyph's PNG and its metrics at the font's largest strike.

export interface EmojiBitmap {
  /** The PNG as stored in the font. */
  png: Buffer;
  width: number;
  height: number;
  /** Pixels from the pen position to the left edge, and from the baseline up to the top edge. */
  bearingX: number;
  bearingY: number;
}

/** A sequence the font draws. A glyph several sequences spell (with and without a gender sign, say) is listed once for each. */
export interface EmojiGlyph {
  glyph: number;
  /** The code points it draws, variation selectors (U+FE0F) left out. One for a single character. */
  sequence: number[];
  /** Advance width in ems. */
  advance: number;
  bitmap: EmojiBitmap;
}

export interface EmojiFont {
  unitsPerEm: number;
  /** Pixels per em of the strike the bitmaps come from. */
  ppem: number;
  glyphs: EmojiGlyph[];
}

const VS16 = 0xfe0f;

export function readEmojiFont(buf: Buffer): EmojiFont {
  const tables = new Map<string, number>();
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16;
    tables.set(buf.toString('latin1', record, record + 4), buf.readUInt32BE(record + 8));
  }
  const table = (tag: string): number => {
    const offset = tables.get(tag);
    if (offset === undefined) throw new Error(`font has no '${tag}' table`);
    return offset;
  };
  const u8 = (o: number) => buf.readUInt8(o);
  const i8 = (o: number) => buf.readInt8(o);
  const u16 = (o: number) => buf.readUInt16BE(o);
  const u32 = (o: number) => buf.readUInt32BE(o);

  const unitsPerEm = u16(table('head') + 18);
  const numberOfHMetrics = u16(table('hhea') + 34);
  const hmtx = table('hmtx');
  const advanceOf = (glyph: number) => u16(hmtx + Math.min(glyph, numberOfHMetrics - 1) * 4);

  // --- cmap: code point -> glyph, and back -----------------------------------------------
  const cmap = table('cmap');
  const toGlyph = new Map<number, number>();
  let best = -1;
  let bestFormat = 0;
  for (let i = 0; i < u16(cmap + 2); i++) {
    const record = cmap + 4 + i * 8;
    const offset = cmap + u32(record + 4);
    const format = u16(offset);
    if (format === 12 && bestFormat !== 12) [best, bestFormat] = [offset, 12];
    else if (format === 4 && bestFormat === 0) [best, bestFormat] = [offset, 4];
  }
  if (best < 0) throw new Error('font has no format 4 or 12 cmap');
  if (bestFormat === 12) {
    const groups = u32(best + 12);
    for (let g = 0; g < groups; g++) {
      const at = best + 16 + g * 12;
      const [start, end, glyph] = [u32(at), u32(at + 4), u32(at + 8)];
      for (let cp = start; cp <= end; cp++) toGlyph.set(cp, glyph + cp - start);
    }
  } else {
    const segments = u16(best + 6) / 2;
    const ends = best + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    for (let s = 0; s < segments; s++) {
      const [start, end, delta, rangeOffset] = [u16(starts + s * 2), u16(ends + s * 2), u16(deltas + s * 2), u16(ranges + s * 2)];
      for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
        let glyph = rangeOffset ? u16(ranges + s * 2 + rangeOffset + (cp - start) * 2) : cp;
        if (glyph) glyph = (glyph + delta) & 0xffff;
        if (glyph) toGlyph.set(cp, glyph);
      }
    }
  }
  const toChar = new Map<number, number>();
  // Private-use code points name some sequences' glyphs too (a legacy of older emoji encodings): the glyph stands for the sequence.
  const isPrivate = (cp: number) => (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000;
  for (const [cp, glyph] of toGlyph) if (!isPrivate(cp) && (!toChar.has(glyph) || cp < toChar.get(glyph)!)) toChar.set(glyph, cp);

  // --- GSUB: ligatures (lookup type 4, also inside type 7 extensions) ---------------------
  const ligatures = new Map<number, number[][]>(); // ligature glyph -> each list of component glyphs that makes it
  if (tables.has('GSUB')) {
    const gsub = table('GSUB');
    const lookupList = gsub + u16(gsub + 8);
    const coverage = (at: number): number[] => {
      const format = u16(at);
      const out: number[] = [];
      if (format === 1) for (let i = 0; i < u16(at + 2); i++) out.push(u16(at + 4 + i * 2));
      else for (let r = 0; r < u16(at + 2); r++) for (let g = u16(at + 4 + r * 6); g <= u16(at + 6 + r * 6); g++) out.push(g);
      return out;
    };
    const ligatureSubtable = (at: number) => {
      const firsts = coverage(at + u16(at + 2));
      for (let s = 0; s < u16(at + 4); s++) {
        const set = at + u16(at + 6 + s * 2);
        for (let l = 0; l < u16(set); l++) {
          const lig = set + u16(set + 2 + l * 2);
          const components = [firsts[s]];
          for (let c = 1; c < u16(lig + 2); c++) components.push(u16(lig + 4 + (c - 1) * 2));
          const glyph = u16(lig);
          const ways = ligatures.get(glyph);
          if (ways) ways.push(components);
          else ligatures.set(glyph, [components]);
        }
      }
    };
    for (let l = 0; l < u16(lookupList); l++) {
      const lookup = lookupList + u16(lookupList + 2 + l * 2);
      const type = u16(lookup);
      for (let s = 0; s < u16(lookup + 4); s++) {
        const sub = lookup + u16(lookup + 6 + s * 2);
        if (type === 4) ligatureSubtable(sub);
        else if (type === 7 && u16(sub + 2) === 4) ligatureSubtable(sub + u32(sub + 4));
      }
    }
  }
  /** The code point sequences a glyph stands for: its character, and every way its ligatures' components spell it (recursively). */
  const sequencesOf = (glyph: number, depth = 0): number[][] => {
    const out: number[][] = [];
    const cp = toChar.get(glyph);
    if (cp !== undefined) out.push([cp]);
    if (depth > 8) return out;
    for (const parts of ligatures.get(glyph) ?? []) {
      let spelled: number[][] = [[]];
      for (const part of parts) {
        const options = sequencesOf(part, depth + 1);
        spelled = spelled.flatMap((head) => options.map((tail) => [...head, ...tail]));
        if (!spelled.length) break;
      }
      out.push(...spelled);
    }
    return out;
  };

  // --- CBLC/CBDT: the bitmaps of the largest strike ---------------------------------------
  const cblc = table('CBLC');
  const cbdt = table('CBDT');
  let strike = -1;
  for (let s = 0; s < u32(cblc + 4); s++) {
    const at = cblc + 8 + s * 48;
    if (strike < 0 || u8(at + 45) > u8(strike + 45)) strike = at;
  }
  if (strike < 0) throw new Error('font has no bitmap strikes');
  const ppem = u8(strike + 45);
  const arrayAt = cblc + u32(strike);
  const bitmaps = new Map<number, EmojiBitmap>();
  const readImage = (format: number, at: number, metrics?: { width: number; height: number; bearingX: number; bearingY: number }) => {
    if (format === 17) return { height: u8(at), width: u8(at + 1), bearingX: i8(at + 2), bearingY: i8(at + 3), png: buf.subarray(at + 9, at + 9 + u32(at + 5)) };
    if (format === 18) return { height: u8(at), width: u8(at + 1), bearingX: i8(at + 2), bearingY: i8(at + 3), png: buf.subarray(at + 12, at + 12 + u32(at + 8)) };
    if (format === 19 && metrics) return { ...metrics, png: buf.subarray(at + 4, at + 4 + u32(at)) };
    throw new Error(`unsupported CBDT image format ${format}`);
  };
  const bigMetrics = (at: number) => ({ height: u8(at), width: u8(at + 1), bearingX: i8(at + 2), bearingY: i8(at + 3) });
  for (let t = 0; t < u32(strike + 8); t++) {
    const entry = arrayAt + t * 8;
    const first = u16(entry);
    const last = u16(entry + 2);
    const sub = arrayAt + u32(entry + 4);
    const indexFormat = u16(sub);
    const imageFormat = u16(sub + 2);
    const imageData = cbdt + u32(sub + 4);
    const put = (glyph: number, offset: number, metrics?: ReturnType<typeof bigMetrics>) => bitmaps.set(glyph, readImage(imageFormat, imageData + offset, metrics));
    if (indexFormat === 1 || indexFormat === 3) {
      const size = indexFormat === 1 ? 4 : 2;
      const read = indexFormat === 1 ? u32 : u16;
      for (let g = first; g <= last; g++) {
        const offset = read(sub + 8 + (g - first) * size);
        if (read(sub + 8 + (g - first + 1) * size) > offset) put(g, offset);
      }
    } else if (indexFormat === 2) {
      const size = u32(sub + 8);
      const metrics = bigMetrics(sub + 12);
      for (let g = first; g <= last; g++) put(g, (g - first) * size, metrics);
    } else if (indexFormat === 4) {
      const count = u32(sub + 8);
      for (let i = 0; i < count; i++) put(u16(sub + 12 + i * 4), u16(sub + 14 + i * 4));
    } else if (indexFormat === 5) {
      const size = u32(sub + 8);
      const metrics = bigMetrics(sub + 12);
      const count = u32(sub + 20);
      for (let i = 0; i < count; i++) put(u16(sub + 24 + i * 2), i * size, metrics);
    } else throw new Error(`unsupported CBLC index format ${indexFormat}`);
  }

  const glyphs: EmojiGlyph[] = [];
  const seen = new Set<string>();
  for (const [glyph, bitmap] of bitmaps) {
    for (const spelled of sequencesOf(glyph)) {
      const sequence = spelled.filter((cp) => cp !== VS16);
      const key = sequence.join(',');
      if (!sequence.length || seen.has(key)) continue;
      seen.add(key);
      glyphs.push({ glyph, sequence, advance: advanceOf(glyph) / unitsPerEm, bitmap });
    }
  }
  return { unitsPerEm, ppem, glyphs };
}
