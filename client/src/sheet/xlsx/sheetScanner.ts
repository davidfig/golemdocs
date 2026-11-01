// Reads a worksheet part (xl/worksheets/sheetN.xml) as it inflates, straight into the column model. Not an XML parser: a
// scanner over the UTF-8 bytes that knows only what `sheetData` holds (rows, cells, values, formulas, inline strings).
// The XML before `<sheetData>` and after `</sheetData>` is kept as bytes (`prefix`, `suffix`): it is small, read with
// parseXml (worksheetXml.ts), and written back as it was unless the model changed what it says.
// See docs/spreadsheets.md, "Reading and writing .xlsx".
//
// Pieces may split anywhere, even inside a tag: what is left of an unfinished cell or row is carried to the next piece.
// Tags may carry a namespace prefix (`<x:c>`), as some generators write them.

import { CHUNK_ROWS, Kind, MAX_COLUMNS, MAX_ROWS, errorCode } from '../model/column.ts';
import type { FormulaKind } from '../model/column.ts';
import type { StringPool } from '../model/strings.ts';
import { unescapeXml } from '../model/strings.ts';
import { cellKey } from '../model/worksheet.ts';
import type { Worksheet } from '../model/worksheet.ts';

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const EQ = 0x3d;
const QUOT = 0x22;
const APOS = 0x27;
const SPACE = 0x20;
const COLON = 0x3a;

const encoder = new TextEncoder();
const SHEET_DATA = encoder.encode('sheetData');
const RPH_END = encoder.encode('rPh>');

/** The `t` attribute of a cell. */
const Type = { Number: 0, Shared: 1, Str: 2, Inline: 3, Bool: 4, Error: 5, Date: 6 } as const;
const VALUE_ERROR = errorCode('#VALUE!');

export class SheetScanner {
  /** The bytes up to and including `<sheetData>`, and from `</sheetData>` to the end. */
  readonly prefix: Uint8Array[] = [];
  readonly suffix: Uint8Array[] = [];
  /** Called each time CHUNK_ROWS more rows are in, with the number of rows read so far. */
  onRows: ((rows: number) => void) | null = null;

  private state: 'before' | 'data' | 'after' = 'before';
  private carry: Uint8Array | null = null;
  private row = -1;
  private col = -1;
  private reported = 0;
  /** A shared formula's text and cell, by its `si`, for the cells that only name it. */
  private shared = new Map<number, { text: string; row: number; col: number }>();
  private decoder = new TextDecoder();
  /** Filled by cellTag. */
  private cell = { row: 0, col: 0, style: 0, type: 0 as number, cm: false, extra: '' };
  /** `</prefix:c>` for the namespace prefix in use ("" for none). */
  private cellClose = encoder.encode('</c>');
  private closePrefix = '';

  constructor(
    private readonly sheet: Worksheet,
    private readonly strings: StringPool,
  ) {}

  push(piece: Uint8Array): void {
    let buf = piece;
    if (this.carry) {
      buf = new Uint8Array(this.carry.length + piece.length);
      buf.set(this.carry);
      buf.set(piece, this.carry.length);
      this.carry = null;
    }
    let at = 0;
    if (this.state === 'before') at = this.before(buf);
    if (this.state === 'data') at = this.data(buf, at);
    if (this.state === 'after') {
      if (at < buf.length) this.suffix.push(buf.slice(at));
      at = buf.length;
    }
    if (at < buf.length) this.carry = buf.slice(at);
  }

  /** After the last piece. */
  finish(): void {
    if (this.carry) {
      (this.state === 'before' ? this.prefix : this.suffix).push(this.carry);
      this.carry = null;
    }
    this.onRows?.(this.sheet.grid.rows);
  }

