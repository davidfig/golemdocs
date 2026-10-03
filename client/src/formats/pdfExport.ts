// Document -> PDF. Lays the document out afresh and writes one PDF page per laid-out page,
// with every glyph at its laid-out pen position.
//
// Fonts: a face whose font file ships with the app (Calibri's Carlito, Arial's Liberation Sans...)
// is embedded, subset to the glyphs used, so the PDF looks as the page does. The file is fetched
// only when a document is exported. Faces without a file (the CJK pages) and styles layout
// fakes (synthetic bold or italic) use the PDF standard-14 fonts (serif -> Times, monospace ->
// Courier, everything else -> Helvetica, with bold/italic variants). Their widths differ from the
// substituted face, so each glyph is placed with its own TJ adjustment: positions match layout
// exactly, and the text stays real, selectable text. Text in a standard font is WinAnsi encoded;
// anything else becomes '?' (or a close ASCII equivalent, see ASCII_FALLBACKS). That includes all
// CJK text: embedding those fonts would mean shipping multi-MB files, so each CJK character
// exports as a visible '?' in its laid-out position and a warning is logged once.

import type { WordDocument } from '@golemdocs/docx';
import { layoutDocument, type FaceMetrics, type FontSet, type GlyphList, type PageLayout, type ResolvedFont } from '@golemdocs/layout';
import { commentAnnotations } from './pdfExportComments.ts';
import { standardFamily } from './standardFonts.ts';
import { PdfDocument, applyAnnotations, type EmbeddedFont, type PageDrawing, type PdfFont, type PdfImage, type RunGlyph } from '@golemdocs/pdf';

/** Characters WinAnsi lacks, with a close ASCII stand-in. */
const ASCII_FALLBACKS: Record<number, string> = {
  0x2010: '-', 0x2011: '-', 0x2012: '-', 0x2212: '-', 0x2043: '-',
  0x2009: ' ', 0x2002: ' ', 0x2003: ' ', 0x202f: ' ', 0x00a0: ' ',
  0x2192: '->', 0x2190: '<-', 0x2264: '<=', 0x2265: '>=', 0x2260: '!=',
  0x0141: 'L', 0x0142: 'l', 0x0104: 'A', 0x0105: 'a', 0x0106: 'C', 0x0107: 'c', 0x0118: 'E', 0x0119: 'e',
  0x0143: 'N', 0x0144: 'n', 0x0179: 'Z', 0x017a: 'z', 0x017b: 'Z', 0x017c: 'z',
  0x2022: '•', 0x25cf: '•', 0x25aa: '•', 0x2023: '•',
};

