// Fonts for writing: the standard 14 (not embedded, WinAnsi encoded) and embedded
// TrueType/OpenType fonts (Type 0 with Identity-H, subset on save, with a ToUnicode map so
// text stays searchable and copyable).

import { N, PdfDict, PdfRef, PdfStream, PdfString } from '../core/objects.ts';
import type { PdfDocument } from '../document.ts';
import { encoding, glyphToUnicode, standardFont, type StandardFont } from '../fonts/encodings.ts';
import { TrueTypeFont } from '../fonts/truetype.ts';

export interface PdfFont {
  /** The font dictionary. */
  readonly ref: PdfRef;
  /** PostScript name. */
  readonly name: string;
  /** Bytes per character code in shown strings (1 for standard fonts, 2 for embedded). */
  readonly codeBytes: 1 | 2;
  /** Ascent and descent in 1/1000 em (descent negative). */
  readonly ascent: number;
  readonly descent: number;
  /** Encodes text for Tj/TJ; characters the font lacks become .notdef (or '?'). */
  encode(text: string): Uint8Array;
  /** Advance width of text in points at the given size. */
  widthOf(text: string, size: number): number;
  hasChar(codePoint: number): boolean;
  /** Encodes glyph indices directly, for text from a layout engine that already chose glyphs (embedded fonts only). */
  encodeGlyphs?(gids: number[], texts?: (string | undefined)[]): Uint8Array;
  /** Advance of a glyph in 1/1000 em (embedded fonts only). */
  glyphWidth?(gid: number): number;
}

// --- standard 14 -------------------------------------------------------------------------------

let winAnsiReverse: Map<number, number> | undefined;

function winAnsiCode(cp: number): number | undefined {
  if (!winAnsiReverse) {
    winAnsiReverse = new Map();
    encoding('WinAnsiEncoding').forEach((name, code) => {
      const u = name ? glyphToUnicode(name) : '';
      if (u.length === 1 && !winAnsiReverse!.has(u.charCodeAt(0))) winAnsiReverse!.set(u.charCodeAt(0), code);
    });
    winAnsiReverse.set(0xa0, 0xa0);
    winAnsiReverse.set(0xad, 0xad);
  }
  return winAnsiReverse.get(cp);
}

/** One of the standard 14 fonts, WinAnsi encoded (Latin-1 plus the cp1252 extras). */
export class StandardFontResource implements PdfFont {
  readonly ref: PdfRef;
  readonly codeBytes = 1;
  readonly name: string;
  private readonly metrics: StandardFont;
  private readonly symbolic: boolean;
  private readonly names: string[];

  constructor(doc: PdfDocument, name: string) {
    const m = standardFont(name);
    if (!m) throw new Error(`not a standard font: ${name}`);
    this.metrics = m;
    this.name = m.name;
    this.symbolic = m.name === 'Symbol' || m.name === 'ZapfDingbats';
    const dict = new PdfDict({ Type: N('Font'), Subtype: N('Type1'), BaseFont: N(m.name) });
    if (!this.symbolic) dict.set('Encoding', N('WinAnsiEncoding'));
    this.names = encoding(this.symbolic ? m.encoding : 'WinAnsiEncoding');
    this.ref = doc.add(dict);
  }

  get ascent(): number {
    return this.metrics.ascent;
  }
  get descent(): number {
    return this.metrics.descent;
  }

  private code(cp: number): number | undefined {
    if (!this.symbolic) return winAnsiCode(cp);
    const i = this.names.findIndex((n) => n && glyphToUnicode(n) === String.fromCodePoint(cp));
    return i >= 0 ? i : undefined;
  }

  encode(text: string): Uint8Array {
    const out: number[] = [];
    for (const ch of text) out.push(this.code(ch.codePointAt(0)!) ?? 0x3f);
    return Uint8Array.from(out);
  }

  widthOf(text: string, size: number): number {
    let w = 0;
    for (const b of this.encode(text)) w += this.metrics.widths.get(this.names[b]) ?? 0;
    return (w * size) / 1000;
  }

  hasChar(cp: number): boolean {
    return this.code(cp) !== undefined;
  }
}

