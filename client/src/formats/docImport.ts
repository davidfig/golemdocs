// Word 97-2003 (.doc) -> document model. A .doc is a compound file (cfb.ts) whose "WordDocument"
// stream holds the text and formatting runs and whose "0Table"/"1Table" stream holds the tables
// that describe them (MS-DOC): the FIB header locates everything; the piece table (CLX) says where
// each stretch of text lives; formatting is stored as property lists ("sprms") in 512-byte pages
// (FKPs) keyed by file position, and in the stylesheet; list definitions, fonts and sections have
// their own tables.
//
// Read: text, character formatting (bold, italic, underline, strike, caps, super/subscript, size,
// font, colour, highlight), paragraph formatting (alignment, indents, spacing, keep options, page
// break before), styles (with their formatting), lists (bullets and numbering with levels), tables
// (cell widths, header rows), hyperlinks, page breaks, inline PNG/JPEG pictures, and the first
// section's page size and margins, and comments (text, author, initials, date, and the range they
// mark; a comment whose range can't be found is a point at its reference mark). Not read: headers
// and footers, footnotes, replies and resolved state (.doc has none), text boxes
// and floating shapes, tracked changes, fields other than links (their results are kept).
// Files from Word 6/95 (a different format) and encrypted files are refused.

import { WordDocument } from '@golemdocs/docx';
import { commentEnd, commentReference, commentStart, insertInlines } from '@golemdocs/docx';
import type {
  Block,
  Inline,
  NumberingLevel,
  Paragraph,
  ParagraphProperties,
  Run,
  RunContent,
  RunProperties,
  Style,
  Table,
  TableCell,
  TableRow,
} from '@golemdocs/docx';
import { t } from '../i18n/index.ts';
import { Cfb, CfbError, isCfb } from './cfb.ts';
import { dttmToIso } from './commentRanges.ts';

// --- Reading binary data ---------------------------------------------------------------------------

class Reader {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(at: number): number {
    return at >= 0 && at < this.bytes.length ? this.bytes[at] : 0;
  }
  u16(at: number): number {
    return at >= 0 && at + 2 <= this.bytes.length ? this.view.getUint16(at, true) : 0;
  }
  i16(at: number): number {
    return at >= 0 && at + 2 <= this.bytes.length ? this.view.getInt16(at, true) : 0;
  }
  u32(at: number): number {
    return at >= 0 && at + 4 <= this.bytes.length ? this.view.getUint32(at, true) : 0;
  }
  slice(at: number, length: number): Uint8Array {
    return this.bytes.subarray(Math.max(at, 0), Math.max(Math.min(at + length, this.bytes.length), 0));
  }
  utf16(at: number, chars: number): string {
    let out = '';
    for (let i = 0; i < chars; i++) out += String.fromCharCode(this.u16(at + i * 2));
    return out;
  }
}

// --- The FIB -----------------------------------------------------------------------------------------

interface Fib {
  ccpText: number;
  /** Where the annotation (comment) subdocument starts and how long it is, in characters. */
  atnStart: number;
  ccpAtn: number;
  /** File position and length in the table stream, by the index of FibRgFcLcb97. */
  fcLcb(index: number): { fc: number; lcb: number };
}

const FC_STSHF = 1;
const FC_PLCF_SED = 6;
const FC_BTE_CHPX = 12;
const FC_BTE_PAPX = 13;
const FC_STTBF_FFN = 15;
const FC_PLCF_AND_REF = 4;
const FC_PLCF_AND_TXT = 5;
const FC_GRP_XST_ATN_OWNERS = 36;
const FC_PLCF_ATN_BKF = 42;
const FC_PLCF_ATN_BKL = 43;
// FibRgFcLcb2002's fcAtrdExtra: the ATRDPost10 records (with the comments' dates).
const FC_ATRD_EXTRA = 112;
const FC_CLX = 33;
const FC_PLCF_LST = 73;
const FC_PLF_LFO = 74;

function readFib(word: Reader): Fib {
  if (word.u16(0) !== 0xa5ec) throw new Error(t('app.notDoc'));
  const nFib = word.u16(2);
  if (nFib < 0xc1) throw new Error(t('app.docTooOld'));
  const flags = word.u16(10);
  if (flags & 0x0100) throw new Error(t('app.docEncrypted'));
  const csw = word.u16(32);
  const cslwAt = 34 + csw * 2;
  const cslw = word.u16(cslwAt);
  const lwAt = cslwAt + 2;
  const ccpText = word.u32(lwAt + 3 * 4);
  // The subdocuments follow the main text in order: footnotes, headers, (reserved), comments.
  const atnStart = ccpText + word.u32(lwAt + 4 * 4) + word.u32(lwAt + 5 * 4) + word.u32(lwAt + 6 * 4);
  const ccpAtn = word.u32(lwAt + 7 * 4);
  const cbRgFcLcbAt = lwAt + cslw * 4;
  const cbRgFcLcb = word.u16(cbRgFcLcbAt);
  const blob = cbRgFcLcbAt + 2;
  return {
    ccpText,
    atnStart,
    ccpAtn,
    fcLcb: (index) => (index < cbRgFcLcb ? { fc: word.u32(blob + index * 8), lcb: word.u32(blob + index * 8 + 4) } : { fc: 0, lcb: 0 }),
  };
}

/** The FIB with every table-stream entry cut to what the stream holds (a damaged length could claim gigabytes). */
function withinTable(fib: Fib, tableLength: number): Fib {
  return {
    ...fib,
    fcLcb(index) {
      const { fc, lcb } = fib.fcLcb(index);
      return { fc, lcb: Math.min(lcb, Math.max(tableLength - fc, 0)) };
    },
  };
}

// --- Text: the piece table ------------------------------------------------------------------------------

interface Piece {
  cp0: number;
  cp1: number;
  /** Byte position of the piece's first character in the WordDocument stream. */
  byte: number;
  unicode: boolean;
}

function readPieces(table: Reader, fib: Fib): Piece[] {
  const { fc, lcb } = fib.fcLcb(FC_CLX);
  let at = fc;
  const end = fc + lcb;
  // Skip the Prc entries (grouped property modifiers) to reach the piece table.
  while (at < end && table.u8(at) === 1) at += 3 + table.u16(at + 1);
  if (table.u8(at) !== 2) throw new Error(t('app.docDamaged'));
  const size = table.u32(at + 1);
  const plc = at + 5;
  const n = Math.min((size - 4) / 12, table.bytes.length);
  const pieces: Piece[] = [];
  for (let i = 0; i < n; i++) {
    const cp0 = table.u32(plc + i * 4);
    const cp1 = table.u32(plc + (i + 1) * 4);
    const raw = table.u32(plc + (n + 1) * 4 + i * 8 + 2);
    const compressed = (raw & 0x40000000) !== 0;
    const fcValue = raw & 0x3fffffff;
    pieces.push({ cp0, cp1, byte: compressed ? fcValue / 2 : fcValue, unicode: !compressed });
  }
  return pieces;
}

