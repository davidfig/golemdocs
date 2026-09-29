// What a renderer needs to pick a substitute face for a PDF font: a family name, style flags,
// and serif/monospace hints, from the font's name and descriptor.

import { PdfDict, PdfName, type PdfObject } from '../core/objects.ts';
import type { PdfDocument } from '../document.ts';

export interface FontStyle {
  /** BaseFont without the subset prefix ("Arial-BoldMT"). */
  name: string;
  /** Family guessed from the name, spaced and without style words ("Arial", "Times New Roman"). */
  family: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
  /** Symbol, ZapfDingbats or a symbolic font: Unicode text is a poor guide to its shapes. */
  symbolic: boolean;
}

const STYLE_WORDS = /(bold|black|heavy|semibold|demibold|light|thin|medium|italic|oblique|regular|condensed|narrow)$/i;

/** "Times New Roman" from "TimesNewRomanPS-BoldItalicMT". */
export function familyName(baseFont: string): string {
  let s = baseFont.replace(/^[A-Z]{6}\+/, '');
  // Style is what follows the first comma or hyphen.
  const cut = s.search(/[,\-]/);
  if (cut > 0) s = s.slice(0, cut);
  s = s.replace(/(PSMT|PS|MT)$/, '');
  // Trailing style words glued on without a separator ("ArialBold").
  for (let i = 0; i < 3 && STYLE_WORDS.test(s) && s.replace(STYLE_WORDS, '').length >= 3; i++) s = s.replace(STYLE_WORDS, '');
  s = s.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2');
  return s.replace(/\s+/g, ' ').trim();
}

export function describeFont(doc: PdfDocument, dict: PdfDict): FontStyle {
  const r = (o: PdfObject | undefined) => doc.resolve(o);
  const base = r(dict.get('BaseFont'));
  const name = (base instanceof PdfName ? base.name : '').replace(/^[A-Z]{6}\+/, '');
  let descriptor = doc.dict(dict.get('FontDescriptor'));
  if (!descriptor && dict.name('Subtype') === 'Type0') {
    const d = doc.dict(doc.array(dict.get('DescendantFonts'))?.[0]);
    descriptor = doc.dict(d?.get('FontDescriptor'));
  }
  const flags = doc.number(descriptor?.get('Flags')) ?? 0;
  const weight = doc.number(descriptor?.get('FontWeight')) ?? 0;
  const angle = doc.number(descriptor?.get('ItalicAngle')) ?? 0;
  const lower = name.toLowerCase();
  const bold = /bold|black|heavy|demi|(^|[-,])bd/.test(lower) || weight >= 600 || (flags & 0x40000) !== 0;
  const italic = /italic|oblique|slanted|[-,]it(alic)?($|[-,])|kursiv/.test(lower) || (flags & 0x40) !== 0 || angle !== 0;
  const mono = (flags & 1) !== 0 || /courier|mono|consolas|typewriter|lucida console|menlo|fixed/.test(lower);
  const sans = /sans|arial|helvet|calibri|verdana|tahoma|segoe|gothic|univers|frutiger|futura|myriad|roboto|open|dejavusans|lato/.test(lower);
  const bareType3 = !name && dict.name('Subtype') === 'Type3'; // TeX bitmap fonts
  const serif = !sans && !mono && (bareType3 || (flags & 2) !== 0 || /times|serif|roman|georgia|garamond|palatino|minion|cambria|century|bookman|book antiqua|charter|lmroman|cmr|nimbusrom/.test(lower));
  const symbolic = /symbol|zapfdingbats|dingbats|wingdings|webdings/.test(lower);
  return { name, family: familyName(name), bold, italic, serif, mono, symbolic };
}

/** Distinct fonts in the /Resources of every page (form XObjects' own resources are not visited). */
export function collectFonts(doc: PdfDocument): FontStyle[] {
  const seen = new Set<string>();
  const out = new Map<string, FontStyle>();
  for (const page of doc.pages) {
    const fonts = doc.dict(doc.dict(page.inherited('Resources'))?.get('Font'));
    if (!fonts) continue;
    for (const [, v] of fonts) {
      const key = typeof v === 'object' && v && 'key' in v ? String((v as { key: string }).key) : '';
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      const d = doc.dict(v);
      if (!d) continue;
      const style = describeFont(doc, d);
      out.set(`${style.family}|${style.bold}|${style.italic}|${style.serif}|${style.mono}`, style);
    }
  }
  return [...out.values()];
}
