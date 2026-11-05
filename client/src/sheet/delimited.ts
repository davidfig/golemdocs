// CSV and TSV files in the grid (docs/spreadsheets.md, decision 2): read into a workbook of one sheet (named after the file,
// each value as if typed, so numbers, dates and formulas come in as Excel brings them in), and written back as the file they
// were: the active sheet's values as shown, with the file's delimiter, encoding, line endings and final line ending.
// Formulas, other sheets and formatting are not kept by such a file: `lossy` says when something was left out. How the sheet
// is laid out (column widths and the like) is kept beside the file in the account (`sheetLayout`, formats/wdocDelimited.ts).

import { DelimitedReader, sniffDelimiter, writeDelimited } from '../formats/csv.ts';
import type { SheetLayout } from '../formats/wdoc.ts';
import { decodeText } from '../formats/textFiles.ts';
import type { TextEncoding } from '../formats/textFiles.ts';
import { applyEdit } from './edit.ts';
import { restyle } from './format/styleChange.ts';
import { displayText } from './format/display.ts';
import { Kind } from './model/column.ts';
import { Workbook, isWorksheet } from './model/workbook.ts';
import { Worksheet } from './model/worksheet.ts';

export type DelimitedKind = 'csv' | 'tsv';

/** How the file was written, to write it back the same way. */
export interface DelimitedFormat {
  kind: DelimitedKind;
  delimiter: string;
  encoding: TextEncoding;
  bom: boolean;
  lineEnding: '\n' | '\r\n' | '\r';
  trailingNewline: boolean;
  /** How many fields each row had, so a row keeps its empty fields at the end (a file written back unchanged is the same). */
  widths: number[];
}

/** A sheet name from a file name: its stem, without the characters a sheet name may not have, at most 31 long. */
export function sheetNameOf(fileName: string): string {
  const stem = fileName.replace(/\.[^.]*$/, '').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31).replace(/^'|'$/g, '');
  return stem || 'Sheet1';
}

export function readDelimited(bytes: Uint8Array, fileName: string, kind: DelimitedKind): { book: Workbook; format: DelimitedFormat } {
  const load = new DelimitedLoad(bytes, fileName, kind);
  while (load.step(DELIMITED_BATCH));
  return { book: load.book, format: load.format };
}

/** Rows read into the sheet at a time: a large file shows its first rows at once, then grows as the rest comes in. */
export const DELIMITED_BATCH = 16384;

/** A CSV or TSV file being read into its workbook a batch of rows at a time (`step`), so the rows read so far can be shown. */
export class DelimitedLoad {
  readonly book = new Workbook();
  readonly format: DelimitedFormat;
  /** Rows read so far. */
  rows = 0;
  private readonly sheet: Worksheet;
  private readonly reader: DelimitedReader;
  private readonly length: number;
  private readonly formats = new Map<string, number>();

  constructor(bytes: Uint8Array, fileName: string, kind: DelimitedKind) {
    const { text, encoding, bom } = decodeText(bytes);
    const delimiter = kind === 'tsv' ? '\t' : sniffDelimiter(text);
    this.reader = new DelimitedReader(text, delimiter);
    this.length = text.length;
    this.sheet = new Worksheet(sheetNameOf(fileName), 1);
    this.book.sheets.push(this.sheet);
    this.format = { kind, delimiter, encoding, bom, lineEnding: '\n', trailingNewline: false, widths: [] };
  }

  /** Reads up to `count` more rows into the sheet; false once the whole file is in. */
  step(count: number): boolean {
    const batch: string[][] = [];
    for (let row = batch.length < count ? this.reader.next() : null; row; row = batch.length < count ? this.reader.next() : null) batch.push(row);
    if (batch.length) {
      applyEdit(this.book, 0, { kind: 'paste', at: { row: this.rows, col: 0 }, rows: batch });
      batch.forEach((fields, i) => this.keepAsWritten(this.rows + i, fields));
      for (const fields of batch) this.format.widths.push(fields.length);
      this.rows += batch.length;
    }
    const more = this.reader.position < this.length;
    if (!more) {
      this.format.lineEnding = this.reader.lineEnding ?? '\n';
      this.format.trailingNewline = this.reader.trailingNewline;
    }
    this.sheet.dirty = { cells: false, layout: false };
    this.book.dirty = false;
    return more;
  }

  /**
   * Every value shows as it was written, so a file written back unchanged is the same: a number whose zeros the General
   * format would drop (1.50, 00123) gets a format that keeps them, as one keeps them in Excel; anything else that would
   * not show the same (a 20-digit number) stays text. Formulas are calculated, as Excel does.
   */
  private keepAsWritten(row: number, fields: string[]): void {
    const { book, sheet } = this;
    fields.forEach((field, col) => {
      const column = sheet.grid.columns[col];
      if (!column || column.formulaAt(row)) return;
      const kind = column.kind(row);
      if (kind === Kind.Empty || kind === Kind.Blank || kind === Kind.String) return;
      const shows = (style: number) => displayText(book, kind, column.value(row), style, 32767).text === field;
      if (shows(column.style(row))) return;
      if (kind === Kind.Number) {
        const zeros = /^-?(\d+)\.(\d+)$/.exec(field) ?? /^(0\d+)$/.exec(field);
        const code = zeros ? (zeros[2] !== undefined ? `0.${'0'.repeat(zeros[2].length)}` : '0'.repeat(zeros[1].length)) : null;
        if (code && shows(this.styleFor(code))) {
          sheet.grid.set(row, col, Kind.Number, column.value(row), this.styleFor(code));
          return;
        }
      }
      sheet.grid.set(row, col, Kind.String, book.strings.add(field), 0);
    });
  }

