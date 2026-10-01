// Opens a PDF as a stack of read-only PageLayouts: every glyph sits where the PDF puts it (the
// PDF font's own advances position each character), drawn with our substitute MSDF faces.
// Pages are interpreted lazily, one layoutPage() call each. The page text stays unchanged; what
// can change is the layer of markup annotations over it (highlights, notes...: see
// @golemdocs/pdf annotations), which are drawn from the appearance streams they're given.

import { FontSet, PageLayout, isCjk, isHangul, langOfFontName, packColor, type CjkLang, type FaceMetrics, type ManifestFace, type ResolvedFont } from '@golemdocs/layout';
import { PdfDocument, applyAnnotations, applyEdits, applyFields, blockFromRuns, collectCharacters, collectFonts, findBlocks, imageBytes, interpretPage, readAnnotations, readFields, scanPage, type Annotation, type ApplyResult, type Box, type FormField, type DisplayImage, type FontStyle, type GlyphRun, type PageObject, type PdfEdit, type TextBlock, type TextRun } from '@golemdocs/pdf';
import { pageCharacters, type PdfCharacter } from './pdfText.ts';
import type { EditFonts } from './pdfFonts.ts';

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
  /** The edits made to the pages' own content (text changed, text boxes added). */
  readonly edits: readonly PdfEdit[];
  /** Shows these edits instead (pages laid out afterwards show them), and where each one's text now is. */
  setEdits(edits: readonly PdfEdit[]): ApplyResult;
  /** Where each applied edit's text is (user space), as of the last `setEdits`. */
  readonly editBoxes: ReadonlyMap<string, Box>;
  /** Loads a family's font file (for text set in it to be written into the file) and the file the page draws it with. */
  loadFont(family: string, bold: boolean, italic: boolean): Promise<void>;
  /** The font file the page's own face for `family` (or, with none, for a PDF font's look) comes from, to show text in the same font. */
  faceFile(family: string | undefined, look: { bold: boolean; italic: boolean; style?: FontStyle }): string | undefined;
  /** Loads the faces that stand in for characters an edit adds (in this kind of font, in all four styles). */
  ensureFonts(serif: boolean, mono: boolean): Promise<void>;
  /** Page `index`'s media box [x0 y0 x1 y1] in user space. */
  mediaBox(index: number): Box;
  /** The text of page `index` as it was in the file, whatever has been edited: its blocks and runs. */
  original(index: number): { blocks: TextBlock[]; runs: TextRun[]; objects: PageObject[] };
  /** The block of the original page made of these runs. */
  originalBlock(index: number, runs: readonly string[]): TextBlock | null;
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
  // A font embedded from the app's own files is named for the open-source face the app draws it with (Carlito, Liberation Sans...).
  const own = style.family && fonts.families.find((f) => f.substitute.toLowerCase() === style.family.toLowerCase());
  if (own) return own.wordName;
  if (style.mono) return 'Courier New';
  if (style.serif) return 'Times New Roman';
  return 'Arial';
}

const isKana = (cp: number) => cp >= 0x3040 && cp <= 0x30ff;

/** Font names as PDFs write them (no spaces: "MicrosoftJhengHeiUIRegular", "DFHei-W5-WIN-BF"), by language. */
const PDF_CJK_NAMES: [RegExp, CjkLang][] = [
  [/jhenghei|mingliu|dfkai|kaiu|dfhei|dfming|twkai|pingfang(tc|hk)|(cjk|sans|serif)(tc|hk)|big5|-bf$/, 'zh-Hant'],
  [/simsun|simhei|nsimsun|yahei|kaiti|fangsong|dengxian|stsong|stheiti|stkaiti|pingfangsc|(cjk|sans|serif)sc|gb2312|gbk/, 'zh-Hans'],
  // Korean before Japanese: "Malgun Gothic".
  [/malgun|gulim|batang|dotum|gungsuh|(cjk|sans|serif)kr|nanum/, 'ko'],
  [/mincho|gothic|meiryo|hiragino|yugo|yumin|(cjk|sans|serif)jp|kozuka|kozmin|kozgo/, 'ja'],
];

/** The CJK language a PDF font is for: by its name, else by the characters it holds, else the app's. */
export function cjkLangOf(fonts: FontSet, name: string, codePoints: Iterable<number>): CjkLang {
  const byName = langOfFontName(name) ?? PDF_CJK_NAMES.find(([re]) => re.test(name.toLowerCase().replace(/[\s_]/g, '')))?.[1];
  if (byName) return byName;
  for (const cp of codePoints) {
    if (isHangul(cp)) return 'ko';
    if (isKana(cp)) return 'ja';
  }
  return fonts.defaultCjkLang;
}

interface FaceChoice {
  resolved: ResolvedFont;
  metrics: FaceMetrics | undefined;
}

/**
 * Opens a PDF. Throws PdfError for files that aren't PDFs and PasswordError/EncryptionError
 * for encrypted ones without the right password (exported by @golemdocs/pdf).
 */