  /** Looks for `<sheetData ...>`; returns where data starts, or keeps a tail that may be the start of it. */
  private before(buf: Uint8Array): number {
    let found = -1;
    for (let at = 0; ; ) {
      const i = indexOfBytes(buf, SHEET_DATA, at);
      if (i < 0) break;
      // The element itself (`<sheetData` or `<x:sheetData`), not `sheetDataExt` or an attribute value.
      const next = buf[i + SHEET_DATA.length];
      let lt = i - 1;
      while (lt >= 0 && buf[lt] !== LT && buf[lt] > SPACE && buf[lt] !== QUOT) lt--;
      if (lt >= 0 && buf[lt] === LT && (next === GT || next === SLASH || next === SPACE || next === undefined)) {
        found = lt;
        break;
      }
      at = i + 1;
    }
    if (found < 0) {
      const keep = Math.max(0, buf.length - SHEET_DATA.length - 12);
      this.prefix.push(buf.slice(0, keep));
      return keep;
    }
    const gt = buf.indexOf(GT, found);
    if (gt < 0) {
      this.prefix.push(buf.slice(0, found));
      return found;
    }
    if (buf[gt - 1] === SLASH) {
      // <sheetData/>: no cells; the rest is the suffix, from the tag itself so it is written back as it was.
      this.prefix.push(buf.slice(0, found));
      this.state = 'after';
      return found;
    }
    this.prefix.push(buf.slice(0, gt + 1));
    this.state = 'data';
    return gt + 1;
  }

  /** Reads rows and cells from `at`; returns how far it got (the rest is an unfinished tag, carried). */
  private data(buf: Uint8Array, at: number): number {
    const end = buf.length;
    for (;;) {
      const lt = buf.indexOf(LT, at);
      if (lt < 0 || lt + 3 >= end) return lt < 0 ? end : lt;
      const closing = buf[lt + 1] === SLASH;
      const name = localName(buf, closing ? lt + 2 : lt + 1);
      if (name < 0) return lt;
      const c1 = buf[name];
      const c2 = buf[name + 1];
      if (!closing && c1 === 0x63 /* c */ && (c2 === SPACE || c2 === GT || c2 === SLASH)) {
        const gt = buf.indexOf(GT, lt);
        if (gt < 0) return lt;
        if (buf[gt - 1] === SLASH) {
          this.cellTag(buf, name + 1, gt - 1);
          if (this.cell.cm) this.cell.extra += ' cm="1"';
          this.store(buf, -1, -1);
          at = gt + 1;
        } else {
          this.closeTag(buf, lt + 1, name);
          const close = indexOfBytes(buf, this.cellClose, gt + 1);
          if (close < 0) return lt;
          this.cellTag(buf, name + 1, gt);
          this.content(buf, gt + 1, close);
          at = close + this.cellClose.length;
        }
      } else if (!closing && c1 === 0x72 /* r */ && c2 === 0x6f /* o */ && buf[name + 2] === 0x77 /* w */) {
        const gt = buf.indexOf(GT, lt);
        if (gt < 0) return lt;
        this.rowTag(buf, name + 3, buf[gt - 1] === SLASH ? gt - 1 : gt);
        at = gt + 1;
      } else if (closing && c1 === 0x73 /* s */ && c2 === 0x68 /* h */) {
        // </sheetData>: the cells are done.
        this.state = 'after';
        return lt;
      } else {
        const gt = buf.indexOf(GT, lt);
        if (gt < 0) return lt;
        at = gt + 1;
      }
    }
  }

  /** Remembers the close tag of a cell, which carries the open tag's prefix. */
  private closeTag(buf: Uint8Array, nameStart: number, local: number): void {
    if (local === nameStart && this.closePrefix === '') return;
    let prefix = '';
    for (let i = nameStart; i < local; i++) prefix += String.fromCharCode(buf[i]);
    if (prefix === this.closePrefix) return;
    this.closePrefix = prefix;
    this.cellClose = encoder.encode(`</${prefix}c>`);
  }

