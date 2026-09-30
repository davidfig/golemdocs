// Showing a character that a run's font doesn't encode (typed into a subset font, say). Tried in
// order of how close the result comes to the text around it:
//
// 1. Another font in the file made from the same face: another subset of it (producers often
//    write one per page or per style run) or the form's default resources. Same glyphs, exactly.
// 2. The same font program, reached through a copy of the font dictionary. An embedded TrueType
//    font often holds glyphs its dictionary never maps: the whole font was embedded, or the
//    subset kept more than was shown. The copy maps every glyph the program has an outline for.
//    (Then the same for the fonts of step 1.)
// 3. A standard font, sized and scaled to pass for the font: Helvetica, Times or Courier by the
//    font's name and flags (and by its widths, for whether it is monospaced), at the size that
//    gives it the font's x-height (else cap height) and the horizontal scaling that gives it the
//    font's widths.
//
// The copies of step 2 are made once per document and font, holding every glyph the program has
// (not only those asked for so far), so they never change once text uses them.

import { PdfDict, PdfName, PdfStream, type PdfObject, type PdfRef } from '../core/objects.ts';
import type { PdfDocument } from '../document.ts';
import { TrueTypeFont } from '../fonts/truetype.ts';
import type { PdfPage } from '../page.ts';
import { describeFont, type FontStyle } from '../render/fontinfo.ts';
import { TextFont } from '../text/font.ts';
import { toUnicodeCMap } from '../write/fonts.ts';
import type { FontUse } from './scan.ts';
import type { Fallback } from './text.ts';

/** A font as shown on a page: its dictionary (by reference, when it has one) and how it reads. */
interface Face {
  value: PdfObject;
  textFont: TextFont;
  style: FontStyle;
}

interface DocFonts {
  /** Fonts by name (without a subset tag): every page's, and the form's default ones. */
  byName: Map<string, Face[]> | undefined;
  /** Copies that reach more of the font program; null where there is nothing more. */
  extended: Map<TextFont, Face | null>;
  /** How a font's text is best passed off in a standard font. */
  standard: Map<TextFont, StandardMatch>;
}

const caches = new WeakMap<PdfDocument, DocFonts>();

function docFonts(doc: PdfDocument): DocFonts {
  let c = caches.get(doc);
  if (!c) caches.set(doc, (c = { byName: undefined, extended: new Map(), standard: new Map() }));
  return c;
}

const bareName = (name: string): string => name.replace(/^[A-Z]{6}\+/, '');

// --- the standard fonts ------------------------------------------------------------------------

/** The standard font for a family and style, in the page's resources, as a style's font. */
export function standardUse(doc: PdfDocument, page: PdfPage, name: string): { use: FontUse; encode(ch: string): Uint8Array | null; width(ch: string): number } {
  const pdfFont = doc.standardFont(name);
  const dict = doc.dict(pdfFont.ref) as PdfDict;
  const resource = page.addResource('Font', pdfFont.ref, 'F');
  const use: FontUse = { resource, textFont: new TextFont(doc, dict), style: describeFont(doc, dict) };
  return {
    use,
    encode: (ch) => (pdfFont.hasChar(ch.codePointAt(0)!) ? pdfFont.encode(ch) : null),
    width: (ch) => pdfFont.widthOf(ch, 1),
  };
}

export type Kind = 'sans' | 'serif' | 'mono';

/** The standard fonts of each kind: regular, bold, italic, bold italic. */
export const STANDARD: Record<Kind, [string, string, string, string]> = {
  sans: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  serif: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  mono: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
};

export interface StandardMatch {
  /** The standard font's name. */
  font: string;
  /** Multiplies the size (to match heights) and the horizontal scaling (to match widths). */
  size: number;
  scale: number;
}

/** Fewer letters than this and widths say too little. */
const MIN_SAMPLES = 5;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The descriptor of a font (a composite font's is its descendant's). */
function descriptorOf(doc: PdfDocument, dict: PdfDict): PdfDict | undefined {
  const own = doc.dict(dict.get('FontDescriptor'));
  if (own || dict.name('Subtype') !== 'Type0') return own;
  return doc.dict(doc.dict(doc.array(dict.get('DescendantFonts'))?.[0])?.get('FontDescriptor'));
}