function readText(word: Reader, pieces: Piece[], limit: number): string {
  const cp1252 = new TextDecoder('windows-1252');
  let out = '';
  for (const p of pieces) {
    if (p.cp0 >= limit) break;
    // A damaged file can claim more text than it has.
    const available = Math.max(word.bytes.length - p.byte, 0) / (p.unicode ? 2 : 1);
    const length = Math.min(Math.min(p.cp1, limit) - p.cp0, available);
    if (length <= 0) continue;
    out += p.unicode ? word.utf16(p.byte, length) : cp1252.decode(word.slice(p.byte, length));
  }
  return out;
}

/** The position in the WordDocument stream of a character, for looking up its formatting. */
function byteOf(pieces: Piece[], cp: number): { byte: number; unicode: boolean; pieceEnd: number } | null {
  let lo = 0;
  let hi = pieces.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = pieces[mid];
    if (cp < p.cp0) hi = mid - 1;
    else if (cp >= p.cp1) lo = mid + 1;
    else return { byte: p.byte + (cp - p.cp0) * (p.unicode ? 2 : 1), unicode: p.unicode, pieceEnd: p.cp1 };
  }
  return null;
}

// --- Formatting runs (FKPs) -----------------------------------------------------------------------------

interface FormatRun {
  from: number;
  to: number;
  istd: number;
  prl: Uint8Array;
}

function readFkps(word: Reader, table: Reader, fib: Fib, which: number, paragraph: boolean): FormatRun[] {
  const { fc, lcb } = fib.fcLcb(which);
  const n = Math.floor((lcb - 4) / 8);
  const runs: FormatRun[] = [];
  // Each page is read once: a damaged table listing one page over and over would multiply its runs.
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const page = table.u32(fc + (n + 1) * 4 + i * 4) * 512;
    if (seen.has(page)) continue;
    seen.add(page);
    const count = word.u8(page + 511);
    for (let k = 0; k < count; k++) {
      const from = word.u32(page + k * 4);
      const to = word.u32(page + (k + 1) * 4);
      let prl: Uint8Array = new Uint8Array(0);
      let istd = 0;
      if (paragraph) {
        const offset = word.u8(page + (count + 1) * 4 + k * 13) * 2;
        if (offset) {
          let length = word.u8(page + offset);
          let start = page + offset + 1;
          if (length === 0) {
            length = word.u8(page + offset + 1) * 2;
            start = page + offset + 2;
          } else length = length * 2 - 1;
          istd = word.u16(start);
          prl = word.slice(start + 2, length - 2);
        }
      } else {
        const offset = word.u8(page + (count + 1) * 4 + k) * 2;
        if (offset) prl = word.slice(page + offset + 1, word.u8(page + offset));
      }
      runs.push({ from, to, istd, prl });
    }
  }
  return runs.sort((a, b) => a.from - b.from);
}

function findRun(runs: FormatRun[], byte: number): FormatRun | null {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = runs[mid];
    if (byte < r.from) hi = mid - 1;
    else if (byte >= r.to) lo = mid + 1;
    else return r;
  }
  return null;
}

// --- Property lists (sprms) ---------------------------------------------------------------------------

/** Calls `visit` for each property in a list, with its opcode and operand bytes. */
function forEachSprm(prl: Uint8Array, visit: (op: number, operand: Uint8Array) => void): void {
  let at = 0;
  while (at + 2 <= prl.length) {
    const op = prl[at] | (prl[at + 1] << 8);
    at += 2;
    let size: number;
    switch (op >> 13) {
      case 0:
      case 1:
        size = 1;
        break;
      case 2:
      case 4:
      case 5:
        size = 2;
        break;
      case 3:
        size = 4;
        break;
      case 7:
        size = 3;
        break;
      default:
        // Variable length: a length byte, except for the table definition (a 16-bit length, counting itself).
        size = op === 0xd608 ? (prl[at] | (prl[at + 1] << 8)) + 1 : (prl[at] ?? 0) + 1;
    }
    if (at + size > prl.length) size = prl.length - at;
    visit(op, prl.subarray(at, at + size));
    at += size;
  }
}

