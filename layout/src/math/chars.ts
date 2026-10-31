// SPDX-License-Identifier: MIT
// Characters in math: which glyph a letter in a given style is drawn with (the Mathematical
// Alphanumeric Symbols block holds italic, bold, script and the other alphabets as separate code
// points), and which TeX atom class a character belongs to, which decides the space around it.

import type { MathStyle } from '@golemdocs/docx';

export { classOf, type AtomClass } from '@golemdocs/docx';
interface Alphabet {
  upper: number;
  lower: number;
  digit?: number;
  /** Letters that live elsewhere (the block leaves holes where Letterlike Symbols already had the character). */
  holes?: Record<number, number>;
}

const ALPHABETS: Partial<Record<MathStyle, Alphabet>> = {
  italic: { upper: 0x1d434, lower: 0x1d44e, holes: { 0x68: 0x210e } },
  bold: { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce },
  boldItalic: { upper: 0x1d468, lower: 0x1d482 },
  script: {
    upper: 0x1d49c,
    lower: 0x1d4b6,
    holes: { 0x42: 0x212c, 0x45: 0x2130, 0x46: 0x2131, 0x48: 0x210b, 0x49: 0x2110, 0x4c: 0x2112, 0x4d: 0x2133, 0x52: 0x211b, 0x65: 0x212f, 0x67: 0x210a, 0x6f: 0x2134 },
  },
  fraktur: { upper: 0x1d504, lower: 0x1d51e, holes: { 0x43: 0x212d, 0x48: 0x210c, 0x49: 0x2111, 0x52: 0x211c, 0x5a: 0x2128 } },
  doubleStruck: { upper: 0x1d538, lower: 0x1d552, digit: 0x1d7d8, holes: { 0x43: 0x2102, 0x48: 0x210d, 0x4e: 0x2115, 0x50: 0x2119, 0x51: 0x211a, 0x52: 0x211d, 0x5a: 0x2124 } },
  sansSerif: { upper: 0x1d5a0, lower: 0x1d5ba, digit: 0x1d7e2 },
  monospace: { upper: 0x1d670, lower: 0x1d68a, digit: 0x1d7f6 },
};

/** Greek capitals, small letters, by style. Others keep the plain Greek letters. */
const GREEK: Partial<Record<MathStyle, { upper: number; lower: number }>> = {
  italic: { upper: 0x1d6e2, lower: 0x1d6fc },
  bold: { upper: 0x1d6a8, lower: 0x1d6c2 },
  boldItalic: { upper: 0x1d71c, lower: 0x1d736 },
};

/** Greek symbol variants (ϑ ϕ ϖ ϱ ϵ ϰ) as italic. */
const GREEK_VARIANTS: Record<number, number> = { 0x3f5: 0x1d716, 0x3d1: 0x1d717, 0x3f0: 0x1d718, 0x3d5: 0x1d719, 0x3f1: 0x1d71a, 0x3d6: 0x1d71b };

/**
 * The code point to draw for a character. With no style, Latin letters and small Greek letters are
 * italic and everything else (digits, operators, capital Greek) is upright, as in TeX.
 */
export function mathChar(cp: number, style: MathStyle | undefined): number {
  const isUpper = cp >= 0x41 && cp <= 0x5a;
  const isLower = cp >= 0x61 && cp <= 0x7a;
  const isDigit = cp >= 0x30 && cp <= 0x39;
  const greekLower = cp >= 0x3b1 && cp <= 0x3c9;
  const greekUpper = cp >= 0x391 && cp <= 0x3a9 && cp !== 0x3a2;

  if (style === undefined) {
    if (isUpper || isLower) style = 'italic';
    else if (greekLower) return GREEK.italic!.lower + cp - 0x3b1;
    else if (GREEK_VARIANTS[cp]) return GREEK_VARIANTS[cp];
    else return cp;
  }
  if (style === 'normal') return cp;

  if (isUpper || isLower || isDigit) {
    const alphabet = ALPHABETS[style];
    if (!alphabet) return cp;
    if (alphabet.holes?.[cp]) return alphabet.holes[cp];
    if (isUpper) return alphabet.upper + cp - 0x41;
    if (isLower) return alphabet.lower + cp - 0x61;
    return alphabet.digit === undefined ? cp : alphabet.digit + cp - 0x30;
  }
  const greek = GREEK[style];
  if (greek) {
    if (greekLower) return greek.lower + cp - 0x3b1;
    if (greekUpper) return greek.upper + cp - 0x391;
    // The bold variants come 0x3a before the italic ones, the bold italic 0x3a after.
    if (GREEK_VARIANTS[cp]) return GREEK_VARIANTS[cp] + (style === 'bold' ? -0x3a : style === 'boldItalic' ? 0x3a : 0);
  }
  return cp;
}

/** Widths of the space characters math text uses, in ems (their glyphs may be missing from the atlas). */
export const SPACE_WIDTH: Record<number, number> = {
  0x20: 0.25,
  0xa0: 0.25,
  0x2003: 1,
  0x2002: 0.5,
  0x2004: 5 / 18,
  0x2005: 4 / 18,
  0x2009: 3 / 18,
  0x200a: 1 / 18,
};
