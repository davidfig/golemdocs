// Fonts as text extraction sees them (§9.5-9.10): how a shown string splits into character
// codes, what Unicode text each code stands for, and each glyph's advance width.

import { PdfDict, PdfName, PdfStream, type PdfObject } from '../core/objects.ts';
import type { PdfDocument } from '../document.ts';
import { CMap } from '../fonts/cmap.ts';
import { TrueTypeFont } from '../fonts/truetype.ts';
import { filterChain } from '../filters/filters.ts';
import { inflate } from '../filters/inflate.ts';
import { encoding, glyphToUnicode, standardFont, type EncodingName, type StandardFont } from '../fonts/encodings.ts';

export interface Glyph {
  code: number;
  /** Unicode text ('' if unknown). */
  text: string;
  /** Horizontal advance in text space units per unit font size (glyph width / 1000 for most fonts). */
  width: number;
  /** A single-byte code 32: word spacing (Tw) applies. */
  wordSpace: boolean;
}

export class TextFont {
  readonly name: string;
  readonly subtype: string;
  readonly composite: boolean;
  readonly vertical: boolean;
  /** Glyph space to text space (Type 3 fonts); [0.001, 0, 0, 0.001, 0, 0] otherwise. */
  readonly fontMatrix: number[] = [0.001, 0, 0, 0.001, 0, 0];

  private toUnicode?: CMap;
  /** /ToUnicode /Identity-H: codes are Unicode (UTF-16) values. */
  private identityUnicode = false;
  /** Composite fonts without ToUnicode: CID to text through the embedded TrueType font's cmap. */
  private cidUnicode?: Map<number, string>;
  private cmap?: CMap;
  // simple fonts
  private names: string[] = [];
  private widths = new Map<number, number>();
  private missingWidth = 0;
  private standard?: StandardFont;
  // composite fonts
  private defaultWidth = 1000;

  constructor(
    readonly doc: PdfDocument,
    readonly dict: PdfDict,
  ) {
    const r = (o: PdfObject | undefined) => doc.resolve(o);
    this.subtype = dict.name('Subtype') ?? 'Type1';
    this.name = (r(dict.get('BaseFont')) as PdfName | undefined)?.name ?? '';
    this.composite = this.subtype === 'Type0';

    const tu = r(dict.get('ToUnicode'));
    if (tu instanceof PdfName && tu.name.startsWith('Identity')) this.identityUnicode = true;
    else if (tu instanceof PdfStream) {
      try {
        let data = doc.streamData(tu);
        // Compressed but missing its /Filter (seen in the wild): inflate it anyway.
        if (data[0] === 0x78 && !filterChain(tu.dict, r).length) data = inflate(data).data;
        const map = CMap.parse(data);
        // A "ToUnicode" with no Unicode mappings (e.g. a copy of Identity-H) is no help.
        if (map.hasUnicode) this.toUnicode = map;
      } catch {
        // an unusable ToUnicode map: fall back to encodings
      }
    }

    if (this.composite) {
      const enc = r(dict.get('Encoding'));
      if (enc instanceof PdfName) this.cmap = CMap.predefined(enc.name);
      else if (enc instanceof PdfStream) {
        try {
          this.cmap = CMap.parse(doc.streamData(enc), (n) => CMap.predefined(n));
        } catch {
          // fall through to Identity
        }
      }
      this.cmap ??= CMap.identityCMap();
      this.vertical = this.cmap.vertical;
      const descendants = doc.array(dict.get('DescendantFonts'));
      const cidFont = doc.dict(descendants?.[0]);
      if (cidFont) {
        this.readCidWidths(cidFont);
        if (!this.toUnicode && !this.identityUnicode && !this.cmap.unicodeCodes) this.cidUnicode = embeddedCidUnicode(doc, cidFont);
      }
    } else {
      this.vertical = false;
      if (this.subtype === 'Type3') {
        const m = doc.array(dict.get('FontMatrix'));
        if (m?.length === 6 && m.every((x) => typeof x === 'number')) this.fontMatrix = m as number[];
      }
      this.readSimple();
    }
  }

  private readCidWidths(cidFont: PdfDict): void {
    const doc = this.doc;
    this.defaultWidth = doc.number(cidFont.get('DW')) ?? 1000;
    const w = doc.array(cidFont.get('W'));
    if (!w) return;
    for (let i = 0; i < w.length; ) {
      const first = doc.number(w[i]);
      const next = doc.resolve(w[i + 1]);
      if (first === undefined) break;
      if (Array.isArray(next)) {
        next.forEach((x, k) => {
          const v = doc.number(x);
          if (v !== undefined) this.widths.set(first + k, v);
        });
        i += 2;
      } else {
        const last = doc.number(next);
        const v = doc.number(w[i + 2]);
        if (last === undefined || v === undefined) break;
        for (let c = first; c <= last && c - first < 0x10000; c++) this.widths.set(c, v);
        i += 3;
      }
    }
  }