const num = (b: Uint8Array): number => (b.length >= 4 ? (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0 : b.length >= 2 ? b[0] | (b[1] << 8) : (b[0] ?? 0));
const signed = (b: Uint8Array): number => ((num(b) << 16) >> 16);

const ICO = ['', '000000', '0000FF', '00FFFF', '00FF00', 'FF00FF', 'FF0000', 'FFFF00', 'FFFFFF', '000080', '008080', '008000', '800080', '800000', '808000', '808080', 'C0C0C0'];
const HIGHLIGHT = ['', 'black', 'blue', 'cyan', 'green', 'magenta', 'red', 'yellow', 'white', 'darkBlue', 'darkCyan', 'darkGreen', 'darkMagenta', 'darkRed', 'darkYellow', 'darkGray', 'lightGray'];
const BORDER_TYPES: Record<number, string> = { 1: 'single', 2: 'thick', 3: 'double', 5: 'hairline', 6: 'dotted', 7: 'dashed', 8: 'dotDash', 9: 'dotDotDash', 10: 'triple' };
const UNDERLINE: Record<number, string> = { 1: 'single', 2: 'words', 3: 'double', 4: 'dotted', 6: 'thick', 7: 'dash', 9: 'dotDash', 10: 'dotDotDash', 11: 'wave', 20: 'dottedHeavy', 23: 'dashedHeavy', 25: 'dashDotHeavy', 26: 'dashDotDotHeavy', 27: 'wavyHeavy', 39: 'wavyDouble' };

interface CharState {
  props: RunProperties;
  special?: boolean;
  picture?: number;
  symbol?: { font: number; char: number };
  styleIstd?: number;
}

interface ParaState {
  props: ParagraphProperties;
  inTable?: boolean;
  rowEnd?: boolean;
  depth?: number;
  ilfo?: number;
  ilvl?: number;
  cells?: number[];
  header?: boolean;
  styleIstd?: number;
}

/** An on/off property: 0 and 1 are plain; 0x80 means "as the style has it" and 0x81 "the opposite of the style". */
const toggle = (b: Uint8Array, inherited?: boolean): boolean | undefined =>
  b[0] === 0 ? false : b[0] === 1 ? true : b[0] === 0x80 ? !!inherited : b[0] === 0x81 ? !inherited : undefined;

class Sprms {
  constructor(readonly fonts: string[]) {}

  /** `base` is the formatting the run's styles give it, which on/off properties are relative to. */
  char(prl: Uint8Array, state: CharState, base: RunProperties = {}): void {
    const p = state.props;
    forEachSprm(prl, (op, v) => {
      switch (op) {
        case 0x0835:
          return void (p.bold = toggle(v, base.bold) ?? p.bold);
        case 0x0836:
          return void (p.italic = toggle(v, base.italic) ?? p.italic);
        case 0x0837:
          return void (p.strike = toggle(v, base.strike) ?? p.strike);
        case 0x2a53:
          return void (p.doubleStrike = toggle(v, base.doubleStrike) ?? p.doubleStrike);
        case 0x083a:
          return void (p.smallCaps = toggle(v, base.smallCaps) ?? p.smallCaps);
        case 0x083b:
          return void (p.caps = toggle(v, base.caps) ?? p.caps);
        case 0x083c:
          return void (p.vanish = toggle(v, base.vanish) ?? p.vanish);
        case 0x0855:
          state.special = v[0] === 1;
          return;
        case 0x2a3e:
          p.underline = v[0] === 0 ? { val: 'none' } : { val: UNDERLINE[v[0]] ?? 'single' };
          return;
        case 0x2a42:
          if (ICO[v[0]]) p.color = { val: ICO[v[0]] };
          else if (v[0] === 0) delete p.color;
          return;
        case 0x6870:
          if (v[3] !== 0xff) p.color = { val: [v[0], v[1], v[2]].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase() };
          return;
        case 0x4a43:
          p.size = num(v);
          p.sizeCs = num(v);
          return;
        case 0x2a48:
          p.vertAlign = v[0] === 1 ? 'superscript' : v[0] === 2 ? 'subscript' : 'baseline';
          return;
        case 0x4a4f:
        case 0x4a51: {
          const name = this.fonts[num(v)];
          if (name) p.fonts = { ...p.fonts, ascii: name, hAnsi: name };
          return;
        }
        case 0x4a50: {
          const name = this.fonts[num(v)];
          if (name) p.fonts = { ...p.fonts, eastAsia: name };
          return;
        }
        case 0x2a0c:
          if (HIGHLIGHT[v[0]]) p.highlight = HIGHLIGHT[v[0]];
          else delete p.highlight;
          return;
        case 0x4a30:
          state.styleIstd = num(v);
          return;
        case 0x6a03:
          state.picture = num(v);
          return;
        case 0x6a09:
          state.symbol = { font: num(v.subarray(0, 2)), char: num(v.subarray(2, 4)) };
          return;
      }
    });
  }

  para(prl: Uint8Array, state: ParaState): void {
    const p = state.props;
    const indent = () => (p.indent ??= {});
    const spacing = () => (p.spacing ??= {});
    forEachSprm(prl, (op, v) => {
      switch (op) {
        case 0x4600:
          state.styleIstd = num(v);
          return;
        case 0x2403:
        case 0x2461:
          p.justification = ['left', 'center', 'right', 'both', 'both'][v[0]] ?? 'left';
          return;
        case 0x2405:
          return void (p.keepLines = toggle(v) ?? p.keepLines);
        case 0x2406:
          return void (p.keepNext = toggle(v) ?? p.keepNext);
        case 0x2407:
          return void (p.pageBreakBefore = toggle(v) ?? p.pageBreakBefore);
        case 0x2416:
          state.inTable = v[0] === 1;
          return;
        case 0x2417:
          state.rowEnd = v[0] === 1;
          return;
        case 0x6649:
          state.depth = num(v);
          return;
        case 0x260a:
          state.ilvl = v[0];
          return;
        case 0x460b:
          state.ilfo = signed(v);
          return;
        case 0x840f:
        case 0x845e:
          indent().left = signed(v);
          return;
        case 0x840e:
        case 0x845d:
          indent().right = signed(v);
          return;
        case 0x8411:
        case 0x8460: {
          const first = signed(v);
          const ind = indent();
          delete ind.firstLine;
          delete ind.hanging;
          if (first < 0) ind.hanging = -first;
          else if (first > 0) ind.firstLine = first;
          return;
        }
        case 0xa413:
          spacing().before = num(v);
          return;
        case 0xa414:
          spacing().after = num(v);
          return;
        case 0x6412: {
          const line = signed(v.subarray(0, 2));
          const multiple = num(v.subarray(2, 4)) === 1;
          if (multiple) Object.assign(spacing(), { line, lineRule: 'auto' });
          else if (line < 0) Object.assign(spacing(), { line: -line, lineRule: 'exact' });
          else if (line > 0) Object.assign(spacing(), { line, lineRule: 'atLeast' });
          return;
        }
        case 0x2640:
          if (v[0] < 9) p.outlineLevel = v[0];
          return;
        case 0x3404:
          state.header = v[0] === 1;
          return;
        case 0x6424:
        case 0x6425:
        case 0x6426:
        case 0x6427: {
          // A 4-byte border: width in eighths of a point, type, colour index.
          const side = (['top', 'left', 'bottom', 'right'] as const)[op - 0x6424];
          const borders = (p.borders ??= {});
          if (v[1] === 0 || v[1] === 255 || v[0] === 0xff) delete borders[side];
          else borders[side] = { val: BORDER_TYPES[v[1]] ?? 'single', sz: Math.max(v[0], 2), space: 1, color: ICO[v[2]] || 'auto' };
          return;
        }
        case 0xc64e:
        case 0xc64f:
        case 0xc650:
        case 0xc651: {
          // The newer 8-byte form: colour, width, type, space.
          const side = (['top', 'left', 'bottom', 'right'] as const)[op - 0xc64e];
          const borders = (p.borders ??= {});
          const type = v[5];
          if (!type || type === 255) return;
          const rgb = v[3] === 0xff ? 'auto' : [v[0], v[1], v[2]].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
          borders[side] = { val: BORDER_TYPES[type] ?? 'single', sz: Math.max(v[4], 2), space: v[6] & 0x1f, color: rgb };
          return;
        }
        case 0xd608: {
          // TDefTable: cb (16 bits), itcMac, then itcMac+1 cell boundaries (twips, from the row's left edge).
          const columns = v[2] ?? 0;
          const edges: number[] = [];
          for (let i = 0; i <= columns; i++) edges.push(signed(v.subarray(3 + i * 2, 5 + i * 2)));
          state.cells = edges;
        }
      }
    });
  }
}

// --- Fonts -----------------------------------------------------------------------------------------------

function readFonts(table: Reader, fib: Fib): string[] {
  const { fc, lcb } = fib.fcLcb(FC_STTBF_FFN);
  const fonts: string[] = [];
  if (!lcb) return fonts;
  const count = table.u16(fc);
  let at = fc + 4;
  for (let i = 0; i < count && at < fc + lcb; i++) {
    const size = table.u8(at);
    // An FFN is 39 bytes of metrics, then the face name as a null-terminated UTF-16 string.
    let name = '';
    for (let k = at + 1 + 39; k + 2 <= at + 1 + size; k += 2) {
      const c = table.u16(k);
      if (!c) break;
      name += String.fromCharCode(c);
    }
    fonts.push(name);
    at += 1 + size;
  }
  return fonts;
}

// --- Styles ----------------------------------------------------------------------------------------------

interface StyleDef {
  istd: number;
  sti: number;
  kind: number;
  base: number;
  next: number;
  name: string;
  paraPrl: Uint8Array | null;
  paraIstd: number;
  charPrl: Uint8Array | null;
}

function readStyles(table: Reader, fib: Fib): StyleDef[] {
  const { fc, lcb } = fib.fcLcb(FC_STSHF);
  if (!lcb) return [];
  const cbStshi = table.u16(fc);
  const count = table.u16(fc + 2);
  const baseSize = table.u16(fc + 4);
  let at = fc + 2 + cbStshi;
  const defs: StyleDef[] = [];
  for (let istd = 0; istd < count && at < fc + lcb; istd++) {
    const cb = table.u16(at);
    at += 2;
    if (cb === 0) continue;
    const std = at;
    at += cb + (cb & 1);
    const w0 = table.u16(std);
    const w1 = table.u16(std + 2);
    const w2 = table.u16(std + 4);
    const nameChars = table.u16(std + baseSize);
    const name = table.utf16(std + baseSize + 2, nameChars);
    let pos = baseSize + 2 + (nameChars + 1) * 2;
    pos += pos & 1;
    const cupx = w2 & 0xf;
    const upx: Uint8Array[] = [];
    for (let k = 0; k < cupx && pos + 2 <= cb; k++) {
      const size = table.u16(std + pos);
      upx.push(table.slice(std + pos + 2, size));
      pos += 2 + size;
      pos += pos & 1;
    }
    const kind = w1 & 0xf;
    defs.push({
      istd,
      sti: w0 & 0xfff,
      kind,
      base: (w1 >> 4) & 0xfff,
      next: (w2 >> 4) & 0xfff,
      name,
      paraIstd: kind === 1 && upx[0] ? upx[0][0] | (upx[0][1] << 8) : 0,
      paraPrl: kind === 1 && upx[0] ? upx[0].subarray(2) : null,
      charPrl: kind === 1 ? (upx[1] ?? null) : kind === 2 ? (upx[0] ?? null) : null,
    });
  }
  return defs;
}

// --- Lists -----------------------------------------------------------------------------------------------

interface ListLevel {
  format: string;
  start: number;
  text: string;
  paraPrl: Uint8Array;
  charPrl: Uint8Array;
  justification: string;
}

const NFC: Record<number, string> = { 0: 'decimal', 1: 'upperRoman', 2: 'lowerRoman', 3: 'upperLetter', 4: 'lowerLetter', 5: 'ordinal', 22: 'decimalZero', 23: 'bullet', 255: 'none' };

function readLists(table: Reader, fib: Fib): { lists: Map<number, ListLevel[]>; overrides: number[] } {
  const lists = new Map<number, ListLevel[]>();
  const overrides: number[] = [];
  const lst = fib.fcLcb(FC_PLCF_LST);
  if (lst.lcb) {
    const count = table.u16(lst.fc);
    let at = lst.fc + 2;
    const heads: { lsid: number; levels: number }[] = [];
    for (let i = 0; i < count; i++) {
      const flags = table.u8(at + 26);
      heads.push({ lsid: table.u32(at), levels: flags & 1 ? 1 : 9 });
      at += 28;
    }
    for (const head of heads) {
      const levels: ListLevel[] = [];
      for (let l = 0; l < head.levels; l++) {
        const cbPapx = table.u8(at + 25);
        const cbChpx = table.u8(at + 24);
        const jc = table.u8(at + 5) & 3;
        const format = NFC[table.u8(at + 4)] ?? 'decimal';
        const start = table.u32(at + 0);
        const paraPrl = table.slice(at + 28, cbPapx);
        const charPrl = table.slice(at + 28 + cbPapx, cbChpx);
        const textAt = at + 28 + cbPapx + cbChpx;
        const chars = table.u16(textAt);
        let text = '';
        for (let k = 0; k < chars; k++) {
          const c = table.u16(textAt + 2 + k * 2);
          // Codes 0-8 stand for the number of that level.
          text += c < 9 ? `%${c + 1}` : c >= 0xf000 ? bulletChar(c) : String.fromCharCode(c);
        }
        levels.push({ format, start, text, paraPrl, charPrl, justification: ['left', 'center', 'right'][jc] ?? 'left' });
        at = textAt + 2 + chars * 2;
      }
      lists.set(head.lsid, levels);
    }
  }
  const lfo = fib.fcLcb(FC_PLF_LFO);
  if (lfo.lcb) {
    // Each override is 16 bytes: a count beyond that is damage.
    const count = Math.min(table.u32(lfo.fc), Math.floor((lfo.lcb - 4) / 16));
    for (let i = 0; i < count; i++) overrides.push(table.u32(lfo.fc + 4 + i * 16));
  }
  return { lists, overrides };
}

/** Symbol-font private-use characters that Word uses for bullets, as ordinary Unicode. */
function bulletChar(code: number): string {
  switch (code & 0xff) {
    case 0xb7:
      return '•';
    case 0xa7:
      return '▪';
    case 0xd8:
      return '➢';
    case 0x76:
      return '❖';
    case 0xfc:
      return '✓';
    default:
      return '•';
  }
}

// --- Pictures --------------------------------------------------------------------------------------------

/** An inline picture from the Data stream: its bytes, type and display size in EMU. */
function readPicture(data: Reader, at: number): { bytes: Uint8Array; ext: string; width: number; height: number } | null {
  const lcb = data.u32(at);
  const header = data.u16(at + 4);
  if (!lcb || lcb > data.bytes.length - at || header < 0x44) return null;
  const goalW = data.u16(at + 28);
  const goalH = data.u16(at + 30);
  const mx = data.u16(at + 32) || 1000;
  const my = data.u16(at + 34) || 1000;
  // Records after the header: find the first PNG or JPEG BLIP.
  let pos = at + header + (data.u16(at + 6) === 0x66 ? 1 + data.u8(at + header) : 0);
  const end = at + lcb;
  while (pos + 8 <= end) {
    const verInst = data.u16(pos);
    const type = data.u16(pos + 2);
    const size = data.u32(pos + 4);
    const container = (verInst & 0xf) === 0xf;
    if (type === 0xf01e || type === 0xf01d) {
      const instance = verInst >> 4;
      const twoUids = type === 0xf01e ? instance === 0x6e1 : instance === 0x46b || instance === 0x6e3 ? instance === 0x6e3 : false;
      const skip = 16 + (twoUids ? 16 : 0) + 1;
      const bytes = data.slice(pos + 8 + skip, size - skip);
      if (bytes.length < 8) return null;
      return { bytes, ext: type === 0xf01e ? 'png' : 'jpeg', width: Math.round((goalW * mx) / 1000) * 635, height: Math.round((goalH * my) / 1000) * 635 };
    }
    // A BLIP store entry holds its picture after 36 bytes of description and the picture's name.
    if (type === 0xf007) pos += 8 + 36 + data.u8(pos + 8 + 33);
    else pos += container ? 8 : 8 + size;
  }
  return null;
}

// --- The reader ------------------------------------------------------------------------------------------

export async function docToDocument(bytes: Uint8Array): Promise<WordDocument> {
  if (!isCfb(bytes)) throw new Error(t('app.notDoc'));
  // A container too damaged to read (a truncated or inconsistent sector table) is a damaged document.
  const container = <T>(read: () => T): T => {
    try {
      return read();
    } catch (e) {
      if (e instanceof CfbError || e instanceof RangeError) throw new Error(t('app.docDamaged'));
      throw e;
    }
  };
  const cfb = container(() => new Cfb(bytes));
  const wordBytes = container(() => cfb.stream('WordDocument'));
  if (!wordBytes) throw new Error(t('app.notDoc'));
  const word = new Reader(wordBytes);
  const fibRead = readFib(word);
  const tableBytes = container(() => cfb.stream(word.u16(10) & 0x0200 ? '1Table' : '0Table'));
  if (!tableBytes) throw new Error(t('app.docDamaged'));
  const table = new Reader(tableBytes);
  const fib = withinTable(fibRead, tableBytes.length);
  const dataBytes = container(() => cfb.stream('Data'));
  const doc = await WordDocument.create();
  try {
    await new DocReader(doc, word, table, dataBytes ? new Reader(dataBytes) : null, fib).read();
  } catch (e) {
    if (e instanceof RangeError || e instanceof TypeError) throw new Error(t('app.docDamaged'));
    throw e;
  }
  return doc;
}

class DocReader {
  private readonly pieces: Piece[];
  private readonly text: string;
  private readonly chp: FormatRun[];
  private readonly pap: FormatRun[];
  private readonly sprms: Sprms;
  private readonly styleIds = new Map<number, string>();
  private readonly styleDefs = new Map<number, StyleDef>();
  private readonly effectiveRuns = new Map<number, RunProperties>();
  private readonly listInstances = new Map<number, number>();
  private lists: ReturnType<typeof readLists>;
  private nextAbstract = 1;
  private sectionEnds = new Set<number>();
  /** Each body paragraph and the characters it was read from, for placing comment markers. */
  private readonly spans: { paragraph: Paragraph; start: number; mark: number }[] = [];

  constructor(
    private readonly doc: WordDocument,
    private readonly word: Reader,
    private readonly table: Reader,
    private readonly data: Reader | null,
    private readonly fib: Fib,
  ) {
    this.pieces = readPieces(table, fib);
    this.text = readText(word, this.pieces, fib.ccpText);
    this.chp = readFkps(word, table, fib, FC_BTE_CHPX, false);
    this.pap = readFkps(word, table, fib, FC_BTE_PAPX, true);
    this.sprms = new Sprms(readFonts(table, fib));
    this.lists = readLists(table, fib);
  }

  async read(): Promise<void> {
    // Word 97's page: Letter, 1.25" side margins, unless the section says otherwise.
    this.doc.section.pageSize = { w: 12240, h: 15840 };
    this.doc.section.margins = { top: 1440, bottom: 1440, left: 1800, right: 1800, header: 720, footer: 720, gutter: 0 };
    this.readSections();
    this.installStyles(readStyles(this.table, this.fib));
    const body = this.body();
    this.readComments();
    this.doc.body = body.length && body.at(-1)?.kind !== 'table' ? body : [...body, { kind: 'paragraph', properties: {}, children: [], attrs: {} }];
  }

  // --- Sections ---

  private readSections(): void {
    const { fc, lcb } = this.fib.fcLcb(FC_PLCF_SED);
    if (!lcb) return;
    const n = (lcb - 4) / 16;
    for (let i = 1; i <= n; i++) this.sectionEnds.add(this.table.u32(fc + i * 4) - 1);
    const fcSepx = this.table.u32(fc + (n + 1) * 4 + 2);
    if (fcSepx === 0xffffffff) return;
    const cb = this.word.u16(fcSepx);
    const section = this.doc.section;
    const size = (section.pageSize ??= {});
    const margins = (section.margins ??= {});
    forEachSprm(this.word.slice(fcSepx + 2, cb), (op, v) => {
      switch (op) {
        case 0xb01f:
          size.w = num(v);
          return;
        case 0xb020:
          size.h = num(v);
          return;
        case 0xb021:
          margins.left = num(v);
          return;
        case 0xb022:
          margins.right = num(v);
          return;
        case 0x9023:
          margins.top = signed(v);
          return;
        case 0x9024:
          margins.bottom = signed(v);
          return;
        case 0x301d:
          if (v[0] === 2) size.orient = 'landscape';
      }
    });
  }

  // --- Styles ---

  private installStyles(defs: StyleDef[]): void {
    const styles: Style[] = [];
    const used = new Set<string>();
    const idFor = (d: StyleDef): string => {
      let id: string;
      if (d.istd === 0 || d.sti === 0) id = 'Normal';
      else if (d.sti >= 1 && d.sti <= 9) id = `Heading${d.sti}`;
      else if (d.sti === 62 || d.name.toLowerCase() === 'title') id = 'Title';
      else id = d.name.replace(/[^A-Za-z0-9]/g, '') || `Style${d.istd}`;
      let unique = id;
      for (let k = 2; used.has(unique); k++) unique = `${id}${k}`;
      used.add(unique);
      return unique;
    };
    for (const d of defs) if (d.kind === 1 || d.kind === 2) this.styleIds.set(d.istd, idFor(d));
    for (const d of defs) this.styleDefs.set(d.istd, d);
    for (const d of defs) {
      const id = this.styleIds.get(d.istd);
      if (!id) continue;
      const paragraph = d.kind === 1;
      const style: Style = {
        type: paragraph ? 'paragraph' : 'character',
        id,
        name: d.sti >= 1 && d.sti <= 9 ? `heading ${d.sti}` : d.name,
        attrs: {},
        ...(id === 'Normal' && { isDefault: true }),
        ...(d.base !== 0xfff && d.base !== d.istd && this.styleIds.has(d.base) && { basedOn: this.styleIds.get(d.base) }),
        ...(paragraph && d.next !== d.istd && this.styleIds.has(d.next) && { next: this.styleIds.get(d.next) }),
      };
      if (d.charPrl?.length) {
        const state: CharState = { props: {} };
        this.sprms.char(d.charPrl, state, this.effectiveRun(d.base, new Set([d.istd])));
        if (Object.keys(state.props).length) style.runProperties = state.props;
      }
      if (paragraph && d.paraPrl?.length) {
        const state: ParaState = { props: {} };
        this.sprms.para(d.paraPrl, state);
        const numbering = this.numberingFor(state);
        if (numbering) state.props.numbering = numbering;
        if (Object.keys(state.props).length) style.paragraphProperties = state.props;
      }
      styles.push(style);
    }
    if (!styles.some((s) => s.id === 'Normal')) styles.unshift({ type: 'paragraph', id: 'Normal', name: 'Normal', isDefault: true, attrs: {} });
    // Word 97's defaults: Times New Roman 10pt, single-spaced, nothing between paragraphs.
    const font = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: 'Times New Roman', cs: 'Times New Roman' };
    this.doc.styles.styles = styles;
    this.doc.styles.defaultRunProperties = { fonts: font, size: 20, sizeCs: 20 };
    this.doc.styles.defaultParagraphProperties = { spacing: { after: 0, line: 240, lineRule: 'auto' } };
    this.doc.styles.hasRunDefaults = true;
    this.doc.styles.hasParagraphDefaults = true;
  }

  /** What a style (and the styles it is based on) gives text: the values on/off properties are relative to. */
  private effectiveRun(istd: number, seen: Set<number> = new Set()): RunProperties {
    const cached = this.effectiveRuns.get(istd);
    if (cached) return cached;
    const def = this.styleDefs.get(istd);
    if (!def || seen.has(istd)) return {};
    seen.add(istd);
    const base = def.base !== 0xfff && def.base !== istd ? this.effectiveRun(def.base, seen) : {};
    const state: CharState = { props: {} };
    if (def.charPrl?.length) this.sprms.char(def.charPrl, state, base);
    const merged: RunProperties = { ...base, ...state.props };
    this.effectiveRuns.set(istd, merged);
    return merged;
  }

  // --- Lists ---

  private numberingFor(state: ParaState): { id: number; level: number } | undefined {
    const ilfo = state.ilfo;
    if (!ilfo || ilfo <= 0) return undefined;
    const lsid = this.lists.overrides[ilfo - 1];
    const levels = this.lists.lists.get(lsid);
    if (!levels) return undefined;
    let id = this.listInstances.get(ilfo);
    if (id === undefined) {
      const abstractId = this.nextAbstract++;
      const built: NumberingLevel[] = Array.from({ length: 9 }, (_, l) => {
        const def = levels[l] ?? levels[0];
        const props: ParaState = { props: {} };
        this.sprms.para(def.paraPrl, props);
        const run: CharState = { props: {} };
        this.sprms.char(def.charPrl, run);
        return {
          level: l,
          start: def.start,
          format: def.format,
          suffix: 'tab' as const,
          text: def.text || (def.format === 'bullet' ? '•' : `%${l + 1}.`),
          justification: def.justification,
          paragraphProperties: props.props,
          ...(Object.keys(run.props).length && { runProperties: run.props }),
          attrs: {},
        };
      });
      this.doc.numbering.abstracts.push({ id: abstractId, multiLevelType: 'multilevel', levels: built, attrs: {} });
      id = ilfo;
      this.doc.numbering.instances.push({ id, abstractId, overrides: [], attrs: {} });
      this.listInstances.set(ilfo, id);
    }
    return { id, level: Math.min(state.ilvl ?? 0, 8) };
  }

  // --- Body ---

  private body(): Block[] {
    const blocks: Block[] = [];
    const text = this.text;
    let start = 0;
    let cell: Block[] = [];
    let cells: TableCell[] = [];
    let rows: TableRow[] = [];
    let widths: number[] = [];
    let cellStates: ParaState[] = [];
    const flushTable = () => {
      if (!rows.length) return;
      const border = { val: 'single', sz: 4, space: 0, color: 'auto' };
      const table: Table = {
        kind: 'table',
        properties: { width: { w: '0', type: 'auto' }, borders: { top: border, left: border, bottom: border, right: border, insideH: border, insideV: border } },
        grid: widths,
        rows,
      };
      blocks.push(table);
      rows = [];
      widths = [];
    };
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      const sectionEnd = c === 0x0c && this.sectionEnds.has(i);
      if (c !== 0x0d && c !== 0x07 && !sectionEnd) continue;
      const state = this.paragraphState(i);
      const depth = state.depth ?? (state.inTable ? 1 : 0);
      const inTable = !!state.inTable || state.rowEnd;
      if (inTable && depth <= 1) {
        if (state.rowEnd) {
          // The row-end mark: the row's boundaries are here.
          const edges = state.cells ?? [];
          const rowWidths = edges.slice(1).map((edge, k) => Math.max(edge - edges[k], 200));
          cells.forEach((cellBlock, k) => {
            if (rowWidths[k] !== undefined) cellBlock.properties.width = { w: String(rowWidths[k]), type: 'dxa' };
          });
          if (rowWidths.length > widths.length) widths = rowWidths;
          if (cells.length) {
            const header = cellStates.some((s) => s.header) || !!state.header;
            rows.push({ kind: 'row', properties: header ? { header: true } : {}, cells, attrs: {} });
          }
          cells = [];
          cellStates = [];
        } else {
          const paragraph = this.paragraph(start, i, state);
          if (paragraph) cell.push(paragraph);
          if (c === 0x07) {
            cells.push({ kind: 'cell', properties: {}, children: cell.length ? cell : [{ kind: 'paragraph', properties: {}, children: [], attrs: {} }], attrs: {} });
            cellStates.push(state);
            cell = [];
          }
        }
      } else {
        if (inTable) {
          // A nested table's paragraphs join the cell they are in.
          const paragraph = this.paragraph(start, i, state);
          if (paragraph && c === 0x0d) cell.push(paragraph);
        } else {
          flushTable();
          const paragraph = this.paragraph(start, i, state);
          if (paragraph) {
            blocks.push(paragraph);
          }
        }
      }
      start = i + 1;
    }
    flushTable();
    // Text after the last paragraph mark (a document that doesn't end with one).
    if (start < text.length) {
      const paragraph = this.paragraph(start, text.length, { props: {} });
      if (paragraph) blocks.push(paragraph);
    }
    return blocks;
  }

  /** Formatting of the paragraph ending at `mark`, from the PAPX that covers its mark. */
  private paragraphState(mark: number): ParaState {
    const state: ParaState = { props: {} };
    const where = byteOf(this.pieces, mark);
    const run = where ? findRun(this.pap, where.byte) : null;
    if (run) {
      state.styleIstd = run.istd;
      this.sprms.para(run.prl, state);
    }
    return state;
  }

  private paragraph(start: number, mark: number, state: ParaState): Paragraph | null {
    const props: ParagraphProperties = { ...state.props };
    const styleId = state.styleIstd ? this.styleIds.get(state.styleIstd) : undefined;
    if (styleId && styleId !== 'Normal') props.style = styleId;
    const numbering = this.numberingFor(state);
    if (numbering) props.numbering = numbering;
    const children = this.inlines(start, mark, state.styleIstd ?? 0);
    // A paragraph that is only a section mark and nothing else is dropped.
    if (!children.length && this.text.charCodeAt(mark) === 0x0c) return null;
    const result: Paragraph = { kind: 'paragraph', properties: props, children, attrs: {} };
    this.spans.push({ paragraph: result, start, mark });
    return result;
  }

  // --- Comments ---

  /** Reads the comments and puts their markers into the paragraphs built from the main text. */
  private readComments(): void {
    const { fib, table } = this;
    const ref = fib.fcLcb(FC_PLCF_AND_REF);
    const txt = fib.fcLcb(FC_PLCF_AND_TXT);
    const count = ref.lcb >= 4 ? Math.min(Math.floor((ref.lcb - 4) / 34), 100000) : 0;
    if (!count || !fib.ccpAtn || txt.lcb < (count + 1) * 4) return;
    const annotation = readText(this.word, this.pieces, fib.atnStart + fib.ccpAtn).slice(fib.atnStart);
    const owners = readOwners(table, fib);
    const extra = fib.fcLcb(FC_ATRD_EXTRA);
    const extraSize = extra.lcb > (count + 1) * 4 ? Math.floor((extra.lcb - (count + 1) * 4) / count) : 0;
    const ranges = this.commentRanges();
    const taken = new Set<number>();
    const markers = new Map<Paragraph, { offset: number; kind: 'start' | 'end'; id: string }[]>();
    const mark = (cp: number, kind: 'start' | 'end', id: string) => {
      const span = this.spans.find((s) => cp >= s.start && cp <= s.mark);
      if (!span) return false;
      const list = markers.get(span.paragraph) ?? [];
      list.push({ offset: this.modelOffset(span.start, cp), kind, id });
      markers.set(span.paragraph, list);
      return true;
    };
    for (let i = 0; i < count; i++) {
      const at = table.u32(ref.fc + i * 4);
      const record = ref.fc + (count + 1) * 4 + i * 30;
      const cch = Math.min(table.u16(record), 9);
      const initials = table.utf16(record + 2, cch);
      const from = table.u32(txt.fc + i * 4);
      const to = Math.min(table.u32(txt.fc + (i + 1) * 4), annotation.length);
      const paragraphs = annotation.slice(from, Math.max(to, from)).replace(/^\x05/, '').replace(/\r$/, '').split(/\r/);
      const id = String(i);
      // The range: a bookmark ending at the reference mark, else just the mark itself.
      const found = ranges.find((r, k) => !taken.has(k) && r.end <= at && at - r.end <= 1);
      const range = found ?? { start: at, end: at };
      if (found) taken.add(ranges.indexOf(found));
      if (!mark(range.end, 'end', id)) continue;
      mark(range.start, 'start', id);
      const date = extraSize >= 4 ? dttmToIso(table.u32(extra.fc + (count + 1) * 4 + i * extraSize)) : undefined;
      const comment = { id, author: owners[table.u16(record + 20)] ?? '', ...(initials && { initials }), ...(date && { date }), paragraphs };
      this.doc.comments.push(comment);
    }
    for (const [paragraph, list] of markers) {
      list.sort((x, y) => y.offset - x.offset || (x.kind === 'end' ? -1 : 1));
      for (const m of list) insertInlines(paragraph, m.offset, m.kind === 'end' ? [commentEnd(m.id), commentReference(m.id)] : [commentStart(m.id)]);
    }
  }

  /** The comment ranges Word stored as bookmarks (PlcfAtnBkf and PlcfAtnBkl): character positions. */
  private commentRanges(): { start: number; end: number }[] {
    const { table, fib } = this;
    const bkf = fib.fcLcb(FC_PLCF_ATN_BKF);
    const bkl = fib.fcLcb(FC_PLCF_ATN_BKL);
    const n = bkf.lcb >= 4 ? Math.min(Math.floor((bkf.lcb - 4) / 8), 100000) : 0;
    const out: { start: number; end: number }[] = [];
    for (let i = 0; i < n; i++) {
      const start = table.u32(bkf.fc + i * 4);
      const ibkl = table.u16(bkf.fc + (n + 1) * 4 + i * 4);
      if ((ibkl + 1) * 4 > bkl.lcb) continue;
      const end = table.u32(bkl.fc + ibkl * 4);
      if (start <= end) out.push({ start, end });
    }
    return out;
  }

  /** Where the character at `cp` falls in the paragraph that starts at `start`, in model positions. */
  private modelOffset(start: number, cp: number): number {
    let offset = 0;
    let code = 0;
    for (let k = start; k < cp; k++) {
      const c = this.text.charCodeAt(k);
      if (c === 0x13) code++;
      else if (c === 0x14 && code) code--;
      else if (c === 0x15 || code) continue;
      else if (c >= 0x20 || c === 0x09 || c === 0x0b || c === 0x0c || c === 0x1e || c === 0x1f) offset++;
    }
    return offset;
  }

  // --- Inline content ---

  private fieldStack: { instruction: string; phase: 'code' | 'result'; link?: { url?: string; anchor?: string; runs: Inline[] } }[] = [];

  private inlines(start: number, end: number, paragraphStyle: number): Inline[] {
    const out: Inline[] = [];
    const sink = (): Inline[] => {
      for (let k = this.fieldStack.length - 1; k >= 0; k--) {
        const link = this.fieldStack[k].link;
        if (link) return link.runs;
      }
      return out;
    };
    const push = (props: RunProperties, item: RunContent): void => {
      const list = sink();
      const last = list.at(-1);
      if (last?.kind === 'run' && item.kind === 'text' && sameProps(last.properties, props)) {
        const tail = last.content.at(-1);
        if (tail?.kind === 'text') {
          tail.text += item.text;
          return;
        }
      }
      if (last?.kind === 'run' && sameProps(last.properties, props) && item.kind !== 'drawing') {
        last.content.push(item);
        return;
      }
      list.push({ kind: 'run', properties: { ...props }, content: [item], attrs: {} } satisfies Run);
    };
    let cp = start;
    while (cp < end) {
      const where = byteOf(this.pieces, cp);
      if (!where) break;
      const run = findRun(this.chp, where.byte);
      const width = where.unicode ? 2 : 1;
      let limit = Math.min(end, where.pieceEnd);
      if (run) limit = Math.min(limit, cp + Math.max(Math.ceil((run.to - where.byte) / width), 1));
      else {
        // No entry: the run lasts until the next one starts.
        const next = this.chp.find((r) => r.from > where.byte);
        if (next) limit = Math.min(limit, cp + Math.max(Math.ceil((next.from - where.byte) / width), 1));
      }
      const state: CharState = { props: {} };
      if (run) {
        // A character style named in the run, and the paragraph's style, are what on/off properties are relative to.
        let charStyle = 0;
        forEachSprm(run.prl, (op, v) => {
          if (op === 0x4a30) charStyle = num(v);
        });
        this.sprms.char(run.prl, state, { ...this.effectiveRun(paragraphStyle), ...(charStyle ? this.effectiveRun(charStyle) : {}) });
      }
      const props = state.props;
      const styleId = state.styleIstd ? this.styleIds.get(state.styleIstd) : undefined;
      if (styleId) props.style = styleId;
      let buffer = '';
      const flush = () => {
        if (buffer) push(props, { kind: 'text', text: buffer });
        buffer = '';
      };
      for (let k = cp; k < limit; k++) {
        const ch = this.text[k];
        const code = ch.charCodeAt(0);
        const field = this.fieldStack.at(-1);
        if (code === 0x13) {
          flush();
          this.fieldStack.push({ instruction: '', phase: 'code' });
          continue;
        }
        if (code === 0x14 && field) {
          flush();
          field.phase = 'result';
          const link = /^\s*HYPERLINK\s+(?:\\[a-z]\s+)*"([^"]*)"(?:\s+\\l\s+"([^"]*)")?/i.exec(field.instruction) ?? /^\s*HYPERLINK\s+\\l\s+"([^"]*)"/i.exec(field.instruction);
          if (link) {
            const isAnchor = /\\l\s+"/i.test(field.instruction) && !/HYPERLINK\s+"/i.test(field.instruction);
            field.link = isAnchor ? { anchor: link[1], runs: [] } : { url: link[1], runs: [] };
          }
          continue;
        }
        if (code === 0x15 && field) {
          flush();
          this.fieldStack.pop();
          if (field.link) {
            const { url, anchor, runs } = field.link;
            if (runs.length) sink().push({ kind: 'hyperlink', ...(url !== undefined ? { url } : { anchor }), children: runs, attrs: {} });
          }
          continue;
        }
        if (field?.phase === 'code') {
          field.instruction += ch;
          continue;
        }
        switch (code) {
          case 0x09:
            flush();
            push(props, { kind: 'tab' });
            break;
          case 0x0b:
            flush();
            push(props, { kind: 'break' });
            break;
          case 0x0c:
            flush();
            push(props, { kind: 'break', type: 'page' });
            break;
          case 0x1e:
            flush();
            push(props, { kind: 'noBreakHyphen' });
            break;
          case 0x1f:
            flush();
            push(props, { kind: 'softHyphen' });
            break;
          case 0x01:
            flush();
            if (state.picture !== undefined && state.special) this.picture(state.picture, props, push);
            break;
          case 0x28:
            if (state.special && state.symbol) {
              const s = state.symbol;
              buffer += s.char >= 0xf000 ? bulletChar(s.char) : String.fromCharCode(s.char);
            }
            break;
          default:
            if (code >= 0x20) buffer += ch;
        }
      }
      flush();
      cp = limit;
    }
    // A link still open at the paragraph's end is closed there.
    for (const f of this.fieldStack) {
      if (f.link?.runs.length) {
        out.push({ kind: 'hyperlink', ...(f.link.url !== undefined ? { url: f.link.url } : { anchor: f.link.anchor }), children: f.link.runs, attrs: {} });
        f.link = undefined;
      }
    }
    return out;
  }

  private picture(offset: number, props: RunProperties, push: (props: RunProperties, item: RunContent) => void): void {
    if (!this.data) return;
    const pic = readPicture(this.data, offset);
    if (!pic || !(pic.width > 0 && pic.height > 0)) return;
    try {
      const image = this.doc.addImage(pic.bytes, pic.ext);
      push(props, { kind: 'drawing', inline: true, width: pic.width, height: pic.height, image });
    } catch {
      // A picture we can't store is left out.
    }
  }
}

/** The comment authors: a list of length-prefixed UTF-16 names. */
function readOwners(table: Reader, fib: Fib): string[] {
  const { fc, lcb } = fib.fcLcb(FC_GRP_XST_ATN_OWNERS);
  const out: string[] = [];
  for (let at = fc; at + 2 <= fc + lcb && out.length < 10000; ) {
    const cch = table.u16(at);
    out.push(table.utf16(at + 2, cch));
    at += 2 + cch * 2;
  }
  return out;
}

function sameProps(a: RunProperties, b: RunProperties): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