/**
 * The standard font that best passes for this one, and at what size and scaling.
 *
 * Serif or sans comes from the font's name and flags: letters' widths are a poor guide to it (a
 * humanist sans like Calibri is proportioned more like Times than Helvetica), and it matters
 * more to the eye than width. Widths do settle whether the font is monospaced: letters that
 * are all one width, among them some that no proportional font gives the same. The size gives
 * the stand-in the font's x-height (else cap height), from its descriptor; the scaling gives it
 * the font's widths, the median over the letters both have. Only letters are compared: digits
 * are one width in every font, and punctuation is where fonts with their own encodings (TeX's)
 * put other glyphs.
 */
export function matchStandard(doc: PdfDocument, font: TextFont, style: FontStyle): StandardMatch {
  const cache = docFonts(doc).standard;
  const known = cache.get(font);
  if (known) return known;
  const variant = (style.bold ? 1 : 0) + (style.italic ? 2 : 0);
  const letters = style.symbolic ? [] : [...font.characters].filter(([ch, e]) => /^[A-Za-z]$/.test(ch) && e.width > 0);

  let kind: Kind = style.mono ? 'mono' : style.serif ? 'serif' : 'sans';
  if (letters.length >= MIN_SAMPLES) {
    const own = letters.map(([, e]) => e.width);
    const sans = letters.map(([ch]) => doc.standardFont(STANDARD.sans[0]).widthOf(ch, 1));
    // Telling: letters a proportional font makes of quite different widths.
    if (Math.max(...sans) / Math.min(...sans) > 1.3) {
      const fixed = Math.max(...own) / Math.min(...own) < 1.05;
      if (fixed) kind = 'mono';
      else if (kind === 'mono') kind = style.serif ? 'serif' : 'sans';
    }
  }
  const name = STANDARD[kind][variant];
  const std = doc.standardFont(name);

  let size = 1;
  const descriptor = descriptorOf(doc, font.dict);
  const xHeight = doc.number(descriptor?.get('XHeight')) ?? 0;
  const capHeight = doc.number(descriptor?.get('CapHeight')) ?? 0;
  if (xHeight > 0) size = xHeight / standardHeights[kind].xHeight;
  else if (capHeight > 0) size = capHeight / standardHeights[kind].capHeight;
  // Far off, the descriptor is more likely wrong than the font that odd.
  size = size > 0.75 && size < 1.33 ? clamp(size, 0.85, 1.15) : 1;

  let scale = 1;
  const ratios = letters.filter(([ch]) => std.hasChar(ch.codePointAt(0)!)).map(([ch, e]) => e.width / std.widthOf(ch, 1));
  if (ratios.length >= MIN_SAMPLES) {
    const width = median(ratios) / size;
    scale = width > 0.6 && width < 1.6 ? clamp(width, 0.75, 1.25) : 1;
  }
  const match = { font: name, size, scale };
  cache.set(font, match);
  return match;
}

/** Heights of the standard families, 1/1000 em (their AFM files' XHeight and CapHeight). */
const standardHeights: Record<Kind, { xHeight: number; capHeight: number }> = {
  sans: { xHeight: 523, capHeight: 718 },
  serif: { xHeight: 450, capHeight: 662 },
  mono: { xHeight: 426, capHeight: 562 },
};

// --- the font's own program ----------------------------------------------------------------------

const isBlank = (ch: string) => /^\s$/u.test(ch);
const privateUse = (cp: number) => cp >= 0xe000 && cp <= 0xf8ff;

function program(doc: PdfDocument, descriptor: PdfDict | undefined): TrueTypeFont | null {
  const file = doc.resolve(descriptor?.get('FontFile2'));
  if (!(file instanceof PdfStream)) return null;
  try {
    const font = TrueTypeFont.parse(doc.streamData(file));
    return font.isCff ? null : font;
  } catch {
    return null;
  }
}