  private readSimple(): void {
    const doc = this.doc;
    const d = this.dict;
    this.standard = standardFont(this.name);
    const descriptor = doc.dict(d.get('FontDescriptor'));
    this.missingWidth = doc.number(descriptor?.get('MissingWidth')) ?? 0;
    const flags = doc.number(descriptor?.get('Flags')) ?? 0;
    const symbolic = (flags & 4) !== 0 && (flags & 32) === 0;

    // Base encoding: explicit, else the standard font's built-in one, else by font kind.
    const enc = doc.resolve(d.get('Encoding'));
    let base: EncodingName = this.standard?.encoding ?? (this.subtype === 'TrueType' && !symbolic ? 'WinAnsiEncoding' : 'StandardEncoding');
    const baseName = enc instanceof PdfName ? enc.name : enc instanceof PdfDict ? enc.name('BaseEncoding') : undefined;
    if (baseName === 'WinAnsiEncoding' || baseName === 'MacRomanEncoding' || baseName === 'StandardEncoding') base = baseName;
    this.names = encoding(base).slice();
    if (enc instanceof PdfDict) {
      const diffs = doc.array(enc.get('Differences')) ?? [];
      let code = 0;
      for (const x of diffs) {
        const v = doc.resolve(x);
        if (typeof v === 'number') code = v;
        else if (v instanceof PdfName && code < 256) this.names[code++] = v.name;
      }
    }

    const widths = doc.array(d.get('Widths'));
    const firstChar = doc.number(d.get('FirstChar')) ?? 0;
    if (widths) {
      widths.forEach((x, i) => {
        const v = doc.number(x);
        if (v !== undefined) this.widths.set(firstChar + i, v);
      });
    }
  }

  /** Splits a shown string into glyphs. */
  decode(bytes: Uint8Array): Glyph[] {
    const out: Glyph[] = [];
    const scale = this.fontMatrix[0];
    if (this.composite) {
      const cmap = this.cmap!;
      for (const { code, bytes: n } of cmap.codes(bytes)) {
        const cid = cmap.cid(code, n);
        const text =
          this.toUnicode?.lookupAny(code, n) ??
          (this.identityUnicode ? String.fromCharCode(code) : undefined) ??
          cmap.lookup(code, n) ??
          this.cidUnicode?.get(cid) ??
          '';
        const w = this.widths.get(cid) ?? this.defaultWidth;
        out.push({ code, text: unligate(text), width: w * scale, wordSpace: n === 1 && code === 32 });
      }
      return out;
    }
    for (const code of bytes) {
      const name = this.names[code];
      let text = this.toUnicode?.lookupAny(code, 1);
      if (text === undefined) text = name ? glyphToUnicode(name) : '';
      if (!text && name) text = numericGlyphName(name);
      // Type 3 glyph names are often arbitrary (/square, /g1): the code is the best guess.
      if (!text && this.subtype === 'Type3' && code >= 32 && code !== 127) text = String.fromCharCode(code);
      if (!text && !name && !this.toUnicode) text = code >= 32 ? String.fromCharCode(code) : '';
      let w = this.widths.get(code);
      if (w === undefined) w = (name ? this.standard?.widths.get(name) : undefined) ?? this.missingWidth;
      out.push({ code, text: unligate(text), width: w * scale, wordSpace: code === 32 });
    }
    return out;
  }

  /** Width of a space in text space units per unit font size, for word-gap detection. */
  get spaceWidth(): number {
    const space = this.decode(Uint8Array.of(32))[0];
    return space && space.width > 0 ? space.width : 0.25;
  }
}

/**
 * Glyph names that are just a character code (TeX's Type 3 fonts use /a65, some producers
 * /G41 or /g41 in hex): the character for that code, or ''. As poppler and pdf.js guess.
 */
function numericGlyphName(name: string): string {
  let m = /^[A-Za-z]{1,2}(\d{2,3})$/.exec(name);
  let code = m ? parseInt(m[1], 10) : -1;
  if (!m && (m = /^[Gg]([0-9A-Fa-f]{2})$/.exec(name))) code = parseInt(m[1], 16);
  return code >= 32 && code < 256 && code !== 127 ? String.fromCharCode(code) : '';
}

const LIGATURES: Record<string, string> = { '\ufb00': 'ff', '\ufb01': 'fi', '\ufb02': 'fl', '\ufb03': 'ffi', '\ufb04': 'ffl', '\ufb05': 'st', '\ufb06': 'st' };

/** Glyph text cleaned for extraction: ligature presentation forms as their letters, no control characters. */
function unligate(text: string): string {
  // Control characters (a ToUnicode map pointing at \r, say) never stand for visible text.
  if (/[\0-\x1f\x7f]/.test(text)) text = text.replace(/[\0-\x1f\x7f]/g, '');
  return /[\ufb00-\ufb06]/.test(text) ? text.replace(/[\ufb00-\ufb06]/g, (c) => LIGATURES[c]) : text;
}

/**
 * For a CIDFontType2 with an embedded TrueType program: CID → glyph (through CIDToGIDMap) →
 * Unicode (through the font's own cmap, inverted). How pdf.js recovers text from fonts
 * written without a ToUnicode map.
 */
function embeddedCidUnicode(doc: PdfDocument, cidFont: PdfDict): Map<number, string> | undefined {
  if (cidFont.name('Subtype') !== 'CIDFontType2') return undefined;
  const file = doc.resolve(doc.dict(cidFont.get('FontDescriptor'))?.get('FontFile2'));
  if (!(file instanceof PdfStream)) return undefined;
  let font: TrueTypeFont;
  try {
    font = TrueTypeFont.parse(doc.streamData(file));
  } catch {
    return undefined;
  }
  const gidText = new Map<number, string>();
  for (const [cp, gid] of font.codePoints) {
    // Prefer the lowest code point for a glyph, and skip private-use and symbol-font ranges.
    if ((cp >= 0xe000 && cp <= 0xf8ff) || gidText.has(gid)) continue;
    gidText.set(gid, String.fromCodePoint(cp));
  }
  if (!gidText.size) return undefined;
  const map = doc.resolve(cidFont.get('CIDToGIDMap'));
  if (!(map instanceof PdfStream)) return gidText; // Identity (or absent): CID = GID
  const bytes = doc.streamData(map);
  const out = new Map<number, string>();
  for (let cid = 0; cid * 2 + 1 < bytes.length; cid++) {
    const t = gidText.get((bytes[cid * 2] << 8) | bytes[cid * 2 + 1]);
    if (t) out.set(cid, t);
  }
  return out;
}
