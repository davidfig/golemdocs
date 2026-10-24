// The font program a PDF font dictionary embeds (§9.9), read for its glyph outlines so a renderer
// can draw the document's own letterforms rather than a stand-in: Type 1 (/FontFile), TrueType
// (/FontFile2) and CFF (/FontFile3: Type1C, CIDFontType0C, OpenType), for simple fonts and for
// composite (Type 0) ones. Type 3 fonts draw with content streams and aren't handled here.
// Imported as `@golemdocs/pdf/fontProgram`, not from the package index: only a PDF opened to view
// needs it, and everything the index exports is bundled with the layout worker.

import { PdfDict, PdfName, PdfStream } from '../core/objects.ts';
import type { PdfDocument } from '../document.ts';
import { CffFont } from './cff.ts';
import { encoding, glyphToUnicode } from './encodings.ts';
import { outlineFromPath, transformOutline, type Outline } from './outline.ts';

export { outlineBounds, type Contour, type Outline, type Segment } from './outline.ts';
import { TrueTypeFont } from './truetype.ts';
import { Type1Font } from './type1.ts';

type Program = { kind: 'type1'; font: Type1Font } | { kind: 'cff'; font: CffFont } | { kind: 'truetype'; font: TrueTypeFont };

export class FontProgram {
  private readonly cache = new Map<number, Outline | null>();

  /** Use `load`. */
  constructor(
    private readonly program: Program,
    /** Simple fonts: code to glyph (a name for Type 1, a glyph id otherwise). Composite fonts: CID to glyph id. */
    private readonly glyphOf: (code: number) => string | number | undefined,
  ) {}

  /**
   * The program of a font dictionary (the one `TextFont` reads), or null if it embeds none this
   * can read. Never throws: a damaged program is the same as none.
   */
  static load(doc: PdfDocument, dict: PdfDict): FontProgram | null {
    try {
      const subtype = dict.name('Subtype');
      if (subtype === 'Type0') {
        const cidFont = doc.dict(doc.array(dict.get('DescendantFonts'))?.[0]);
        return cidFont ? composite(doc, cidFont) : null;
      }
      if (subtype === 'Type3') return null;
      return simple(doc, dict);
    } catch {
      return null;
    }
  }

  /**
   * The outline of the glyph a code (simple fonts) or CID (composite fonts) selects, in text space
   * (ems: multiply by the font size), y up. Null if the program has no such glyph; empty for a blank one.
   */
  outline(code: number): Outline | null {
    let out = this.cache.get(code);
    if (out === undefined) {
      try {
        out = this.read(code);
      } catch {
        out = null;
      }
      this.cache.set(code, out);
    }
    return out;
  }

  private read(code: number): Outline | null {
    const glyph = this.glyphOf(code);
    if (glyph === undefined) return null;
    const p = this.program;
    if (p.kind === 'type1') {
      const o = p.font.outline(glyph as string);
      return o && transformOutline(o, p.font.fontMatrix);
    }
    if (p.kind === 'cff') {
      const o = p.font.outline(glyph as number);
      return o && transformOutline(o, p.font.fontMatrix);
    }
    const gid = glyph as number;
    if (gid <= 0 || gid >= p.font.numGlyphs) return null;
    const s = 1 / p.font.unitsPerEm;
    return transformOutline(outlineFromPath(p.font.glyphPath(gid)), [s, 0, 0, s, 0, 0]);
  }
}

/** The font program a descriptor embeds. */
function program(doc: PdfDocument, descriptor: PdfDict | undefined): Program | null {
  if (!descriptor) return null;
  const file1 = doc.resolve(descriptor.get('FontFile'));
  if (file1 instanceof PdfStream) return { kind: 'type1', font: Type1Font.parse(doc.streamData(file1), doc.number(file1.dict.get('Length1'))) };
  const file2 = doc.resolve(descriptor.get('FontFile2'));
  if (file2 instanceof PdfStream) return sfnt(doc.streamData(file2));
  const file3 = doc.resolve(descriptor.get('FontFile3'));
  if (file3 instanceof PdfStream) {
    const data = doc.streamData(file3);
    // An OpenType wrapper, whatever the subtype says.
    if (file3.dict.name('Subtype') === 'OpenType' || isSfnt(data)) return sfnt(data);
    return { kind: 'cff', font: CffFont.parse(data) };
  }
  return null;
}

