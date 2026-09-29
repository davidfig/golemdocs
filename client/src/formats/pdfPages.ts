// Opens a PDF as a stack of read-only PageLayouts: every glyph sits where the PDF puts it (the
// PDF font's own advances position each character), drawn with our substitute MSDF faces.
// Pages are interpreted lazily, one layoutPage() call each. The page text stays unchanged; what
// can change is the layer of markup annotations over it (highlights, notes...: see
// @word/pdf annotations), which are drawn from the appearance streams they're given.

import { FontSet, PageLayout, packColor, type FaceMetrics, type ManifestFace, type ResolvedFont } from '@word/layout';
import { PdfDocument, applyAnnotations, applyFields, collectFonts, imageBytes, interpretPage, readAnnotations, readFields, type Annotation, type FormField, type DisplayImage, type FontStyle, type GlyphRun } from '@word/pdf';
import { pageCharacters, type PdfCharacter } from './pdfText.ts';

export type { PdfCharacter };

export interface PdfView {
  readonly pageCount: number;
  /** Problems found while opening and laying out pages (grows as pages are laid out). */
  readonly warnings: string[];
  /** A fresh layout of page `index` (zero-based), as a page with id `id` (default: the index). */
  layoutPage(index: number, id?: number): PageLayout;
  /** The markup annotations shown. */
  readonly annotations: readonly Annotation[];
  /** Shows these annotations instead (pages laid out afterwards show them). */
  setAnnotations(annotations: readonly Annotation[]): void;
  /** The form fields. Pages don't draw them: the app shows them as inputs over the page. */
  readonly fields: readonly FormField[];
  setFields(fields: readonly FormField[]): void;
  /** Page `index`'s characters, for selecting text. */
  characters(index: number): PdfCharacter[];
  /** Page coordinates (points from the top-left, y down) to the page's user space (y up). */
  toUser(index: number, x: number, y: number): [number, number];
  /** User space to page coordinates. */
  toPage(index: number, x: number, y: number): [number, number];
  /** Bytes of an image referenced by a laid-out page's `ImageItem.part`. */
  media(part: string): Promise<Uint8Array | null>;
}

const MAX_WARNINGS = 200;
const IMAGE_PART = 'pdf-image:';

const LIGATURES: Record<string, string> = { ff: 'ﬀ', fi: 'ﬁ', fl: 'ﬂ', ffi: 'ﬃ', ffl: 'ﬄ', st: 'ﬆ' };

/** Which of our families stands in for a PDF font. */
function familyFor(fonts: FontSet, style: FontStyle): string {
  if (style.family && fonts.isKnown(style.family)) return style.family;
  if (style.mono) return 'Courier New';
  if (style.serif) return 'Times New Roman';
  return 'Arial';
}

interface FaceChoice {
  resolved: ResolvedFont;
  metrics: FaceMetrics | undefined;
}

/**
 * Opens a PDF. Throws PdfError for files that aren't PDFs and PasswordError/EncryptionError
 * for encrypted ones without the right password (exported by @word/pdf).
 */
