// Reads what math layout needs from an OpenType math font's sfnt tables: the MATH table
// (constants, italic corrections, accent positions, kerning cut-ins, size variants and glyph
// assemblies), the GSUB `ssty` script-size alternates, and the cmap. It runs at generation time
// only; the result is written to math.json next to the atlas (see generate.ts), so no font
// parsing ships to the client.
//
// Everything is in font units and keyed by glyph id here; generate.ts converts to ems and to
// the glyph positions of the atlas.

export interface MathValue {
  value: number;
}

/** One side's staircase of kerns (MathKern): kern[i] applies below height[i], the last above all. */
export interface MathKern {
  heights: number[];
  kerns: number[];
}

export interface MathKernCorners {
  topRight?: MathKern;
  topLeft?: MathKern;
  bottomRight?: MathKern;
  bottomLeft?: MathKern;
}

export interface GlyphPart {
  glyph: number;
  startConnector: number;
  endConnector: number;
  fullAdvance: number;
  extender: boolean;
}

export interface GlyphConstruction {
  /** Larger versions of the glyph, smallest first, with their size along the stretch direction. */
  variants: { glyph: number; advance: number }[];
  /** Pieces to build any size from, when the variants run out. */
  assembly?: { italicsCorrection: number; parts: GlyphPart[] };
}

export interface MathFontInfo {
  unitsPerEm: number;
  numGlyphs: number;
  /** MathConstants by name; the percent values (scriptPercentScaleDown...) are plain numbers. */
  constants: Record<string, number>;
  minConnectorOverlap: number;
  italics: Map<number, number>;
  topAccent: Map<number, number>;
  /** Glyphs that stretch (or are tall): accents flatten over them. */
  extendedShapes: Set<number>;
  kerns: Map<number, MathKernCorners>;
  vertical: Map<number, GlyphConstruction>;
  horizontal: Map<number, GlyphConstruction>;
  /** `ssty` alternates: [first-level script glyph, second-level script glyph?]. */
  script: Map<number, number[]>;
  /** Code point to glyph id. */
  cmap: Map<number, number>;
}

const CONSTANT_NAMES = [
  'mathLeading', 'axisHeight', 'accentBaseHeight', 'flattenedAccentBaseHeight',
  'subscriptShiftDown', 'subscriptTopMax', 'subscriptBaselineDropMin',
  'superscriptShiftUp', 'superscriptShiftUpCramped', 'superscriptBottomMin', 'superscriptBaselineDropMax',
  'subSuperscriptGapMin', 'superscriptBottomMaxWithSubscript', 'spaceAfterScript',
  'upperLimitGapMin', 'upperLimitBaselineRiseMin', 'lowerLimitGapMin', 'lowerLimitBaselineDropMin',
  'stackTopShiftUp', 'stackTopDisplayStyleShiftUp', 'stackBottomShiftDown', 'stackBottomDisplayStyleShiftDown',
  'stackGapMin', 'stackDisplayStyleGapMin',
  'stretchStackTopShiftUp', 'stretchStackBottomShiftDown', 'stretchStackGapAboveMin', 'stretchStackGapBelowMin',
  'fractionNumeratorShiftUp', 'fractionNumeratorDisplayStyleShiftUp', 'fractionDenominatorShiftDown', 'fractionDenominatorDisplayStyleShiftDown',
  'fractionNumeratorGapMin', 'fractionNumDisplayStyleGapMin', 'fractionRuleThickness', 'fractionDenominatorGapMin', 'fractionDenomDisplayStyleGapMin',
  'skewedFractionHorizontalGap', 'skewedFractionVerticalGap',
  'overbarVerticalGap', 'overbarRuleThickness', 'overbarExtraAscender',
  'underbarVerticalGap', 'underbarRuleThickness', 'underbarExtraDescender',
  'radicalVerticalGap', 'radicalDisplayStyleVerticalGap', 'radicalRuleThickness', 'radicalExtraAscender',
  'radicalKernBeforeDegree', 'radicalKernAfterDegree',
] as const;

class Reader {
  constructor(
    readonly buf: Buffer,
    readonly base: number,
  ) {}
  u16(at: number): number {
    return this.buf.readUInt16BE(this.base + at);
  }
  i16(at: number): number {
    return this.buf.readInt16BE(this.base + at);
  }
  u32(at: number): number {
    return this.buf.readUInt32BE(this.base + at);
  }
  tag(at: number): string {
    return this.buf.toString('latin1', this.base + at, this.base + at + 4);
  }
  /** A MathValueRecord's value (its device table is ignored). */
  value(at: number): number {
    return this.i16(at);
  }
  at(offset: number): Reader {
    return new Reader(this.buf, this.base + offset);
  }
}

