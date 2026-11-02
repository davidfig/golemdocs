// CSV and TSV files in the grid (docs/spreadsheets.md, decision 2): read into a workbook of one sheet (named after the file,
// each value as if typed, so numbers, dates and formulas come in as Excel brings them in), and written back as the file they
// were: the active sheet's values as shown, with the file's delimiter, encoding, line endings and final line ending.
// Formulas, other sheets and formatting are not kept by such a file: `lossy` says when something was left out.

import { parseDelimited, sniffDelimiter, writeDelimited } from '../formats/csv.ts';
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
  const { text, encoding, bom } = decodeText(bytes);
  const delimiter = kind === 'tsv' ? '\t' : sniffDelimiter(text);
  const parsed = parseDelimited(text, delimiter);
  const book = new Workbook();
  book.sheets.push(new Worksheet(sheetNameOf(fileName), 1));
  if (parsed.rows.length) applyEdit(book, 0, { kind: 'paste', at: { row: 0, col: 0 }, rows: parsed.rows });
  const sheet = book.sheets[0] as Worksheet;
  // Every value shows as it was written, so a file written back unchanged is the same: a number whose zeros the General
  // format would drop (1.50, 00123) gets a format that keeps them, as one keeps them in Excel; anything else that would
  // not show the same (a 20-digit number) stays text. Formulas are calculated, as Excel does.
  const formats = new Map<string, number>();
  const styleFor = (code: string) => {
    let style = formats.get(code);
    if (style === undefined) formats.set(code, (style = restyle(book.styles, 0, { numFmt: code }, { top: false, bottom: false, left: false, right: false }, null)));
    return style;
  };
  parsed.rows.forEach((fields, row) =>
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
        if (code && shows(styleFor(code))) {
          sheet.grid.set(row, col, Kind.Number, column.value(row), styleFor(code));
          return;
        }
      }
      sheet.grid.set(row, col, Kind.String, book.strings.add(field), 0);
    }),
  );
  sheet.dirty = { cells: false, layout: false };
  book.dirty = false;
  return { book, format: { kind, delimiter, encoding, bom, lineEnding: parsed.lineEnding, trailingNewline: parsed.trailingNewline, widths: parsed.rows.map((r) => r.length) } };
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