export async function openPdfView(
  bytes: Uint8Array,
  fonts: FontSet,
  options: { password?: string; annotations?: readonly Annotation[]; fields?: readonly FormField[] } = {},
): Promise<PdfView> {
  const doc = PdfDocument.load(bytes, { password: options.password });
  let annotations: readonly Annotation[] = readAnnotations(doc);
  if (options.annotations) {
    applyAnnotations(doc, options.annotations);
    annotations = options.annotations;
  }
  let fields: readonly FormField[] = readFields(doc);
  if (options.fields) {
    applyFields(doc, options.fields);
    fields = options.fields;
  }
  const characterCache = new Map<number, PdfCharacter[]>();
  const warnings: string[] = [...doc.warnings];
  const seenWarnings = new Set(warnings);
  const warn = (message: string) => {
    if (warnings.length >= MAX_WARNINGS || seenWarnings.has(message)) return;
    seenWarnings.add(message);
    warnings.push(message);
  };

  // Face resolution is cached per (family, bold, italic); metrics load up front for every face
  // the pages' font resources will ask for, since layoutPage is synchronous.
  const choices = new Map<string, FaceChoice>();
  const choose = (style: FontStyle): FaceChoice => {
    const family = familyFor(fonts, style);
    const key = `${family}|${style.bold ? 1 : 0}${style.italic ? 1 : 0}`;
    let c = choices.get(key);
    if (!c) {
      const resolved = fonts.resolve({ font: family, bold: style.bold, italic: style.italic });
      c = { resolved, metrics: fonts.metrics(resolved.face) };
      choices.set(key, c);
    }
    if (!c.metrics) c.metrics = fonts.metrics(c.resolved.face);
    return c;
  };
  const fallbackStyle: FontStyle = { name: 'Arial', family: 'Arial', bold: false, italic: false, serif: false, mono: false, symbolic: false };
  const wanted = new Map<ManifestFace, true>();
  const want = (style: FontStyle) => wanted.set(fonts.resolve({ font: familyFor(fonts, style), bold: style.bold, italic: style.italic }).face, true);
  want(fallbackStyle);
  try {
    for (const style of collectFonts(doc)) want(style);
  } catch (e) {
    warn(`could not scan fonts (${(e as Error).message})`);
  }
  await fonts.ensure(wanted.keys());
  const fallback = choose(fallbackStyle);

  const images = new Map<string, DisplayImage>();
  const partById = new Map<string, string>();
  const bytesByPart = new Map<string, Promise<Uint8Array | null>>();

  const pushRun = (page: PageLayout, run: GlyphRun): void => {
    const choice = choose(run);
    const metrics = choice.metrics ?? fallback.metrics;
    const resolved = choice.metrics ? choice.resolved : fallback.resolved;
    if (!metrics) return;
    const list = page.glyphList(resolved, metrics);
    const color = packColor(run.color, run.alpha);
    for (const g of run.glyphs) {
      const cps = Array.from(g.unicode, (ch) => ch.codePointAt(0)!);
      if (cps.length === 1) {
        const glyph = metrics.glyph(cps[0]);
        if (glyph >= 0 && metrics.visible[glyph]) list.push(g.x, g.y, run.size, glyph, color);
        continue;
      }
      const ligature = LIGATURES[g.unicode];
      if (ligature && metrics.has(ligature.codePointAt(0)!)) {
        list.push(g.x, g.y, run.size, metrics.glyph(ligature.codePointAt(0)!), color);
        continue;
      }
      // Several characters in one PDF glyph: share its advance in proportion to our glyph widths.
      const indices = cps.map((cp) => metrics.glyph(cp));
      const natural = indices.reduce((n, gi) => n + metrics.advance(gi) * run.size, 0);
      const scale = natural > 0 && g.advance > 0 ? g.advance / natural : 1;
      let x = g.x;
      indices.forEach((gi) => {
        if (gi >= 0 && metrics.visible[gi]) list.push(x, g.y, run.size, gi, color);
        x += metrics.advance(gi) * run.size * scale;
      });
    }
  };

  return {
    pageCount: doc.pageCount,
    warnings,

    get annotations() {
      return annotations;
    },

    setAnnotations(next: readonly Annotation[]): void {
      applyAnnotations(doc, next);
      annotations = next;
    },

    get fields() {
      return fields;
    },

    setFields(next: readonly FormField[]): void {
      applyFields(doc, next);
      fields = next;
    },

    characters(index: number): PdfCharacter[] {
      let chars = characterCache.get(index);
      if (!chars) {
        chars = pageCharacters(doc, index);
        characterCache.set(index, chars);
      }
      return chars;
    },

    toUser(index: number, x: number, y: number): [number, number] {
      const page = doc.pages[index];
      // toDisplay is affine: invert it from three points.
      const [ox, oy] = page.toDisplay(0, 0);
      const [ax, ay] = page.toDisplay(1, 0);
      const [bx, by] = page.toDisplay(0, 1);
      const [a, b, c, d] = [ax - ox, ay - oy, bx - ox, by - oy];
      const det = a * d - b * c;
      const dx = x - ox;
      const dy = y - oy;
      return [(dx * d - dy * c) / det, (dy * a - dx * b) / det];
    },

    toPage(index: number, x: number, y: number): [number, number] {
      return doc.pages[index].toDisplay(x, y);
    },

    layoutPage(index: number, id = index): PageLayout {
      const pdfPage = doc.pages[index];
      if (!pdfPage) throw new RangeError(`no page ${index} (the document has ${doc.pageCount})`);
      let display;
      try {
        display = interpretPage(pdfPage, { hideFields: true });
      } catch (e) {
        warn(`page ${index + 1} could not be read (${(e as Error).message})`);
        return new PageLayout(id, 612, 792, 0, index + 1);
      }
      for (const w of display.warnings) warn(`page ${index + 1}: ${w}`);
      const page = new PageLayout(id, display.width, display.height, 0, index + 1);
      for (const r of display.rects) (r.over ? page.foreground : page.background).push(r.x, r.y, r.w, r.h, packColor(r.color, r.alpha));
      for (const run of display.glyphRuns) pushRun(page, run);
      for (const image of display.images) {
        let part = partById.get(image.id);
        if (!part) {
          part = IMAGE_PART + partById.size;
          partById.set(image.id, part);
          images.set(part, image);
        }
        page.images.push({ part, x: image.x, y: image.y, width: image.w, height: image.h, behind: false });
      }
      return page;
    },

    media(part: string): Promise<Uint8Array | null> {
      let cached = bytesByPart.get(part);
      if (!cached) {
        const image = images.get(part);
        cached = Promise.resolve().then(() => {
          if (!image) return null;
          const out = imageBytes(doc, image);
          if (!out) warn(`image ${part} could not be decoded`);
          return out ? out.bytes : null;
        });
        bytesByPart.set(part, cached);
      }
      return cached;
    },
  };
}