/**
 * A copy of a composite TrueType font (Identity-H) whose widths and /ToUnicode reach every glyph
 * the program has an outline for and a character maps to.
 */
function extendComposite(doc: PdfDocument, font: TextFont): PdfDict | null {
  const dict = font.dict;
  if (font.vertical || dict.name('Encoding') !== 'Identity-H') return null;
  const descendants = doc.array(dict.get('DescendantFonts'));
  const cidFont = doc.dict(descendants?.[0]);
  if (!cidFont || cidFont.name('Subtype') !== 'CIDFontType2') return null;
  const ttf = program(doc, doc.dict(cidFont.get('FontDescriptor')));
  if (!ttf) return null;
  const source = font.unicodeSource;
  if (source.kind === 'identity') return null;

  // CID for each glyph: the same number (Identity), else back through the /CIDToGIDMap stream.
  const map = doc.resolve(cidFont.get('CIDToGIDMap'));
  let cidOf: (gid: number) => number | undefined = (gid) => gid;
  if (map instanceof PdfStream) {
    const bytes = doc.streamData(map);
    const back = new Map<number, number>();
    for (let cid = 0; cid * 2 + 1 < bytes.length; cid++) {
      const gid = (bytes[cid * 2] << 8) | bytes[cid * 2 + 1];
      if (gid && !back.has(gid)) back.set(gid, cid);
    }
    cidOf = (gid) => back.get(gid);
  }

  const have = font.characters;
  const added = new Map<number, { text: string; width: number }>();
  for (const [cp, gid] of ttf.codePoints) {
    const ch = String.fromCodePoint(cp);
    if (privateUse(cp) || have.has(ch)) continue;
    if (!ttf.hasOutline(gid) && !(isBlank(ch) && gid > 0 && gid < ttf.numGlyphs)) continue;
    const cid = cidOf(gid);
    if (cid === undefined || cid > 0xffff || added.has(cid)) continue;
    // A CID the font already reads as something else keeps its meaning.
    const was = font.decode(Uint8Array.of(cid >> 8, cid & 255))[0]?.text;
    if (was && was !== ch) continue;
    added.set(cid, { text: ch, width: Math.round(ttf.advance(gid) * ttf.scale) });
  }
  if (!added.size) return null;

  const widths: PdfObject[] = [...(doc.array(cidFont.get('W')) ?? [])];
  for (const [cid, { width }] of added) if (!font.hasWidth(cid)) widths.push(cid, [width]);
  const descendant = cidFont.clone();
  descendant.set('W', widths);
  const copy = dict.clone();
  copy.set('DescendantFonts', [doc.add(descendant)]);
  if (source.kind === 'stream') {
    const texts = new Map<number, string>();
    for (const [code, bytes, text] of source.entries) if (bytes === 2) texts.set(code, text);
    for (const [cid, { text }] of added) if (!texts.has(cid)) texts.set(cid, text);
    copy.set('ToUnicode', doc.add(new PdfStream(new PdfDict(), toUnicodeCMap(texts))));
  }
  return copy;
}

/**
 * A copy of a simple TrueType font whose widths reach every code of its encoding that the program
 * has an outline for. Only a nonsymbolic font: its codes reach glyphs through their characters.
 */
function extendSimple(doc: PdfDocument, font: TextFont): PdfDict | null {
  const dict = font.dict;
  if (font.subtype !== 'TrueType') return null;
  const descriptor = doc.dict(dict.get('FontDescriptor'));
  const flags = doc.number(descriptor?.get('Flags')) ?? 0;
  if ((flags & 32) === 0 || (flags & 4) !== 0) return null;
  const ttf = program(doc, descriptor);
  if (!ttf) return null;
  const have = font.characters;
  const widths = new Map<number, number>();
  for (let code = 0; code < 256; code++) {
    if (font.hasWidth(code)) widths.set(code, font.decode(Uint8Array.of(code))[0].width / font.fontMatrix[0]);
  }
  let added = 0;
  for (let code = 32; code < 256; code++) {
    const ch = font.decode(Uint8Array.of(code))[0].text;
    // Subsetters give the codes they leave out a width of 0.
    if ([...ch].length !== 1 || have.has(ch) || widths.get(code)) continue;
    const gid = ttf.glyphForCodePoint(ch.codePointAt(0)!);
    if (!ttf.hasOutline(gid) && !(isBlank(ch) && gid > 0)) continue;
    widths.set(code, Math.round(ttf.advance(gid) * ttf.scale));
    added++;
  }
  if (!added) return null;
  const first = Math.min(...widths.keys());
  const last = Math.max(...widths.keys());
  const copy = dict.clone();
  copy.set('FirstChar', first);
  copy.set('LastChar', last);
  copy.set('Widths', Array.from({ length: last - first + 1 }, (_, i) => Math.round((widths.get(first + i) ?? 0) * 1000) / 1000));
  return copy;
}