  private rowTag(buf: Uint8Array, at: number, end: number): void {
    let row = this.row + 1;
    let height = -1;
    let hidden = false;
    let style = -1;
    let customFormat = false;
    let level = 0;
    let collapsed = false;
    let extra = '';
    attributes(buf, at, end, (n0, n1, v0, v1) => {
      const length = n1 - n0;
      const first = buf[n0];
      if (length === 1 && first === 0x72 /* r */) row = digits(buf, v0, v1) - 1;
      else if (length === 2 && first === 0x68 /* ht */) height = parseNumber(buf, v0, v1);
      else if (length === 6 && first === 0x68 /* hidden */) hidden = isTrue(buf, v0);
      else if (length === 1 && first === 0x73 /* s */) style = digits(buf, v0, v1);
      else if (length === 12 && first === 0x63 && buf[n0 + 6] === 0x46 /* customFormat */) customFormat = isTrue(buf, v0);
      else if (length === 12 && first === 0x63 && buf[n0 + 6] === 0x48 /* customHeight */) return;
      else if (length === 12 && first === 0x6f /* outlineLevel */) level = digits(buf, v0, v1);
      else if (length === 9 && first === 0x63 /* collapsed */) collapsed = isTrue(buf, v0);
      else if (length === 5 && first === 0x73 /* spans */) return;
      else if (n1 - n0 === 15 && buf[n0 + 6] === 0x64 /* x14ac:dyDescent */) return;
      else extra += ' ' + latin(buf, n0, v1 + 1);
    });
    if (row >= MAX_ROWS) throw new RangeError(`row ${row + 1} is outside the sheet`);
    this.row = row;
    this.col = -1;
    const sheet = this.sheet;
    if (height >= 0 && height !== sheet.rowSizes.default) sheet.rowSizes.set(row, height);
    if (hidden) sheet.rowSizes.setHidden(row, true);
    if (style >= 0 && customFormat) sheet.rowStyles.set(row, style);
    if (level || collapsed) sheet.rowOutline.set(row, { level, collapsed });
    if (extra) sheet.rowAttrs.set(row, extra);
    if (row >= this.reported + CHUNK_ROWS && this.onRows) {
      this.reported = row - (row % CHUNK_ROWS);
      this.onRows(this.reported);
    }
  }

  private cellTag(buf: Uint8Array, at: number, end: number): void {
    const cell = this.cell;
    cell.row = this.row < 0 ? 0 : this.row;
    cell.col = this.col + 1;
    cell.style = 0;
    cell.type = Type.Number;
    cell.cm = false;
    cell.extra = '';
    attributes(buf, at, end, (n0, n1, v0, v1) => {
      const length = n1 - n0;
      const name = buf[n0];
      if (length === 1 && name === 0x72 /* r */) {
        let col = 0;
        let i = v0;
        for (; i < v1 && buf[i] >= 0x41; i++) col = col * 26 + ((buf[i] & 0xdf) - 0x40);
        cell.col = col - 1;
        if (i < v1) cell.row = digits(buf, i, v1) - 1;
      } else if (length === 1 && name === 0x73 /* s */) {
        cell.style = digits(buf, v0, v1);
      } else if (length === 1 && name === 0x74 /* t */) {
        const first = buf[v0];
        cell.type =
          first === 0x73 /* s */
            ? v1 - v0 === 1
              ? Type.Shared
              : Type.Str
            : first === 0x69 /* inlineStr */
              ? Type.Inline
              : first === 0x62 /* b */
                ? Type.Bool
                : first === 0x65 /* e */
                  ? Type.Error
                  : first === 0x64 /* d */
                    ? Type.Date
                    : Type.Number;
      } else if (length === 2 && name === 0x63 /* cm */ && buf[v0] === 0x31 && v1 - v0 === 1) {
        cell.cm = true;
      } else {
        cell.extra += ' ' + latin(buf, n0, v1 + 1);
      }
    });
    if (cell.row >= MAX_ROWS || cell.col >= MAX_COLUMNS || cell.col < 0) throw new RangeError(`cell outside the sheet at row ${cell.row + 1}`);
    this.col = cell.col;
    if (cell.row > this.row) this.row = cell.row;
  }

  /** Reads `<v>`, `<f>` and `<is>` between a cell's tags, then stores the cell. */
  private content(buf: Uint8Array, at: number, end: number): void {
    let valueStart = -1;
    let valueEnd = -1;
    let inline: number[] | null = null;
    let formula = false;
    for (;;) {
      const lt = buf.indexOf(LT, at);
      if (lt < 0 || lt >= end) break;
      const closing = buf[lt + 1] === SLASH;
      const name = localName(buf, closing ? lt + 2 : lt + 1);
      const gt = buf.indexOf(GT, lt);
      const c1 = buf[name];
      const c2 = buf[name + 1];
      if (closing) {
        at = gt + 1;
      } else if (c1 === 0x76 /* v */ && (c2 === GT || (c2 === SPACE && buf[gt - 1] !== SLASH))) {
        // <v> or <v xml:space="preserve"> (Excel's form for a value with leading or trailing spaces).
        valueStart = gt + 1;
        valueEnd = buf.indexOf(LT, valueStart);
        at = valueEnd;
      } else if (c1 === 0x76 /* v */ && (c2 === SLASH || buf[gt - 1] === SLASH)) {
        // <v/>: an empty value, which is how Excel writes a formula's empty-string result.
        valueStart = valueEnd = gt;
        at = gt + 1;
      } else if (c1 === 0x66 /* f */ && (c2 === GT || c2 === SPACE || c2 === SLASH)) {
        formula = true;
        at = this.formula(buf, name + 1, gt);
      } else if (c1 === 0x74 /* t */ && (c2 === GT || c2 === SPACE || c2 === SLASH)) {
        // <t> inside <is> (or a rich run's <r><t>): its text is part of the inline string.
        if (buf[gt - 1] === SLASH) {
          (inline ??= []).push(gt, gt);
          at = gt + 1;
          continue;
        }
        const stop = buf.indexOf(LT, gt + 1);
        (inline ??= []).push(gt + 1, stop);
        at = stop;
      } else if (c1 === 0x72 /* rPh */ && c2 === 0x50) {
        // Phonetic hints (furigana) are not part of the text.
        const close = indexOfBytes(buf, RPH_END, gt + 1);
        at = close < 0 || close > end ? end : close + RPH_END.length;
      } else {
        at = gt + 1;
      }
    }
    if (this.cell.cm && !formula) this.cell.extra += ' cm="1"';
    this.store(buf, valueStart, valueEnd, inline);
  }

