// Everything layout needs to know about one font face, without a GPU: glyph lookup, advance
// widths, kerning and vertical metrics. Built from the same msdf-atlas-gen JSON the renderer
// uses for its atlas, so glyph indices are shared between layout and rendering.

import type { FontMetrics, ManifestFace, MsdfLayout } from './fontTypes.ts';

/** Characters that should render as another glyph when the font lacks them. */
const FALLBACKS: Record<number, number> = {
  0x00a0: 0x0020, // no-break space
  0x2011: 0x002d, // non-breaking hyphen
  0x2010: 0x002d, // hyphen
  0x2212: 0x002d, // minus sign
  0x2015: 0x2014, // horizontal bar
  0x2002: 0x0020, // en space
  0x2003: 0x0020, // em space
  0x2009: 0x0020, // thin space
  0x202f: 0x0020, // narrow no-break space
};

/** Codepoints below this use a flat lookup table instead of the Map. */
const FAST_LOOKUP_LIMIT = 0x2200;

let nextId = 0;

export class FaceMetrics {
  /** Unique per face; renderers key GPU resources by it. */
  readonly id = nextId++;
  readonly glyphCount: number;
  /** Advance width per glyph index, in ems. */
  readonly advances: Float32Array;
  /** 1 if the glyph has visible geometry. */
  readonly visible: Uint8Array;

  /** Vertical metrics in ems (Word uses the OS/2 win metrics). */
  readonly ascent: number;
  readonly descent: number;
  readonly underlinePosition: number;
  readonly underlineThickness: number;
  readonly strikeoutPosition: number;
  readonly strikeoutThickness: number;
  readonly capHeight: number;

  private readonly fastLookup: Int16Array;
  private readonly lookup = new Map<number, number>();
  private readonly kerning = new Map<number, number>();
  private readonly missingAdvance: number;

  constructor(
    readonly face: ManifestFace,
    /** The raw msdf-atlas-gen layout, kept for the renderer's glyph table. */
    readonly layout: MsdfLayout,
  ) {
    const { glyphs } = layout;
    this.glyphCount = glyphs.length;
    this.advances = new Float32Array(glyphs.length);
    this.visible = new Uint8Array(glyphs.length);
    this.fastLookup = new Int16Array(FAST_LOOKUP_LIMIT).fill(-1);
    glyphs.forEach((glyph, i) => {
      this.advances[i] = glyph.advance;
      if (glyph.unicode < FAST_LOOKUP_LIMIT) this.fastLookup[glyph.unicode] = i;
      else this.lookup.set(glyph.unicode, i);
      if (glyph.planeBounds && glyph.atlasBounds) this.visible[i] = 1;
    });
    for (const pair of layout.kerning ?? []) this.kerning.set(pair.unicode1 * 0x110000 + pair.unicode2, pair.advance);
    const space = this.glyph(0x20);
    this.missingAdvance = space >= 0 ? this.advances[space] : 0.25;

    const m: FontMetrics = face.metrics;
    const em = m.unitsPerEm;
    this.ascent = m.win.ascent / em;
    this.descent = m.win.descent / em;
    this.underlinePosition = -m.underline.position / em;
    this.underlineThickness = Math.max(m.underline.thickness, 1) / em;
    this.strikeoutPosition = m.strikeout.position / em;
    this.strikeoutThickness = Math.max(m.strikeout.size, 1) / em;
    this.capHeight = (m.capHeight ?? m.win.ascent * 0.7) / em;
  }

  /** Glyph index for a codepoint, or -1 if the face lacks it (after fallbacks). */
  glyph(codepoint: number): number {
    const index = codepoint < FAST_LOOKUP_LIMIT ? this.fastLookup[codepoint] : (this.lookup.get(codepoint) ?? -1);
    if (index >= 0) return index;
    const fallback = FALLBACKS[codepoint];
    return fallback === undefined ? -1 : this.glyph(fallback);
  }

  has(codepoint: number): boolean {
    return this.glyph(codepoint) >= 0;
  }

  /** Advance for a glyph index; missing glyphs (-1) advance like a space. In ems. */
  advance(glyph: number): number {
    return glyph >= 0 ? this.advances[glyph] : this.missingAdvance;
  }

  /** Kerning adjustment between two codepoints, in ems. */
  kern(left: number, right: number): number {
    return this.kerning.get(left * 0x110000 + right) ?? 0;
  }

  /** Word's single line height (win ascent + descent), in ems. */
  get lineHeight(): number {
    return this.ascent + this.descent;
  }

  /** Advance width of text in ems (no kerning). */
  measure(text: string): number {
    let width = 0;
    for (const char of text) width += this.advance(this.glyph(char.codePointAt(0)!));
    return width;
  }
}