/** A copy of the font reaching more of its program, or null if there's no more to reach. */
function extended(doc: PdfDocument, face: Face): Face | null {
  const cache = docFonts(doc).extended;
  let found = cache.get(face.textFont);
  if (found !== undefined) return found;
  found = null;
  try {
    const copy = face.textFont.composite ? extendComposite(doc, face.textFont) : extendSimple(doc, face.textFont);
    if (copy) found = { value: doc.add(copy), textFont: new TextFont(doc, copy), style: face.style };
  } catch {
    // a font program we can't read: nothing more to reach
  }
  cache.set(face.textFont, found);
  return found;
}

// --- other fonts of the same face ------------------------------------------------------------------

function fontsByName(doc: PdfDocument): Map<string, Face[]> {
  const c = docFonts(doc);
  if (c.byName) return c.byName;
  const out = new Map<string, Face[]>();
  const seen = new Set<unknown>();
  const visit = (fonts: PdfDict | undefined) => {
    if (!fonts) return;
    for (const [, value] of fonts) {
      const key = typeof value === 'object' && value && 'key' in value ? (value as PdfRef).key : value;
      if (seen.has(key)) continue;
      seen.add(key);
      const dict = doc.dict(value);
      const base = dict?.get('BaseFont');
      if (!dict || !(base instanceof PdfName)) continue;
      const name = bareName(base.name);
      if (!name) continue;
      try {
        const face = { value, textFont: new TextFont(doc, dict), style: describeFont(doc, dict) };
        out.set(name, [...(out.get(name) ?? []), face]);
      } catch {
        // an unreadable font: not a candidate
      }
    }
  };
  for (const page of doc.pages) visit(doc.dict(doc.dict(page.inherited('Resources'))?.get('Font')));
  visit(doc.dict(doc.dict(doc.dict(doc.catalog.get('AcroForm'))?.get('DR'))?.get('Font')));
  c.byName = out;
  return out;
}

// --- all together ------------------------------------------------------------------------------------

/** Shows a character a run's font lacks in whatever comes closest to that font (see the top of this file). */
export function textFallback(doc: PdfDocument, page: PdfPage): Fallback {
  const standard = new Map<string, ReturnType<typeof standardUse>>();
  const on = (face: Face, ch: string) => {
    const e = face.textFont.characters.get(ch);
    return e && { font: { resource: page.addResource('Font', face.value, 'F'), textFont: face.textFont, style: face.style }, bytes: e.bytes, width: e.width };
  };
  return (style, ch) => {
    const font = style.font.textFont;
    const self: Face = { value: font.dict, textFont: font, style: style.font.style };
    const name = bareName(font.name);
    const siblings = name ? (fontsByName(doc).get(name) ?? []).filter((f) => f.textFont.dict !== font.dict) : [];
    for (const face of siblings) {
      const hit = on(face, ch);
      if (hit) return hit;
    }
    for (const face of [self, ...siblings]) {
      const more = extended(doc, face);
      const hit = more && on(more, ch);
      if (hit) return hit;
    }
    const match = matchStandard(doc, font, style.font.style);
    let use = standard.get(match.font);
    if (!use) standard.set(match.font, (use = standardUse(doc, page, match.font)));
    const bytes = use.encode(ch);
    return bytes ? { font: use.use, bytes, width: use.width(ch), size: match.size, scale: match.scale } : null;
  };
}