  /** A `<f ...>` tag whose attributes start at `at` and end at `gt`; returns where reading goes on. */
  private formula(buf: Uint8Array, at: number, gt: number): number {
    let kind = 'normal' as FormulaKind;
    let si = -1;
    let ref: string | undefined;
    let attrs = '';
    attributes(buf, at, buf[gt - 1] === SLASH ? gt - 1 : gt, (n0, n1, v0, v1) => {
      const length = n1 - n0;
      const first = buf[n0];
      if (length === 1 && first === 0x74 /* t */) {
        const v = buf[v0];
        kind = v === 0x73 ? 'shared' : v === 0x61 ? 'array' : v === 0x64 ? 'dataTable' : 'normal';
      } else if (length === 2 && first === 0x73 && buf[n0 + 1] === 0x69 /* si */) {
        si = digits(buf, v0, v1);
      } else if (length === 3 && first === 0x72 && buf[n0 + 1] === 0x65 /* ref */) {
        ref = latin(buf, v0, v1);
      } else {
        attrs += ' ' + latin(buf, n0, v1 + 1);
      }
    });
    let text = '';
    let next = gt + 1;
    if (buf[gt - 1] !== SLASH) {
      const stop = buf.indexOf(LT, gt + 1);
      text = this.decoder.decode(buf.subarray(gt + 1, stop));
      if (text.includes('&') || text.includes('_x')) text = unescapeXml(text);
      next = stop;
    }
    const { row, col, cm } = this.cell;
    const column = this.sheet.grid.column(col);
    const base = { kind, shared: -1, originRow: row, originCol: col, text, ...(ref && { ref }), ...(cm && { dynamic: true }), ...(attrs && { attrs }) };
    if (kind === 'shared' && si >= 0) {
      if (text) {
        this.shared.set(si, { text, row, col });
        column.addFormula(row, { ...base, shared: si });
      } else {
        const master = this.shared.get(si);
        if (master) column.addFormula(row, { ...base, text: master.text, originRow: master.row, originCol: master.col, shared: si, ref: undefined });
      }
    } else {
      column.addFormula(row, base);
    }
    return next;
  }

  private store(buf: Uint8Array, valueStart: number, valueEnd: number, inline: number[] | null = null): void {
    const { row, col, style, type, extra } = this.cell;
    const grid = this.sheet.grid;
    if (extra) this.sheet.cellAttrs.set(cellKey(row, col), extra);
    if (inline) {
      const id = inline.length === 2 ? this.strings.addEscaped(buf, inline[0], inline[1]) : this.strings.addEscapedPieces(buf, inline);
      grid.set(row, col, Kind.String, id, style);
      return;
    }
    if (valueStart < 0) {
      grid.set(row, col, Kind.Blank, 0, style);
      return;
    }
    switch (type) {
      case Type.Number:
        grid.set(row, col, Kind.Number, parseNumber(buf, valueStart, valueEnd), style);
        break;
      case Type.Shared:
        grid.set(row, col, Kind.String, digits(buf, valueStart, valueEnd), style);
        break;
      case Type.Bool:
        grid.set(row, col, Kind.Boolean, buf[valueStart] === 0x31 ? 1 : 0, style);
        break;
      case Type.Error: {
        const code = errorCode(this.decoder.decode(buf.subarray(valueStart, valueEnd)));
        grid.set(row, col, Kind.Error, code < 0 ? VALUE_ERROR : code, style);
        break;
      }
      case Type.Date: {
        // An ISO 8601 date (t="d", written by some generators, never by Excel): kept as its serial number.
        const serial = isoToSerial(latin(buf, valueStart, valueEnd));
        if (serial === null) grid.set(row, col, Kind.String, this.strings.addEscaped(buf, valueStart, valueEnd), style);
        else grid.set(row, col, Kind.Number, serial, style);
        break;
      }
      default:
        // A formula's text result (t="str").
        grid.set(row, col, Kind.String, this.strings.addEscaped(buf, valueStart, valueEnd), style);
    }
  }
}

