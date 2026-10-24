// The fonts a PDF embeds, drawn with their own letterforms: each glyph a page shows is read from
// its font's program (`FontProgram`), turned into a distance field (msdf.ts) and packed into an
// atlas made at runtime, which the layout sends to the renderer like any of the app's own faces
// (with its pixels, since there is no file to fetch). Atlases are made as pages are laid out, from
// the glyphs not yet in one, so a long document only pays for the pages that are shown.

import { FaceMetrics, type FontMetrics, type ManifestFace, type ManifestFamily, type MsdfLayout, type ResolvedFont } from '@golemdocs/layout';
import type { GlyphRun, PdfDict, PdfDocument } from '@golemdocs/pdf';
import { FontProgram } from '@golemdocs/pdf/fontProgram';
import { generateField, type Field } from './msdf.ts';

/** Atlas pixels per em and distance range in pixels: the same as the app's own atlases (fonts/manifest.json). */
const PX_PER_EM = 48;
const RANGE = 8;
const ATLAS_WIDTH = 1024;
const MAX_ATLAS_HEIGHT = 4096;
/** Pixels between glyphs in an atlas. */
const GAP = 1;

/** Faces made at runtime are named by this and a number: never a path in the font manifest. */
const KEY_PREFIX = 'pdf-font:';
let nextAtlas = 0;

/** Where a glyph is drawn from: a face and the glyph's place in it. */
export interface DrawnGlyph {
  font: ResolvedFont;
  metrics: FaceMetrics;
  glyph: number;
}

/** What the program has for a glyph: drawn, blank (null), or missing (draw a stand-in). */
type Entry = DrawnGlyph | null | 'missing';

interface FontState {
  program: FontProgram | null;
  glyphs: Map<number, Entry>;
}

/** Font-wide metrics FaceMetrics reads: unused for PDF pages, where every glyph is placed by the PDF. */
const METRICS: FontMetrics = {
  unitsPerEm: 1000,
  hhea: { ascender: 800, descender: -200, lineGap: 0 },
  typo: { ascender: 800, descender: -200, lineGap: 0, useTypoMetrics: false },
  win: { ascent: 800, descent: 200 },
  xHeight: null,
  capHeight: null,
  underline: { position: -100, thickness: 50 },
  strikeout: { position: 250, size: 50 },
  subscript: { xSize: 650, ySize: 600, xOffset: 0, yOffset: 75 },
  superscript: { xSize: 650, ySize: 600, xOffset: 0, yOffset: 350 },
};

export class PdfFaces {
  private readonly fonts = new WeakMap<PdfDict, FontState>();

  constructor(private readonly doc: PdfDocument) {}

  /** Makes atlases for the glyphs these runs show that aren't in one yet. */
  prepare(runs: readonly GlyphRun[]): void {
    const wanted: { state: FontState; glyph: number; field: Field }[] = [];
    for (const run of runs) {
      const state = this.state(run.fontDict);
      if (!state.program) continue;
      for (const g of run.glyphs) {
        if (state.glyphs.has(g.glyph)) continue;
        const outline = state.program.outline(g.glyph);
        let field: Field | null = null;
        try {
          field = outline && generateField(outline, PX_PER_EM, RANGE);
        } catch {
          // a glyph that can't be drawn this way is drawn with a stand-in
        }
        if (field) {
          // Claimed now, so a glyph shown twice on the page is made once; filled in with its atlas below.
          state.glyphs.set(g.glyph, 'missing');
          wanted.push({ state, glyph: g.glyph, field });
        } else state.glyphs.set(g.glyph, outline && !outline.length ? null : 'missing');
      }
    }
    while (wanted.length) {
      const packed = pack(wanted);
      packed.items.forEach((item, i) => item.state.glyphs.set(item.glyph, { ...packed.face, glyph: i }));
      wanted.splice(0, packed.items.length);
    }
  }

  /**
   * How a glyph of a run is drawn: from its font's program (after `prepare`), as nothing (a blank
   * glyph), or undefined to draw it with a stand-in face as before.
   */
  glyph(run: GlyphRun, glyph: number): DrawnGlyph | null | undefined {
    const entry = this.state(run.fontDict).glyphs.get(glyph);
    return entry === 'missing' ? undefined : entry;
  }

  private state(dict: PdfDict): FontState {
    let state = this.fonts.get(dict);
    if (!state) {
      state = { program: FontProgram.load(this.doc, dict), glyphs: new Map() };
      this.fonts.set(dict, state);
    }
    return state;
  }
}

/** Packs as many of the fields as fit into one atlas (shelf by shelf, tallest first) and makes its face. */
function pack<T extends { field: Field }>(items: T[]): { items: T[]; face: Omit<DrawnGlyph, 'glyph'> } {
  items.sort((a, b) => b.field.height - a.field.height);
  const placed: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let shelf = 0;
  let count = 0;
  for (const { field } of items) {
    const w = Math.min(field.width, ATLAS_WIDTH);
    if (x + w > ATLAS_WIDTH) {
      x = 0;
      y += shelf + GAP;
      shelf = 0;
    }
    if (y + field.height > MAX_ATLAS_HEIGHT && count) break;
    placed.push({ x, y });
    x += w + GAP;
    shelf = Math.max(shelf, field.height);
    count++;
  }
  const height = y + shelf;
  const taken = items.slice(0, count);
  const pixels = new Uint8Array(ATLAS_WIDTH * height * 4);
  const glyphs: MsdfLayout['glyphs'] = taken.map(({ field }, i) => {
    const { x: ax, y: ay } = placed[i];
    const w = Math.min(field.width, ATLAS_WIDTH);
    for (let j = 0; j < field.height; j++) {
      for (let k = 0; k < w; k++) {
        const from = (j * field.width + k) * 3;
        const to = ((ay + j) * ATLAS_WIDTH + ax + k) * 4;
        pixels[to] = field.pixels[from];
        pixels[to + 1] = field.pixels[from + 1];
        pixels[to + 2] = field.pixels[from + 2];
        pixels[to + 3] = 255;
      }
    }
    return {
      advance: 0,
      // Plane bounds run y down from the baseline.
      planeBounds: { left: field.left, top: -field.top, right: field.left + w / PX_PER_EM, bottom: -field.bottom },
      atlasBounds: { left: ax, top: ay, right: ax + w, bottom: ay + field.height },
    };
  });
  const key = `${KEY_PREFIX}${nextAtlas++}`;
  const layout: MsdfLayout = {
    atlas: { type: 'msdf', distanceRange: RANGE, size: PX_PER_EM, width: ATLAS_WIDTH, height, yOrigin: 'top' },
    metrics: { emSize: 1, lineHeight: 1, ascender: 0.8, descender: -0.2, underlineY: -0.1, underlineThickness: 0.05 },
    glyphs,
  };
  const face: ManifestFace = { weight: 400, italic: false, atlas: key, layout: key, metrics: METRICS };
  const family: ManifestFamily = { id: key, wordName: key, substitute: key, license: '', licenseFile: '', aliases: {}, faces: [face] };
  const font: ResolvedFont = { key, family, face, syntheticItalic: false, syntheticBold: false };
  return { items: taken, face: { font, metrics: new FaceMetrics(face, layout, pixels) } };
}