// --- embedded TrueType / OpenType -----------------------------------------------------------

/**
 * An embedded font. CIDs are assigned in order of first use; on save the font program is
 * subset to exactly those glyphs (renumbered to match), so CID = subset glyph index.
 * OpenType fonts with CFF outlines are embedded whole, with CID = glyph index.
 */
export class EmbeddedFont implements PdfFont {
  readonly ref: PdfRef;
  readonly codeBytes = 2;
  readonly name: string;
  readonly font: TrueTypeFont;
  /** Original glyph index to CID, in first-use order. */
  private readonly cids = new Map<number, number>([[0, 0]]);
  /** CID to the text it represents (for ToUnicode). */
  private readonly texts = new Map<number, string>();
  private readonly cidFont: PdfDict;
  private readonly descriptor: PdfDict;
  private readonly tag: string;
  private written = -1;
  private programRef?: PdfRef;
  private toUnicodeRef?: PdfRef;

  constructor(
    readonly doc: PdfDocument,
    bytes: Uint8Array,
  ) {
    this.font = TrueTypeFont.parse(bytes);
    const f = this.font;
    if (f.embeddingFlags & 0x0002) throw new Error(`${f.postscriptName}: the font's license forbids embedding`);
    this.name = f.postscriptName || 'Font';
    // A subset tag derived from the font name (and a counter, so two subsets of one font differ).
    this.tag = f.isCff ? '' : subsetTag(`${this.name}#${embedCount++}`);
    const s = f.scale;
    const flags = 4 | (f.fixedPitch ? 1 : 0) | (f.italicAngle ? 64 : 0);
    this.descriptor = new PdfDict({
      Type: N('FontDescriptor'),
      FontName: N(this.tag + this.name),
      Flags: flags,
      FontBBox: f.bbox.map((v) => Math.round(v * s)),
      ItalicAngle: f.italicAngle,
      Ascent: Math.round(f.ascent * s),
      Descent: Math.round(f.descent * s),
      CapHeight: Math.round(f.capHeight * s),
      StemV: f.weight >= 600 ? 120 : 80,
    });
    if (f.xHeight) this.descriptor.set('XHeight', Math.round(f.xHeight * s));
    if (f.familyName) this.descriptor.set('FontFamily', PdfString.text(f.familyName));
    this.cidFont = new PdfDict({
      Type: N('Font'),
      Subtype: N(f.isCff ? 'CIDFontType0' : 'CIDFontType2'),
      BaseFont: N(this.tag + this.name),
      CIDSystemInfo: new PdfDict({ Registry: PdfString.text('Adobe'), Ordering: PdfString.text('Identity'), Supplement: 0 }),
      FontDescriptor: doc.add(this.descriptor),
      DW: 1000,
    });
    if (!f.isCff) this.cidFont.set('CIDToGIDMap', N('Identity'));
    this.ref = doc.add(
      new PdfDict({
        Type: N('Font'),
        Subtype: N('Type0'),
        BaseFont: N(this.tag + this.name),
        Encoding: N('Identity-H'),
        DescendantFonts: [doc.add(this.cidFont)],
      }),
    );
    doc.onBeforeSave(() => this.write());
  }

  get ascent(): number {
    return Math.round(this.font.ascent * this.font.scale);
  }
  get descent(): number {
    return Math.round(this.font.descent * this.font.scale);
  }

  hasChar(cp: number): boolean {
    return this.font.glyphForCodePoint(cp) !== 0;
  }

  /** The CID for a glyph, registering it (and the text it stands for) on first use. */
  cidForGlyph(gid: number, text?: string): number {
    let cid = this.cids.get(gid);
    if (cid === undefined) {
      cid = this.font.isCff ? gid : this.cids.size;
      this.cids.set(gid, cid);
    }
    if (text && !this.texts.has(cid)) this.texts.set(cid, text);
    return cid;
  }

  encode(text: string): Uint8Array {
    const out: number[] = [];
    for (const ch of text) {
      const cid = this.cidForGlyph(this.font.glyphForCodePoint(ch.codePointAt(0)!), ch);
      out.push(cid >> 8, cid & 0xff);
    }
    return Uint8Array.from(out);
  }