/** Where a tag's local name starts (after a namespace prefix, if any), or -1 if the name runs past the buffer. */
function localName(buf: Uint8Array, at: number): number {
  for (let i = at; i < at + 16; i++) {
    const b = buf[i];
    if (b === undefined) return -1;
    if (b === COLON) return i + 1;
    if (b <= SPACE || b === GT || b === SLASH) return at;
  }
  return at;
}

/** Calls `found(nameStart, nameEnd, valueStart, valueEnd)` for each attribute in `buf[at, end)`. */
function attributes(buf: Uint8Array, at: number, end: number, found: (n0: number, n1: number, v0: number, v1: number) => void): void {
  let i = at;
  while (i < end) {
    while (i < end && buf[i] <= SPACE) i++;
    if (i >= end) return;
    const nameStart = i;
    while (i < end && buf[i] !== EQ && buf[i] > SPACE) i++;
    const nameEnd = i;
    while (i < end && buf[i] !== QUOT && buf[i] !== APOS) i++;
    const quote = buf[i];
    const start = i + 1;
    const stop = buf.indexOf(quote, start);
    if (stop < 0 || stop > end) return;
    found(nameStart, nameEnd, start, stop);
    i = stop + 1;
  }
}

const isTrue = (buf: Uint8Array, at: number): boolean => buf[at] === 0x31 || buf[at] === 0x74; /* 1 or true */

/** Bytes as Latin-1 text (attribute names and values the model keeps as written; ASCII in practice). */
function latin(buf: Uint8Array, start: number, stop: number): string {
  let text = '';
  for (let i = start; i < stop; i++) text += String.fromCharCode(buf[i]);
  return text;
}

/** A non-negative integer from ASCII digits. */
function digits(buf: Uint8Array, start: number, stop: number): number {
  let n = 0;
  for (let i = start; i < stop; i++) n = n * 10 + (buf[i] - 0x30);
  return n;
}

const POWERS = Array.from({ length: 23 }, (_, i) => 10 ** i);

/**
 * A number as Excel writes it. The common forms (an integer, or a decimal of up to 15 digits) are read here, exactly: the
 * digits make an integer below 2^53 and one division by an exact power of ten rounds correctly. Anything else (an exponent,
 * more digits) goes through Number().
 */
export function parseNumber(buf: Uint8Array, start: number, stop: number): number {
  let i = start;
  const negative = buf[i] === 0x2d;
  if (negative) i++;
  let n = 0;
  let count = 0;
  let scale = -1;
  for (; i < stop; i++) {
    const b = buf[i];
    if (b >= 0x30 && b <= 0x39) {
      n = n * 10 + (b - 0x30);
      count++;
    } else if (b === 0x2e && scale < 0) {
      scale = i;
    } else {
      break;
    }
  }
  if (i === stop && count > 0 && count <= 15) {
    const decimals = scale < 0 ? 0 : stop - scale - 1;
    const value = decimals ? n / POWERS[decimals] : n;
    return negative ? -value : value;
  }
  return Number(latin(buf, start, stop));
}

/** An ISO 8601 date or date-time to Excel's 1900 serial number, or null. */
export function isoToSerial(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/.exec(text);
  if (!m) return null;
  const days = Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86_400_000 + 25569;
  const serial = days < 61 ? days - 1 : days; // Excel's phantom 29 February 1900
  return serial + ((+(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) / 86400);
}

function indexOfBytes(buf: Uint8Array, needle: Uint8Array, at: number): number {
  for (;;) {
    const i = buf.indexOf(needle[0], at);
    if (i < 0 || i + needle.length > buf.length) return -1;
    let j = 1;
    while (j < needle.length && buf[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
    at = i + 1;
  }
}
