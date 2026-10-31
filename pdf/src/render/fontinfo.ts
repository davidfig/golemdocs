// SPDX-License-Identifier: MIT
// What a renderer needs to pick a substitute face for a PDF font: a family name, style flags,
// and serif/monospace hints, from the font's name and descriptor.

import { PdfDict, PdfName, PdfRef, type PdfObject } from '../core/objects.ts';
import { TextFont } from '../text/font.ts';
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

// TeX's own fonts are named by a short code, with the style in it rather than in words: "SFBX1000"
// is cm-super bold, "CMTT10" Computer Modern typewriter. Their descriptors only say "symbolic", so
// the code is all there is to go on. Letters: b bold, i italic, s sans, m monospace.
const EC_CODES: Record<string, string> = {
  rm: '', rb: 'b', bx: 'b', ti: 'i', sl: 'i', ui: 'i', bi: 'bi', bl: 'bi', cc: '', xc: 'b', ci: 'i', dh: '',
  ss: 's', sx: 'bs', si: 'is', so: 'bis', tt: 'm', it: 'im', st: 'im', tc: 'm', vt: 'm', vi: 'im',
};
const CM_CODES: Record<string, string> = {
  r: '', b: 'b', bx: 'b', ti: 'i', sl: 'i', u: 'i', bxti: 'bi', bxsl: 'bi', csc: '', mi: 'i', mib: 'bi', sy: '', bsy: 'b', ex: '',
  ss: 's', ssbx: 'bs', ssdc: 'bs', ssi: 'is', ssq: 's', ssqi: 'is', tt: 'm', itt: 'im', sltt: 'im', tcsc: 'm', vtt: 'm',
};

/** The style a TeX font's name gives ("sfbx1000", "cmtt10", "ecrm1200"), or undefined for any other font. */
export function texStyle(name: string): { bold: boolean; italic: boolean; sans: boolean; mono: boolean } | undefined {
  const m = /^(?:sf|ec|tc)([a-z]{2})\d{3,4}$/.exec(name) ?? /^cm([a-z]+)\d{1,2}$/.exec(name);
  const flags = m ? (name.startsWith('cm') ? CM_CODES : EC_CODES)[m[1]] : undefined;
  if (flags === undefined) return undefined;
  return { bold: flags.includes('b'), italic: flags.includes('i'), sans: flags.includes('s'), mono: flags.includes('m') };
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
  const tex = texStyle(lower);
  const bold = tex?.bold || /bold|black|heavy|demi|(^|[-,])bd/.test(lower) || weight >= 600 || (flags & 0x40000) !== 0;
  const italic = tex?.italic || /italic|oblique|slanted|[-,]it(alic)?($|[-,])|kursiv/.test(lower) || (flags & 0x40) !== 0 || angle !== 0;
  const mono = tex?.mono || (flags & 1) !== 0 || /courier|mono|consolas|typewriter|lucida console|menlo|fixed/.test(lower);
  const sans = tex?.sans || /sans|arial|helvet|calibri|verdana|tahoma|segoe|gothic|univers|frutiger|futura|myriad|roboto|open|dejavusans|lato/.test(lower);
  const bareType3 = !name && dict.name('Subtype') === 'Type3'; // TeX bitmap fonts
  const serif = !sans && !mono && (!!tex || bareType3 || (flags & 2) !== 0 || /times|serif|roman|georgia|garamond|palatino|minion|cambria|century|bookman|book antiqua|charter|lmroman|cmr|nimbusrom/.test(lower));
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

/**
 * The characters each font of the pages can show (from their encodings and /ToUnicode maps), by
 * font name: what a renderer drawing with its own faces has to have glyphs for.
 */
export function collectCharacters(doc: PdfDocument): { name: string; codePoints: Set<number> }[] {
  const out: { name: string; codePoints: Set<number> }[] = [];
  const seen = new Set<unknown>();
  for (const page of doc.pages) {
    const fonts = doc.dict(doc.dict(page.inherited('Resources'))?.get('Font'));
    if (!fonts) continue;
    for (const [, v] of fonts) {
      const key = v instanceof PdfRef ? v.key : v;
      if (seen.has(key)) continue;
      seen.add(key);
      const d = doc.dict(v);
      if (!d) continue;
      try {
        const font = new TextFont(doc, d);
        const codePoints = new Set<number>();
        for (const ch of font.characters.keys()) codePoints.add(ch.codePointAt(0)!);
        out.push({ name: describeFont(doc, d).name, codePoints });
      } catch {
        // an unreadable font shows nothing
      }
    }
  }
  return out;
}
