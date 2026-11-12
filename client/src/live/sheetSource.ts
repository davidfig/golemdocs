// The spreadsheet producer (docs/live-blocks.md §2): a workbook's table, defined name, range or cell as a live block's result,
// with the sheet's number formats applied. Pure: the same bytes and address always give the same result.
//
// What follows the `#` of a workbook's address:
//   ''                     the active sheet, as far as it has cells
//   `Expenses`             a table (Format as Table) or a defined name of that name, tables first
//   `table:Expenses`       a table, by name only
//   `Summary!A1:D10`       a range of a sheet (`'Sheet name'!A1` when the name has spaces)
//   `A1:D10`, `B7`         a range or cell of the active sheet
// A single cell gives a value; anything wider a table.

import { Kind } from '../sheet/model/column.ts';
import { isWorksheet } from '../sheet/model/workbook.ts';
import type { Workbook } from '../sheet/model/workbook.ts';
import type { CellRange, Worksheet } from '../sheet/model/worksheet.ts';
import { displayText } from '../sheet/format/display.ts';
import { parseRange } from '../sheet/refs.ts';
import { loadSheet, readWorkbook } from '../sheet/xlsx/read.ts';
import { MAX_COLUMNS, MAX_ROWS } from './result.ts';
import type { Align, LiveResult } from './result.ts';


/** Where an address points in a workbook: a sheet, a range on it, and whether its first row is a header. */
interface Place {
  sheet: number;
  range: CellRange;
  header: boolean | 'guess';
}

const unquote = (name: string): string => (name.startsWith("'") && name.endsWith("'") ? name.slice(1, -1).replace(/''/g, "'") : name);

/** A sheet-qualified reference (`Summary!$A$1:$D$10`, `'My sheet'!B2`) or a bare one, as a sheet index and range. */
function reference(book: Workbook, text: string, fallback: number): { sheet: number; range: CellRange } | null {
  const bang = text.lastIndexOf('!');
  const sheetName = bang >= 0 ? unquote(text.slice(0, bang).trim()) : null;
  const range = parseRange(text.slice(bang + 1).replace(/\$/g, ''));
  if (!range) return null;
  const sheet = sheetName === null ? fallback : book.sheets.findIndex((s) => s.name.toLowerCase() === sheetName.toLowerCase());
  return sheet >= 0 ? { sheet, range } : null;
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

async function sheetAt(book: Workbook, index: number): Promise<Worksheet | null> {
  const sheet = book.sheets[index];
  if (!sheet || !isWorksheet(sheet)) return null;
  await loadSheet(book, index);
  return sheet;
}

/** Finds what the address names; an error message when it names nothing. */
async function place(book: Workbook, fragment: string): Promise<Place | Extract<LiveResult, { kind: 'error' }>> {
  const active = book.activeSheet;
  const wanted = fragment.trim();
  if (!wanted) {
    const sheet = await sheetAt(book, active);
    if (!sheet || !sheet.grid.rows) return { kind: 'error', code: 'empty' };
    return { sheet: active, range: { r0: 0, c0: 0, r1: sheet.grid.rows - 1, c1: Math.max(sheet.grid.cols - 1, 0) }, header: 'guess' };
  }
  const tableName = /^table:/i.test(wanted) ? wanted.slice(6) : wanted;
  // Tables are read with their sheet, so every sheet is read to look for one.
  for (let i = 0; i < book.sheets.length; i++) {
    const sheet = await sheetAt(book, i);
    const table = sheet?.tables.find((t) => same(t.name, tableName) || same(t.displayName, tableName));
    if (table) return { sheet: i, range: table.range, header: table.header };
  }
  if (/^table:/i.test(wanted)) return { kind: 'error', code: 'noTable', detail: tableName };
  const name = book.names.find((n) => same(n.name, wanted) && n.sheet === undefined) ?? book.names.find((n) => same(n.name, wanted));
  if (name) {
    const ref = reference(book, name.formula, name.sheet ?? active);
    return ref ? { ...ref, header: 'guess' } : { kind: 'error', code: 'notRange', detail: name.name };
  }
  const ref = reference(book, wanted, active);
  return ref ? { ...ref, header: 'guess' } : { kind: 'error', code: 'notFound', detail: wanted };
}

/** Whether rows look like they start with a header: text over a column that is mostly numbers below it. */
function looksLikeHeader(kinds: Kind[][]): boolean {
  if (kinds.length < 2) return false;
  const first = kinds[0];
  if (!first.some((k) => k === Kind.String) || first.some((k) => k === Kind.Number)) return false;
  return first.some((_, c) => kinds.slice(1).some((row) => row[c] === Kind.Number)) || kinds.length > 2;
}

/** The result for a workbook (as bytes) and the part of the address after `#`. */
export async function sheetResult(bytes: Uint8Array, fragment: string): Promise<LiveResult> {
  let book: Workbook;
  try {
    book = await readWorkbook(bytes, { structureOnly: true });
  } catch (e) {
    return { kind: 'error', code: 'unreadable', detail: e instanceof Error ? e.message : undefined };
  }
  const where = await place(book, fragment);
  if ('kind' in where) return where;
  const sheet = await sheetAt(book, where.sheet);
  if (!sheet) return { kind: 'error', code: 'notSheet' };
  const { r0, c0 } = where.range;
  const r1 = Math.min(where.range.r1, r0 + MAX_ROWS - 1);
  const c1 = Math.min(where.range.c1, c0 + MAX_COLUMNS - 1);
  const rows = Array.from({ length: r1 - r0 + 1 }, () => Array<string>(c1 - c0 + 1).fill(''));
  const kinds = Array.from({ length: r1 - r0 + 1 }, () => Array<Kind>(c1 - c0 + 1).fill(Kind.Empty));
  const aligned = Array.from({ length: c1 - c0 + 1 }, () => ({ left: 0, center: 0, right: 0 }));
  for (let c = c0; c <= c1; c++) {
    sheet.grid.columns[c]?.forEach(r0, r1 + 1, (row, kind, value, style) => {
      rows[row - r0][c - c0] = displayText(book, kind, value, style, 255).text;
      kinds[row - r0][c - c0] = kind;
      const horizontal = book.styles.format(style)?.alignment?.horizontal;
      const align: Align = horizontal === 'center' || horizontal === 'centerContinuous' ? 'center' : horizontal === 'right' ? 'right' : horizontal === 'left' ? 'left' : kind === Kind.Number ? 'right' : 'left';
      if (row > r0 || where.range.r0 === where.range.r1) aligned[c - c0][align]++;
    });
  }
  if (r0 === r1 && c0 === c1) return { kind: 'value', text: rows[0][0] };
  const header = where.header === 'guess' ? looksLikeHeader(kinds) : where.header;
  const align = aligned.map((n): Align => (n.right > n.left && n.right >= n.center ? 'right' : n.center > n.left ? 'center' : 'left'));
  return { kind: 'table', rows, header, align };
}
