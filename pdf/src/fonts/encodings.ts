// Simple-font encodings, glyph names to Unicode, and the standard 14 fonts' metrics, over the
// generated tables in data.ts.

import {
  GLYPH_LIST,
  LATIN_GLYPHS,
  MAC_ROMAN_ENCODING,
  STANDARD_ENCODING,
  STANDARD_FONTS,
  SYMBOL_ENCODING,
  WIN_ANSI_ENCODING,
  ZAPF_DINGBATS_ENCODING,
  type StandardFontData,
} from './data.ts';

export type EncodingName = 'StandardEncoding' | 'WinAnsiEncoding' | 'MacRomanEncoding' | 'SymbolEncoding' | 'ZapfDingbatsEncoding';

const encodingCache = new Map<string, string[]>();
const SOURCES: Record<EncodingName, string> = {
  StandardEncoding: STANDARD_ENCODING,
  WinAnsiEncoding: WIN_ANSI_ENCODING,
  MacRomanEncoding: MAC_ROMAN_ENCODING,
  SymbolEncoding: SYMBOL_ENCODING,
  ZapfDingbatsEncoding: ZAPF_DINGBATS_ENCODING,
};

/** 256 glyph names ('' for unused codes). */
export function encoding(name: EncodingName): string[] {
  let e = encodingCache.get(name);
  if (!e) {
    e = SOURCES[name].split(' ').map((n) => (n === '.' ? '' : n));
    encodingCache.set(name, e);
  }
  return e;
}

let glyphMap: Map<string, string> | undefined;

const EXTRA_GLYPHS: Record<string, string> = {
  ff: 'ﬀ',
  ffi: 'ﬃ',
  ffl: 'ﬄ',
  fi: 'ﬁ',
  fl: 'ﬂ',
  st: 'ﬆ',
  nbspace: ' ',
  sfthyphen: '­',
  nonbreakingspace: ' ',
};

/**
 * Unicode text for a glyph name (§9.10.2 via the Adobe Glyph List conventions): known names,
 * uniXXXX[XXXX...], uXXXX[XX], suffixes (a.sc) and ligature components (f_f_i). '' if unknown.
 */