function isSfnt(data: Uint8Array): boolean {
  const tag = String.fromCharCode(data[0], data[1], data[2], data[3]);
  return tag === '\0\x01\0\0' || tag === 'true' || tag === 'OTTO';
}

/** A TrueType or OpenType font: its glyf outlines, or its CFF table's. */
function sfnt(data: Uint8Array): Program {
  const font = TrueTypeFont.parse(data);
  if (!font.isCff) return { kind: 'truetype', font };
  const table = font.table('CFF ');
  if (!table) throw new Error('OpenType font without a CFF table');
  return { kind: 'cff', font: CffFont.parse(data.subarray(table.offset, table.offset + table.length)) };
}

function simple(doc: PdfDocument, dict: PdfDict): FontProgram | null {
  const descriptor = doc.dict(dict.get('FontDescriptor'));
  const p = program(doc, descriptor);
  if (!p) return null;
  const flags = doc.number(descriptor?.get('Flags')) ?? 0;
  const symbolic = (flags & 4) !== 0 && (flags & 32) === 0;

  // Glyph names by code: the /Encoding's base (else none: the font's own encoding stands), then its /Differences.
  const enc = doc.resolve(dict.get('Encoding'));
  const baseName = enc instanceof PdfName ? enc.name : enc instanceof PdfDict ? enc.name('BaseEncoding') : undefined;
  const names: (string | undefined)[] =
    baseName === 'WinAnsiEncoding' || baseName === 'MacRomanEncoding' || baseName === 'StandardEncoding' ? encoding(baseName).map((n) => n || undefined) : [];
  if (!baseName && p.kind === 'truetype' && !symbolic) encoding('StandardEncoding').forEach((n, code) => (names[code] = n || undefined));
  if (enc instanceof PdfDict) {
    let code = 0;
    for (const x of doc.array(enc.get('Differences')) ?? []) {
      const v = doc.resolve(x);
      if (typeof v === 'number') code = v;
      else if (v instanceof PdfName && code < 256) names[code++] = v.name;
    }
  }

  if (p.kind === 'type1') {
    const font = p.font;
    return new FontProgram(p, (code) => {
      const name = names[code];
      if (name && font.has(name)) return name;
      const own = font.encoding[code];
      return own && font.has(own) ? own : undefined;
    });
  }
  if (p.kind === 'cff') {
    const font = p.font;
    return new FontProgram(p, (code) => {
      const name = names[code];
      const byName = name ? font.glyphByName(name) : -1;
      if (byName > 0) return byName;
      const own = font.encoding.get(code);
      if (own !== undefined) return own;
      // A CID-keyed program in a simple font: codes are glyph ids.
      return font.cid ? font.glyphByCid(code) : undefined;
    });
  }
  const font = p.font;
  return new FontProgram(p, (code) => {
    // A symbolic font's (3,0) cmap puts its codes at U+F000; a (1,0) cmap maps codes as they are.
    const name = names[code];
    const text = name && !symbolic ? glyphToUnicode(name) : '';
    const gid = (text ? font.glyphForCodePoint(text.codePointAt(0)!) : 0) || font.glyphForCodePoint(0xf000 + code) || font.glyphForCodePoint(code);
    return gid || undefined;
  });
}

function composite(doc: PdfDocument, cidFont: PdfDict): FontProgram | null {
  const p = program(doc, doc.dict(cidFont.get('FontDescriptor')));
  if (!p || p.kind === 'type1') return null;
  if (p.kind === 'cff') {
    const font = p.font;
    return new FontProgram(p, (cid) => {
      const gid = font.glyphByCid(cid);
      return gid > 0 ? gid : undefined;
    });
  }
  const map = doc.resolve(cidFont.get('CIDToGIDMap'));
  const bytes = map instanceof PdfStream ? doc.streamData(map) : null;
  return new FontProgram(p, (cid) => {
    if (!bytes) return cid; // Identity (or absent): CID = GID
    return cid * 2 + 1 < bytes.length ? (bytes[cid * 2] << 8) | bytes[cid * 2 + 1] : undefined;
  });
}