function standardName(font: ResolvedFont): string {
  const bold = font.face.weight >= 600 || font.syntheticBold;
  const italic = font.face.italic || font.syntheticItalic;
  switch (standardFamily(font)) {
    case 'Times':
      return bold ? (italic ? 'Times-BoldItalic' : 'Times-Bold') : italic ? 'Times-Italic' : 'Times-Roman';
    case 'Courier':
      return bold ? (italic ? 'Courier-BoldOblique' : 'Courier-Bold') : italic ? 'Courier-Oblique' : 'Courier';
    default:
      return bold ? (italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : italic ? 'Helvetica-Oblique' : 'Helvetica';
  }
}

/** Whether a font is drawn from its own file: it has one, and isn't one layout fakes a style of (a standard font shows those better). */
const embeddable = (font: ResolvedFont): boolean => !!font.face.font && !font.syntheticBold && !font.syntheticItalic;

/** Layout's packed little-endian RGBA8 to a PDF color and alpha. */
function unpack(packed: number): { color: [number, number, number]; alpha: number } {
  return {
    color: [(packed & 0xff) / 255, ((packed >> 8) & 0xff) / 255, ((packed >> 16) & 0xff) / 255],
    alpha: (packed >>> 24) / 255,
  };
}

/** A glyph with everything the exporter needs. */
interface PlacedGlyph {
  x: number;
  y: number;
  size: number;
  char: string;
  /** Layout's advance in points. */
  advance: number;
  color: number;
  font: ResolvedFont;
  /** Equation glyphs: the glyph's index in the math font, which is embedded and addressed by index. */
  gid?: number;
}

const CP1252_EXTRAS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d,
  0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/** Whether a standard-14 font (WinAnsi) can show this code point. */
export function inWinAnsi(code: number): boolean {
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || CP1252_EXTRAS.has(code);
}

/** The text to write for a code point: itself, an ASCII stand-in, or '?' when the PDF fonts can't show it. */
export function pdfChar(code: number | undefined): { text: string; lost: boolean } {
  if (code === undefined) return { text: '?', lost: true };
  const fallback = ASCII_FALLBACKS[code];
  if (fallback !== undefined) return { text: fallback, lost: false };
  if (inWinAnsi(code)) return { text: String.fromCodePoint(code), lost: false };
  return { text: '?', lost: true };
}

/** Characters exported as '?' during the current export, for the one-time notice. */
let lostCount = 0;

function charOf(metrics: FaceMetrics, glyph: number): string {
  const c = pdfChar(metrics.layout.glyphs[glyph]?.unicode);
  if (c.lost) lostCount++;
  return c.text;
}

/** The embedded font that draws a laid-out font, if it has a file to embed. */
type EmbeddedFor = (font: ResolvedFont) => EmbeddedFont | undefined;

function collect(page: PageLayout, math: boolean, embeddedFor: EmbeddedFor): PlacedGlyph[] {
  const out: PlacedGlyph[] = [];
  for (const list of page.glyphs.values() as Iterable<GlyphList>) {
    const isMath = list.font.family.math !== undefined;
    // Without the math font's file, an equation can't be written: it is left out.
    if (isMath && !math) continue;
    for (let i = 0; i < list.count; i++) {
      const g = list.glyph(i);
      const size = list.size(i);
      const entry = list.metrics.layout.glyphs[g];
      const embedded = isMath ? undefined : embeddedFor(list.font);
      const code = entry?.unicode;
      // An embedded font shows its own characters (any, not just WinAnsi) where it has them.
      const own = embedded && code !== undefined && embedded.hasChar(code) ? String.fromCodePoint(code) : undefined;
      out.push({
        x: list.x(i),
        y: list.y(i),
        size,
        // Equation glyphs stand for their character (for copying), where they have one.
        char: isMath ? (entry?.unicode === undefined ? '' : String.fromCodePoint(entry.unicode)) : (own ?? charOf(list.metrics, g)),
        advance: list.metrics.advance(g) * size,
        color: list.color(i),
        font: list.font,
        ...(isMath && { gid: entry?.index ?? g }),
      });
    }
  }
  return out;
}

/**
 * Puts glyphs into reading order: each glyph goes to the laid-out line it sits on (nearest in
 * x among lines whose vertical band holds its baseline), lines keep layout order, and glyphs
 * within a line go left to right. Glyph lists are per face, so their own order interleaves
 * bold and regular text and can't be used directly.
 */
function readingOrder(page: PageLayout, glyphs: PlacedGlyph[]): PlacedGlyph[][] {
  const lines = page.lines;
  const buckets: PlacedGlyph[][] = lines.map(() => []);
  const strays: PlacedGlyph[] = [];
  // Index lines by vertical band for speed.
  const order = lines.map((_, i) => i).sort((a, b) => lines[a].y - lines[b].y);
  const tops = order.map((i) => lines[i].y);
  let maxHeight = 0;
  for (const l of lines) maxHeight = Math.max(maxHeight, l.height);
  for (const g of glyphs) {
    // First line (sorted by top) that could contain the baseline.
    let lo = 0;
    let hi = order.length;
    const from = g.y - maxHeight - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    let best = -1;
    let bestDistance = Infinity;
    for (let k = lo; k < order.length && tops[k] <= g.y + 1; k++) {
      const l = lines[order[k]];
      if (g.y < l.y - 1 || g.y > l.y + l.height + 1) continue;
      const distance = g.x < l.x ? l.x - g.x : g.x > l.x + l.width ? g.x - (l.x + l.width) : 0;
      if (distance < bestDistance || (distance === bestDistance && order[k] < best)) {
        best = order[k];
        bestDistance = distance;
      }
    }
    if (best >= 0) buckets[best].push(g);
    else strays.push(g);
  }
  const result = buckets.filter((b) => b.length);
  for (const b of result) b.sort((p, q) => p.x - q.x);
  // Unattached glyphs (nothing recorded a line for them): group by baseline.
  strays.sort((p, q) => p.y - q.y || p.x - q.x);
  let current: PlacedGlyph[] = [];
  for (const g of strays) {
    if (current.length && Math.abs(current[0].y - g.y) > 1) {
      result.push(current);
      current = [];
    }
    current.push(g);
  }
  if (current.length) result.push(current);
  return result;
}

interface Run {
  first: PlacedGlyph;
  pieces: RunGlyph[];
}

/** Splits a line into runs of one font, size, color and baseline, inserting real spaces at gaps. */
function lineRuns(line: PlacedGlyph[]): Run[] {
  const runs: Run[] = [];
  let run: Run | undefined;
  let prev: PlacedGlyph | undefined;
  for (const g of line) {
    const sameRun =
      run && prev && prev.font.key === g.font.key && prev.size === g.size && prev.color === g.color && Math.abs(prev.y - g.y) < 0.01;
    if (prev) {
      const spaceOrigin = prev.x + prev.advance;
      const gap = g.x - spaceOrigin;
      const last = run!.pieces[run!.pieces.length - 1];
      // Equation glyphs are placed exactly; no spaces are put between them.
      const equation = prev.gid !== undefined || g.gid !== undefined;
      if (!equation && gap > 0.1 * Math.max(prev.size, g.size)) {
        // Spaces are not glyphs in layout; a gap between words becomes a real space so text
        // extracts (and copies) with its word breaks.
        last.advance = prev.advance;
        if (sameRun) run!.pieces.push({ text: ' ', advance: g.x - spaceOrigin });
        else run!.pieces.push({ text: ' ' });
      } else if (sameRun) last.advance = g.x - prev.x;
    }
    if (!sameRun) {
      run = { first: g, pieces: [] };
      runs.push(run);
    }
    run!.pieces.push(g.gid === undefined ? { text: g.char } : { text: g.char, glyph: g.gid });
    prev = g;
  }
  return runs;
}

async function coreTitle(doc: WordDocument): Promise<string | undefined> {
  try {
    const xml = new TextDecoder().decode(await doc.media('docProps/core.xml'));
    const m = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(xml);
    if (!m) return undefined;
    const title = m[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .trim();
    return title || undefined;
  } catch {
    return undefined;
  }
}

function drawRects(d: PageDrawing, list: { count: number; rect(i: number): [number, number, number, number]; color(i: number): number }): void {
  if (!list.count) return;
  d.save();
  let current = -1;
  for (let i = 0; i < list.count; i++) {
    const [x, y, w, h] = list.rect(i);
    const packed = list.color(i);
    const { color, alpha } = unpack(packed);
    if (alpha <= 0) continue;
    if (alpha < 1) {
      d.group(() => {
        d.fillColor(color).opacity(alpha).rectPath(x, y, w, h).fill();
      });
      continue;
    }
    if (packed !== current) {
      d.fillColor(color);
      current = packed;
    }
    d.rectPath(x, y, w, h).fill();
  }
  d.restore();
}

/** Lays out `doc` and writes it as a PDF, one PDF page per laid-out page. */
export async function documentToPdf(doc: WordDocument, fonts: FontSet): Promise<Uint8Array> {
  // Fresh layout: the editor's pages have had their buffers transferred away.
  const layout = await layoutDocument(doc, fonts);
  lostCount = 0;
  const pdf = PdfDocument.create();
  const title = await coreTitle(doc);
  if (title) pdf.setMetadata('Title', title);
  pdf.setMetadata('Creator', 'Golem Docs');
  pdf.setMetadata('Producer', 'Golem Docs PDF export');

  // The math font is embedded (a subset of its TrueType build) when an equation is on a page.
  let mathFont: EmbeddedFont | undefined;
  const mathFace = fonts.mathFace;
  if (mathFace?.font && layout.pages.some((page) => [...page.glyphs.values()].some((list) => list.font.family.math))) {
    const file = await fonts.fontFile(mathFace.font);
    if (file) mathFont = pdf.embedFont(file);
    else console.warn('PDF export: the math font file could not be loaded, so equations were left out.');
  }
  // Text faces with a font file are embedded too, each once however often it is used.
  const faceFonts = new Map<string, EmbeddedFont>();
  const files = new Set<string>();
  for (const page of layout.pages) {
    for (const list of page.glyphs.values() as Iterable<GlyphList>) {
      const { font } = list;
      if (!font.family.math && embeddable(font)) files.add(font.face.font!);
    }
  }
  for (const path of files) {
    const file = await fonts.fontFile(path);
    if (!file) continue;
    try {
      faceFonts.set(path, pdf.embedFont(file));
    } catch (e) {
      console.warn(`PDF export: ${path} could not be embedded, so a standard font stands in (${(e as Error).message}).`);
    }
  }
  const embeddedFor: EmbeddedFor = (font) => (embeddable(font) ? faceFonts.get(font.face.font!) : undefined);
  const pdfFonts = new Map<string, PdfFont>();
  const fontFor = (font: ResolvedFont): PdfFont => {
    if (font.family.math && mathFont) return mathFont;
    const face = embeddedFor(font);
    if (face) return face;
    const name = standardName(font);
    let f = pdfFonts.get(name);
    if (!f) pdfFonts.set(name, (f = pdf.standardFont(name)));
    return f;
  };
  const images = new Map<string, PdfImage | null>();
  const imageFor = async (part: string): Promise<PdfImage | null> => {
    if (images.has(part)) return images.get(part)!;
    let image: PdfImage | null = null;
    try {
      image = pdf.embedImage(await doc.media(part));
    } catch {
      image = null; // missing part or an unsupported format: leave the picture out
    }
    images.set(part, image);
    return image;
  };

  const pages = layout.pages.length ? layout.pages : [undefined];
  for (const laid of pages) {
    const page = pdf.addPage(laid ? [laid.width, laid.height] : [612, 792]);
    if (!laid) continue;
    const d = page.draw({ origin: 'top-left' });

    drawRects(d, laid.background);
    const drawImages = async (behind: boolean) => {
      for (const item of laid.images) {
        if (item.behind !== behind) continue;
        const image = await imageFor(item.part);
        if (image) d.image(image, item.x, item.y, item.width, item.height);
      }
    };
    await drawImages(true);

    for (const line of readingOrder(laid, collect(laid, mathFont !== undefined, embeddedFor))) {
      for (const run of lineRuns(line)) {
        const { color } = unpack(run.first.color);
        d.textRun(run.pieces, run.first.x, run.first.y, { font: fontFor(run.first.font), size: run.first.size, color });
      }
    }

    await drawImages(false);
    drawRects(d, laid.foreground);
    d.finish();
  }
  const notes = commentAnnotations(doc, layout.pages);
  if (notes.length) applyAnnotations(pdf, notes);
  if (lostCount) {
    console.warn(`PDF export: ${lostCount} character(s) the PDF standard fonts can't show (e.g. Japanese or Chinese text) were written as '?'.`);
    lostCount = 0;
  }
  return pdf.save();
}