export function glyphToUnicode(name: string): string {
  if (!glyphMap) {
    glyphMap = new Map();
    for (const entry of GLYPH_LIST.split(' ')) {
      const i = entry.lastIndexOf(':');
      glyphMap.set(entry.slice(0, i), String.fromCodePoint(...entry.slice(i + 1).split('+').map((h) => parseInt(h, 16))));
    }
    for (const [k, v] of Object.entries(EXTRA_GLYPHS)) if (!glyphMap.has(k)) glyphMap.set(k, v);
  }
  const known = glyphMap.get(name);
  if (known !== undefined) return known;
  const dot = name.indexOf('.');
  if (dot > 0) return glyphToUnicode(name.slice(0, dot));
  if (name.includes('_')) return name.split('_').map(glyphToUnicode).join('');
  let m = /^uni((?:[0-9A-F]{4})+)$/.exec(name);
  if (m) {
    const codes: number[] = [];
    for (let i = 0; i < m[1].length; i += 4) codes.push(parseInt(m[1].slice(i, i + 4), 16));
    return String.fromCharCode(...codes);
  }
  m = /^u([0-9A-F]{4,6})$/.exec(name);
  if (m) {
    const cp = parseInt(m[1], 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  }
  return '';
}

let unicodeToGlyphMap: Map<number, string> | undefined;

/** The standard glyph name for a character (for WinAnsi encoding and Differences arrays). */
export function unicodeToGlyph(cp: number): string | undefined {
  if (!unicodeToGlyphMap) {
    unicodeToGlyphMap = new Map();
    // Prefer the names in the standard Latin set.
    for (const n of LATIN_GLYPHS.split(' ')) {
      const u = glyphToUnicode(n);
      if (u.length === 1 && !unicodeToGlyphMap.has(u.charCodeAt(0))) unicodeToGlyphMap.set(u.charCodeAt(0), n);
    }
  }
  return unicodeToGlyphMap.get(cp);
}

// --- the standard 14 fonts ---------------------------------------------------------------------

export interface StandardFont {
  name: string;
  ascent: number;
  descent: number;
  capHeight: number;
  xHeight: number;
  italicAngle: number;
  bbox: [number, number, number, number];
  fixedPitch: boolean;
  /** Advance width (1/1000 em) by glyph name; undefined if the font lacks the glyph. */
  widths: Map<string, number>;
  /** The font's built-in encoding. */
  encoding: EncodingName;
}

const STANDARD_ALIASES: Record<string, string> = {
  Arial: 'Helvetica',
  ArialMT: 'Helvetica',
  'Arial-BoldMT': 'Helvetica-Bold',
  'Arial-ItalicMT': 'Helvetica-Oblique',
  'Arial-BoldItalicMT': 'Helvetica-BoldOblique',
  'Arial,Bold': 'Helvetica-Bold',
  'Arial,Italic': 'Helvetica-Oblique',
  'Arial,BoldItalic': 'Helvetica-BoldOblique',
  'Helvetica-Italic': 'Helvetica-Oblique',
  'Helvetica-BoldItalic': 'Helvetica-BoldOblique',
  TimesNewRoman: 'Times-Roman',
  TimesNewRomanPSMT: 'Times-Roman',
  'TimesNewRoman,Bold': 'Times-Bold',
  'TimesNewRoman,Italic': 'Times-Italic',
  'TimesNewRoman,BoldItalic': 'Times-BoldItalic',
  'TimesNewRomanPS-BoldMT': 'Times-Bold',
  'TimesNewRomanPS-ItalicMT': 'Times-Italic',
  'TimesNewRomanPS-BoldItalicMT': 'Times-BoldItalic',
  Times: 'Times-Roman',
  CourierNew: 'Courier',
  CourierNewPSMT: 'Courier',
  'CourierNew,Bold': 'Courier-Bold',
  'CourierNew,Italic': 'Courier-Oblique',
  'CourierNew,BoldItalic': 'Courier-BoldOblique',
  'CourierNewPS-BoldMT': 'Courier-Bold',
  'CourierNewPS-ItalicMT': 'Courier-Oblique',
  'CourierNewPS-BoldItalicMT': 'Courier-BoldOblique',
  'Courier-Italic': 'Courier-Oblique',
  'Courier-BoldItalic': 'Courier-BoldOblique',
  'Symbol,Bold': 'Symbol',
};

const standardCache = new Map<string, StandardFont>();

/** The 14 standard font names. */
export const STANDARD_FONT_NAMES = Object.keys(STANDARD_FONTS);

/**
 * Metrics for a standard 14 font, or a common alias of one (Arial, TimesNewRoman, ...), so
 * non-embedded fonts still get sensible widths. A subset prefix (ABCDEF+) is ignored.
 */
export function standardFont(name: string): StandardFont | undefined {
  const base = name.replace(/^[A-Z]{6}\+/, '');
  // Own keys only: a font named "constructor" must not find Object.prototype's.
  const alias = (n: string) => (Object.hasOwn(STANDARD_ALIASES, n) ? STANDARD_ALIASES[n] : undefined);
  const canonical = Object.hasOwn(STANDARD_FONTS, base) ? base : (alias(base) ?? alias(base.replace(/-/g, '')));
  if (!canonical) return undefined;
  let f = standardCache.get(canonical);
  if (!f) {
    const d: StandardFontData = STANDARD_FONTS[canonical];
    const widths = new Map<string, number>();
    if (canonical === 'Symbol' || canonical === 'ZapfDingbats') {
      for (const pair of d.widths.split(' ')) {
        const i = pair.lastIndexOf(':');
        widths.set(pair.slice(0, i), Number(pair.slice(i + 1)));
      }
    } else {
      const names = LATIN_GLYPHS.split(' ');
      d.widths.split(' ').forEach((w, i) => {
        if (w !== '0' || names[i] === 'space') widths.set(names[i], Number(w));
      });
    }
    f = {
      name: canonical,
      ascent: d.ascent,
      descent: d.descent,
      capHeight: d.capHeight,
      xHeight: d.xHeight,
      italicAngle: d.italicAngle,
      bbox: d.bbox,
      fixedPitch: d.fixedPitch,
      widths,
      encoding: canonical === 'Symbol' ? 'SymbolEncoding' : canonical === 'ZapfDingbats' ? 'ZapfDingbatsEncoding' : 'StandardEncoding',
    };
    standardCache.set(canonical, f);
  }
  return f;
}