  /** Encodes glyph indices directly (text from a layout engine that already chose glyphs). */
  encodeGlyphs(gids: number[], texts?: (string | undefined)[]): Uint8Array {
    const out = new Uint8Array(gids.length * 2);
    gids.forEach((g, i) => {
      const cid = this.cidForGlyph(g, texts?.[i]);
      out[i * 2] = cid >> 8;
      out[i * 2 + 1] = cid & 0xff;
    });
    return out;
  }

  widthOf(text: string, size: number): number {
    let w = 0;
    for (const ch of text) w += this.glyphWidth(this.font.glyphForCodePoint(ch.codePointAt(0)!));
    return (w * size) / 1000;
  }

  /**
   * Glyph advance in 1/1000 em, exactly as written to /W (to 1/100 unit), so positions
   * computed here match what viewers compute.
   */
  glyphWidth(gid: number): number {
    return Math.round(this.font.advance(gid) * this.font.scale * 100) / 100;
  }

  /** Puts an object in place: rewritten where it already is (saving again after more text was added reuses the same objects). */
  private put(ref: PdfRef | undefined, stream: PdfStream): PdfRef {
    if (!ref) return this.doc.add(stream);
    this.doc.set(ref, stream);
    return ref;
  }

  private metricsFor = -1;

  /**
   * Writes the widths and the ToUnicode map for the glyphs used so far, without the font program: enough for the text to
   * be read back from the document (a page view of it), and cheap. Saving writes the program too.
   */
  sync(): boolean {
    if (this.metricsFor === this.cids.size) return false;
    this.metricsFor = this.cids.size;
    const doc = this.doc;
    // Widths: runs of consecutive CIDs as [first [w1 w2 ...]].
    const byCid = [...this.cids].map(([gid, cid]) => [cid, this.glyphWidth(gid)] as const).sort((a, b) => a[0] - b[0]);
    const w: (number | number[])[] = [];
    for (let i = 0; i < byCid.length; ) {
      let j = i;
      while (j + 1 < byCid.length && byCid[j + 1][0] === byCid[j][0] + 1) j++;
      w.push(byCid[i][0], byCid.slice(i, j + 1).map(([, width]) => width));
      i = j + 1;
    }
    this.cidFont.set('W', w);
    const fontDict = doc.dict(this.ref)!;
    this.toUnicodeRef = this.put(this.toUnicodeRef, new PdfStream(new PdfDict(), toUnicodeCMap(this.texts)));
    fontDict.set('ToUnicode', this.toUnicodeRef);
    return true;
  }

  /** Writes (or rewrites) the font program, widths and ToUnicode map for the glyphs used so far. */
  private write(): void {
    if (this.written === this.cids.size) return;
    this.written = this.cids.size;
    const f = this.font;
    const doc = this.doc;
    if (f.isCff) {
      // The whole font once; it never changes.
      this.programRef ??= doc.add(new PdfStream(new PdfDict({ Subtype: N('OpenType') }), f.bytes));
      this.descriptor.set('FontFile3', this.programRef);
    } else {
      const { data } = f.subset(this.cids.keys());
      this.programRef = this.put(this.programRef, new PdfStream(new PdfDict({ Length1: data.length }), data));
      this.descriptor.set('FontFile2', this.programRef);
    }
    this.sync();
  }
}

let embedCount = 0;

function subsetTag(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let tag = '';
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + ((h >>> 0) % 26));
    h = Math.imul(h, 16777619) ^ i;
  }
  return tag + '+';
}

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

/** A ToUnicode CMap for 2-byte CIDs. */
export function toUnicodeCMap(texts: Map<number, string>): Uint8Array {
  const entries = [...texts].sort((a, b) => a[0] - b[0]);
  let s =
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    s += `${chunk.length} beginbfchar\n`;
    for (const [cid, text] of chunk) {
      let dst = '';
      for (let k = 0; k < text.length; k++) dst += hex4(text.charCodeAt(k));
      s += `<${hex4(cid)}> <${dst}>\n`;
    }
    s += 'endbfchar\n';
  }
  s += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