export async function openPdfView(
  bytes: Uint8Array,
  fonts: FontSet,
  options: { password?: string; annotations?: readonly Annotation[]; fields?: readonly FormField[]; edits?: readonly PdfEdit[]; editFonts?: EditFonts } = {},
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
  let edits: readonly PdfEdit[] = [];
  let editBoxes: ReadonlyMap<string, Box> = new Map();
  if (options.edits?.length) {
    // Fonts the edits set text in are loaded first (applying them is not asynchronous).
    await options.editFonts?.ensure(options.edits);
    const applied = applyEdits(doc, options.edits, options.editFonts?.options);
    edits = options.edits;
    editBoxes = applied.boxes;
  }
  // The file's own text, for finding what a click hit: read from a second copy, which edits never touch.
  let pristine: PdfDocument | undefined;
  const originals = new Map<number, { blocks: TextBlock[]; runs: TextRun[]; objects: PageObject[] }>();
  const original = (index: number) => {
    let found = originals.get(index);
    if (!found) {
      pristine ??= PdfDocument.load(bytes, { password: options.password });
      const page = pristine.pages[index];
      const scan = page ? scanPage(page) : { runs: [], objects: [] };
      found = { blocks: findBlocks(scan.runs), runs: scan.runs, objects: scan.objects };
      originals.set(index, found);
    }
    return found;
  };
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
  // Our faces are Latin: East Asian characters are drawn from the CJK pages of the font's language.
  // Their metrics load now, for the characters the fonts hold, since layoutPage is synchronous.
  const cjkLangs = new Map<string, CjkLang>();
  try {
    const byLang = new Map<CjkLang, Set<number>>();
    for (const { name, codePoints } of collectCharacters(doc)) {
      const cjk = [...codePoints].filter(isCjk);
      if (!cjk.length) continue;
      const lang = cjkLangOf(fonts, name, codePoints);
      cjkLangs.set(name, lang);
      const set = byLang.get(lang) ?? new Set<number>();
      for (const cp of cjk) set.add(cp);
      byLang.set(lang, set);
    }
    await Promise.all([...byLang].map(([lang, cps]) => fonts.ensureCjk(lang, cps)));
  } catch (e) {
    warn(`could not load East Asian fonts (${(e as Error).message})`);
  }
  await fonts.ensure(wanted.keys());
  const fallback = choose(fallbackStyle);

  /** The loaded CJK face that has a character, for a run of this font. */
  const cjkFace = (run: GlyphRun, cp: number): { resolved: ResolvedFont; metrics: FaceMetrics; glyph: number } | undefined => {
    const lang = cjkLangs.get(run.name) ?? cjkLangOf(fonts, run.name, [cp]);
    for (const resolved of fonts.cjkFonts(lang, false, false)) {
      const metrics = fonts.metrics(resolved.face);
      const glyph = metrics ? metrics.glyph(cp) : -1;
      if (metrics && glyph >= 0) return { resolved, metrics, glyph };
    }
    return undefined;
  };

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
        if (glyph >= 0) {
          if (metrics.visible[glyph]) list.push(g.x, g.y, run.size, glyph, color);
        } else if (isCjk(cps[0])) {
          const cjk = cjkFace(run, cps[0]);
          if (cjk?.metrics.visible[cjk.glyph]) page.glyphList(cjk.resolved, cjk.metrics).push(g.x, g.y, run.size, cjk.glyph, color);
        }
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

    get edits() {
      return edits;
    },

    get editBoxes() {
      return editBoxes;
    },

    setEdits(next: readonly PdfEdit[]): ApplyResult {
      const applied = applyEdits(doc, next, options.editFonts?.options);
      edits = next;
      editBoxes = applied.boxes;
      characterCache.clear();
      return applied;
    },

    original,

    async loadFont(family: string, bold: boolean, italic: boolean): Promise<void> {
      await options.editFonts?.load(family, bold, italic);
      // And the face the page draws it with.
      if (fonts.isKnown(family)) await fonts.ensure([fonts.resolve({ font: family, bold, italic }).face]);
    },

    faceFile(family: string | undefined, look: { bold: boolean; italic: boolean; style?: FontStyle }): string | undefined {
      if (family && options.editFonts?.path(family, look.bold, look.italic)) return options.editFonts.path(family, look.bold, look.italic);
      const style = look.style;
      if (!style) return undefined;
      return choose(style).resolved.face.font;
    },

    async ensureFonts(serif: boolean, mono: boolean): Promise<void> {
      const family = familyFor(fonts, { name: '', family: '', bold: false, italic: false, serif, mono, symbolic: false });
      const faces = [false, true].flatMap((bold) => [false, true].map((italic) => fonts.resolve({ font: family, bold, italic }).face));
      await fonts.ensure(faces);
    },

    mediaBox(index: number): Box {
      return doc.pages[index].mediaBox;
    },

    originalBlock(index: number, runs: readonly string[]): TextBlock | null {
      return blockFromRuns(original(index).runs, runs);
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
