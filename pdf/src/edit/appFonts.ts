// SPDX-License-Identifier: MIT
// Fonts chosen by name for text an edit sets or adds: one of the standard 14, or a font the app has (Arial, Calibri...) written
// into the file from its font file. The caller supplies the bytes of a font file (`ApplyOptions.fontFile`, a plain lookup, so the
// caller loads what edits need beforehand); without them the nearest standard font is used, as text always can be shown.
//
// An embedded font is made once per document and style, however often edits are applied: it only gains glyphs, and is written
// (subset to those used) when the document is saved. After each application its widths and text map are brought up to date so
// the page can be read back (and shown), and fonts already read from the document are forgotten, as they have fewer glyphs.

import { PdfDict } from '../core/objects.ts';
import type { PdfDocument } from '../document.ts';
import type { PdfPage } from '../page.ts';
import { describeFont } from '../render/fontinfo.ts';
import { forgetDisplayFonts } from '../render/interpret.ts';
import { TextFont } from '../text/font.ts';
import type { EmbeddedFont } from '../write/fonts.ts';
import { STANDARD as STANDARD_FONTS, standardUse, type Kind } from './fallback.ts';
import { forgetFonts, type FontUse } from './scan.ts';

/** The bytes of a font file (TrueType) for a family name and style, if there is one to hand. */
export type FontFiles = (family: string, bold: boolean, italic: boolean) => Uint8Array | undefined;

export interface ApplyOptions {
  /** Font files for fonts named in edits that aren't standard ones. */
  fontFile?: FontFiles;
}

export interface ChosenFont {
  use: FontUse;
}

const embedded = new WeakMap<PdfDocument, Map<string, EmbeddedFont>>();

const STANDARD = /^(Helvetica|Arial|Times|Courier|Symbol|ZapfDingbats)([-,].*)?$/i;

/** Whether a name is one of the PDF standard fonts (with a style, like "Times-BoldItalic"): those need no file. */
export const isStandardName = (name: string): boolean => /^(Helvetica|Times|Courier|Symbol|ZapfDingbats)(-|$)/.test(name) && STANDARD.test(name);

/** The standard font that passes best for a family, in a style. */
export function nearestStandard(family: string, bold: boolean, italic: boolean): string {
  const lower = family.toLowerCase();
  const kind: Kind = /courier|mono|consolas|typewriter/.test(lower) ? 'mono' : /times|georgia|cambria|serif|garamond|palatino|minion|caladea|gelasio|roman/.test(lower) && !/sans/.test(lower) ? 'serif' : 'sans';
  return STANDARD_FONTS[kind][(bold ? 1 : 0) + (italic ? 2 : 0)];
}

/** A font for a name and style, in the page's resources. */
export function chooseFont(doc: PdfDocument, page: PdfPage, name: string, bold: boolean, italic: boolean, options: ApplyOptions, substituted?: Set<string>): ChosenFont {
  if (isStandardName(name)) return { use: standardUse(doc, page, name).use };
  const bytes = options.fontFile?.(name, bold, italic);
  if (!bytes) {
    substituted?.add(name);
    return { use: standardUse(doc, page, nearestStandard(name, bold, italic)).use };
  }
  let fonts = embedded.get(doc);
  if (!fonts) embedded.set(doc, (fonts = new Map()));
  const key = `${name}|${bold ? 1 : 0}${italic ? 1 : 0}`;
  let font = fonts.get(key);
  if (!font) fonts.set(key, (font = doc.embedFont(bytes)));
  const dict = doc.dict(font.ref) as PdfDict;
  const resource = page.addResource('Font', font.ref, 'F');
  return { use: { resource, textFont: new TextFont(doc, dict), style: describeFont(doc, dict), embedded: font } };
}

/** Brings every embedded font's widths and text map up to date; forgets what was read of the fonts if any grew. */
export function syncFonts(doc: PdfDocument): void {
  let grew = false;
  for (const font of embedded.get(doc)?.values() ?? []) if (font.sync()) grew = true;
  if (grew) {
    forgetFonts(doc);
    forgetDisplayFonts(doc);
  }
}