/** Glyph ids in a Coverage table, in coverage-index order. */
function coverage(r: Reader): number[] {
  const format = r.u16(0);
  const out: number[] = [];
  if (format === 1) {
    const count = r.u16(2);
    for (let i = 0; i < count; i++) out.push(r.u16(4 + i * 2));
  } else if (format === 2) {
    const count = r.u16(2);
    for (let i = 0; i < count; i++) {
      const start = r.u16(4 + i * 6);
      const end = r.u16(6 + i * 6);
      const index = r.u16(8 + i * 6);
      for (let g = start; g <= end; g++) out[index + g - start] = g;
    }
  } else throw new Error(`unsupported coverage format ${format}`);
  return out;
}

function tableDirectory(buf: Buffer): Map<string, number> {
  const tables = new Map<string, number>();
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16;
    tables.set(buf.toString('latin1', record, record + 4), buf.readUInt32BE(record + 8));
  }
  return tables;
}

function readCmap(r: Reader): Map<number, number> {
  const count = r.u16(2);
  let best: { offset: number; score: number } | null = null;
  for (let i = 0; i < count; i++) {
    const platform = r.u16(4 + i * 8);
    const encoding = r.u16(6 + i * 8);
    const offset = r.u32(8 + i * 8);
    const format = r.u16(offset);
    // Prefer full Unicode (format 12), then the BMP table.
    const score = format === 12 && (platform === 3 || platform === 0) ? 3 : format === 4 && ((platform === 3 && encoding === 1) || platform === 0) ? 2 : 0;
    if (score > (best?.score ?? 0)) best = { offset, score };
  }
  if (!best) throw new Error('font has no Unicode cmap');
  const map = new Map<number, number>();
  const t = r.at(best.offset);
  if (t.u16(0) === 12) {
    const groups = t.u32(12);
    for (let g = 0; g < groups; g++) {
      const start = t.u32(16 + g * 12);
      const end = t.u32(20 + g * 12);
      const first = t.u32(24 + g * 12);
      for (let cp = start; cp <= end; cp++) map.set(cp, first + cp - start);
    }
  } else {
    const segments = t.u16(6) / 2;
    const ends = 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const rangeOffsets = deltas + segments * 2;
    for (let s = 0; s < segments; s++) {
      const end = t.u16(ends + s * 2);
      const start = t.u16(starts + s * 2);
      const delta = t.i16(deltas + s * 2);
      const rangeOffset = t.u16(rangeOffsets + s * 2);
      for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
        let gid: number;
        if (rangeOffset === 0) gid = (cp + delta) & 0xffff;
        else {
          gid = t.u16(rangeOffsets + s * 2 + rangeOffset + (cp - start) * 2);
          if (gid !== 0) gid = (gid + delta) & 0xffff;
        }
        if (gid !== 0) map.set(cp, gid);
      }
    }
  }
  map.delete(0);
  return map;
}

function readKern(r: Reader): MathKern {
  const n = r.u16(0);
  const heights: number[] = [];
  const kerns: number[] = [];
  for (let i = 0; i < n; i++) heights.push(r.value(2 + i * 4));
  for (let i = 0; i <= n; i++) kerns.push(r.value(2 + n * 4 + i * 4));
  return { heights, kerns };
}

function readConstruction(r: Reader): GlyphConstruction {
  const assemblyOffset = r.u16(0);
  const count = r.u16(2);
  const variants: GlyphConstruction['variants'] = [];
  for (let i = 0; i < count; i++) variants.push({ glyph: r.u16(4 + i * 4), advance: r.u16(6 + i * 4) });
  const out: GlyphConstruction = { variants };
  if (assemblyOffset) {
    const a = r.at(assemblyOffset);
    const partCount = a.u16(4);
    const parts: GlyphPart[] = [];
    for (let i = 0; i < partCount; i++) {
      const at = 6 + i * 10;
      parts.push({ glyph: a.u16(at), startConnector: a.u16(at + 2), endConnector: a.u16(at + 4), fullAdvance: a.u16(at + 6), extender: (a.u16(at + 8) & 1) !== 0 });
    }
    out.assembly = { italicsCorrection: a.value(0), parts };
  }
  return out;
}

function readVariants(r: Reader, cover: number, count: number, offsets: number, into: Map<number, GlyphConstruction>): void {
  if (!cover || !count) return;
  const glyphs = coverage(r.at(cover));
  for (let i = 0; i < count; i++) into.set(glyphs[i], readConstruction(r.at(r.u16(offsets + i * 2))));
}