  private styleFor(code: string): number {
    let style = this.formats.get(code);
    if (style === undefined) this.formats.set(code, (style = restyle(this.book.styles, 0, { numFmt: code }, { top: false, bottom: false, left: false, right: false }, null)));
    return style;
  }
}

/** The active sheet as the file, and whether anything the file cannot hold was left out (other sheets, formulas, charts). */
export function writeDelimitedSheet(book: Workbook, format: DelimitedFormat): { bytes: Uint8Array; lossy: boolean } {
  const sheet = book.sheets[book.activeSheet];
  if (!sheet || !isWorksheet(sheet)) return { bytes: new Uint8Array(0), lossy: book.sheets.length > 1 };
  const grid = sheet.grid;
  const rows: string[][] = Array.from({ length: grid.rows }, () => Array<string>(grid.cols).fill(''));
  let formulas = false;
  for (let c = 0; c < grid.cols; c++) {
    const column = grid.columns[c];
    if (!column) continue;
    if (column.formulas.length) formulas = true;
    column.forEach(0, grid.rows, (row, kind, value, style) => {
      if (kind === Kind.Empty || kind === Kind.Blank) return;
      rows[row][c] = displayText(book, kind, value, style, 32767).text;
    });
  }
  // Each row as long as its last value, or as it was in the file if that was longer (a row with nothing is one empty field).
  const trimmed = rows.map((r, i) => {
    let end = r.length;
    while (end > 0 && r[end - 1] === '') end--;
    return Array.from({ length: Math.max(end, format.widths[i] ?? 0, 1) }, (_, c) => r[c] ?? '');
  });
  const bytes = writeDelimited(trimmed, format.delimiter, {
    ...(format.encoding !== 'utf-8' && { encoding: format.encoding }),
    ...(format.lineEnding !== '\n' && { lineEnding: format.lineEnding }),
    ...(!format.trailingNewline && { trailingNewline: false as const }),
    bom: format.bom,
  });
  return { bytes, lossy: formulas || book.sheets.length > 1 || sheet.charts.length > 0 };
}

/**
 * How the active sheet is laid out, or null when it is as a file opens by default. Rows hidden are left out: a filter hides
 * them, and it isn't kept, so they could not be got back.
 */
export function sheetLayout(book: Workbook): SheetLayout | null {
  const sheet = book.sheets[book.activeSheet];
  if (!sheet || !isWorksheet(sheet)) return null;
  const layout: SheetLayout = {};
  const columns: [number, number][] = [];
  const hiddenColumns: number[] = [];
  for (const i of sheet.colSizes.uniform ? [] : sheet.colSizes.specials()) {
    if (sheet.colSizes.custom(i)) columns.push([i, sheet.colSizes.ownSize(i)]);
    if (sheet.colSizes.hidden(i)) hiddenColumns.push(i);
  }
  const rows: [number, number][] = [];
  for (const i of sheet.rowSizes.uniform ? [] : sheet.rowSizes.specials()) if (sheet.rowSizes.custom(i)) rows.push([i, sheet.rowSizes.ownSize(i)]);
  if (columns.length) layout.columns = columns;
  if (rows.length) layout.rows = rows;
  if (hiddenColumns.length) layout.hiddenColumns = hiddenColumns;
  if (sheet.pane) layout.frozen = { rows: sheet.pane.rows, cols: sheet.pane.cols };
  return Object.keys(layout).length ? layout : null;
}

/** Lays the sheet out as it was. It came from a file, so anything out of range or that isn't a size is passed over. */
export function applySheetLayout(sheet: Worksheet, layout: SheetLayout): void {
  const index = (i: unknown, count: number) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < count;
  const size = (s: unknown) => typeof s === 'number' && Number.isFinite(s) && s > 0;
  for (const [i, width] of layout.columns ?? []) if (index(i, sheet.colSizes.count) && size(width)) sheet.colSizes.set(i, width);
  for (const [i, height] of layout.rows ?? []) if (index(i, sheet.rowSizes.count) && size(height)) sheet.rowSizes.set(i, height);
  for (const i of layout.hiddenColumns ?? []) if (index(i, sheet.colSizes.count)) sheet.colSizes.setHidden(i, true);
  const frozen = layout.frozen;
  if (frozen && index(frozen.rows, sheet.rowSizes.count) && index(frozen.cols, sheet.colSizes.count) && (frozen.rows || frozen.cols)) sheet.pane = { rows: frozen.rows, cols: frozen.cols };
}