/** The `ssty` substitutions: single (1) and alternate (3) lookups, through extension lookups. */
function readScriptAlternates(r: Reader): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const features = r.u16(6);
  const lookups = r.u16(8);
  const featureCount = r.at(features).u16(0);
  const lookupIndices = new Set<number>();
  for (let i = 0; i < featureCount; i++) {
    if (r.at(features).tag(2 + i * 6) !== 'ssty') continue;
    const feature = r.at(features + r.at(features).u16(6 + i * 6));
    const n = feature.u16(2);
    for (let k = 0; k < n; k++) lookupIndices.add(feature.u16(4 + k * 2));
  }
  const list = r.at(lookups);
  for (const index of lookupIndices) {
    const lookup = list.at(list.u16(2 + index * 2));
    const type = lookup.u16(0);
    const subtables = lookup.u16(4);
    for (let s = 0; s < subtables; s++) {
      let sub = lookup.at(lookup.u16(6 + s * 2));
      let subType = type;
      if (type === 7) {
        subType = sub.u16(2);
        sub = sub.at(sub.u32(4));
      }
      const glyphs = coverage(sub.at(sub.u16(2)));
      if (subType === 1) {
        const format = sub.u16(0);
        glyphs.forEach((g, i) => {
          const to = format === 1 ? (g + sub.i16(4)) & 0xffff : sub.u16(6 + i * 2);
          if (!out.has(g)) out.set(g, [to]);
        });
      } else if (subType === 3) {
        glyphs.forEach((g, i) => {
          const set = sub.at(sub.u16(6 + i * 2));
          const n = set.u16(0);
          const alternates = [];
          for (let k = 0; k < Math.min(n, 2); k++) alternates.push(set.u16(2 + k * 2));
          if (alternates.length && !out.has(g)) out.set(g, alternates);
        });
      }
    }
  }
  return out;
}

export function readMathFont(buf: Buffer): MathFontInfo {
  const tables = tableDirectory(buf);
  const need = (tag: string): Reader => {
    const offset = tables.get(tag);
    if (offset === undefined) throw new Error(`font has no '${tag}' table`);
    return new Reader(buf, offset);
  };
  const head = need('head');
  const maxp = need('maxp');
  const math = need('MATH');

  // MathConstants
  const c = math.at(math.u16(4));
  const constants: Record<string, number> = {
    scriptPercentScaleDown: c.i16(0),
    scriptScriptPercentScaleDown: c.i16(2),
    delimitedSubFormulaMinHeight: c.u16(4),
    displayOperatorMinHeight: c.u16(6),
  };
  CONSTANT_NAMES.forEach((name, i) => (constants[name] = c.value(8 + i * 4)));
  constants.radicalDegreeBottomRaisePercent = c.i16(8 + CONSTANT_NAMES.length * 4);

  // MathGlyphInfo
  const italics = new Map<number, number>();
  const topAccent = new Map<number, number>();
  const extendedShapes = new Set<number>();
  const kerns = new Map<number, MathKernCorners>();
  const infoOffset = math.u16(6);
  if (infoOffset) {
    const info = math.at(infoOffset);
    const pairs = (offset: number, into: Map<number, number>) => {
      if (!offset) return;
      const t = info.at(offset);
      const glyphs = coverage(t.at(t.u16(0)));
      glyphs.forEach((g, i) => into.set(g, t.value(4 + i * 4)));
    };
    pairs(info.u16(0), italics);
    pairs(info.u16(2), topAccent);
    if (info.u16(4)) for (const g of coverage(info.at(info.u16(4)))) extendedShapes.add(g);
    if (info.u16(6)) {
      const t = info.at(info.u16(6));
      const glyphs = coverage(t.at(t.u16(0)));
      glyphs.forEach((g, i) => {
        const corners: MathKernCorners = {};
        (['topRight', 'topLeft', 'bottomRight', 'bottomLeft'] as const).forEach((name, k) => {
          const offset = t.u16(4 + i * 8 + k * 2);
          if (offset) corners[name] = readKern(t.at(offset));
        });
        kerns.set(g, corners);
      });
    }
  }

  // MathVariants
  const vertical = new Map<number, GlyphConstruction>();
  const horizontal = new Map<number, GlyphConstruction>();
  const variantsOffset = math.u16(8);
  const variants = math.at(variantsOffset);
  const minConnectorOverlap = variants.u16(0);
  const vertCount = variants.u16(6);
  const horizCount = variants.u16(8);
  readVariants(variants, variants.u16(2), vertCount, 10, vertical);
  readVariants(variants, variants.u16(4), horizCount, 10 + vertCount * 2, horizontal);

  return {
    unitsPerEm: head.u16(18),
    numGlyphs: maxp.u16(4),
    constants,
    minConnectorOverlap,
    italics,
    topAccent,
    extendedShapes,
    kerns,
    vertical,
    horizontal,
    script: tables.has('GSUB') ? readScriptAlternates(need('GSUB')) : new Map(),
    cmap: readCmap(need('cmap')),
  };
}

/**
 * The glyphs worth an atlas slot: every character the font maps in the ranges math uses, and
 * every glyph the MATH table and `ssty` refer to (size variants, assembly pieces, script forms).
 */
export function mathGlyphSet(font: MathFontInfo, ranges: readonly (readonly [number, number])[]): number[] {
  const set = new Set<number>([0]);
  for (const [cp, gid] of font.cmap) if (ranges.some(([from, to]) => cp >= from && cp <= to)) set.add(gid);
  for (const group of [font.vertical, font.horizontal]) {
    for (const [gid, construction] of group) {
      set.add(gid);
      for (const v of construction.variants) set.add(v.glyph);
      for (const p of construction.assembly?.parts ?? []) set.add(p.glyph);
    }
  }
  for (const [gid, alternates] of font.script) if (set.has(gid)) for (const a of alternates) set.add(a);
  return [...set].sort((a, b) => a - b);
}
