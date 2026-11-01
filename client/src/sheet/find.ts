// Find in a workbook (Edit › Find): the next cell after `from`, by rows as Excel searches, whose shown value (or formula)
// contains the text, wraps around the sheet, and goes on to the other sheets when asked.

import { Kind, MAX_COLUMNS } from './model/column.ts';
import { isWorksheet } from './model/workbook.ts';
import type { Workbook } from './model/workbook.ts';
import type { Worksheet } from './model/worksheet.ts';
import { displayText } from './format/display.ts';
import { fromFileFormula } from './formula/fileNames.ts';

export interface FindRequest {
  sheet: number;
  text: string;
  from: { row: number; col: number };
  backwards: boolean;
  matchCase: boolean;
  wholeCell: boolean;
  formulas: boolean;
  allSheets: boolean;
}

export function findNext(book: Workbook, request: FindRequest): { sheet: number; row: number; col: number } | null {
  if (!request.text) return null;
  const needle = request.matchCase ? request.text : request.text.toLowerCase();
  const order = request.allSheets ? book.sheets.map((_, i) => (request.sheet + (request.backwards ? -i : i) + book.sheets.length) % book.sheets.length) : [request.sheet];
  for (const [k, index] of order.entries()) {
    const sheet = book.sheets[index];
    if (!sheet || !isWorksheet(sheet)) continue;
    const hits = matches(book, sheet, needle, request);
    if (!hits.length) continue;
    // Cells in reading order (row, then column): the first after `from`, or the first at all, wrapping round.
    const key = (h: { row: number; col: number }) => h.row * MAX_COLUMNS + h.col;
    const from = key(request.from);
    hits.sort((a, b) => key(a) - key(b));
    const first = k === 0 ? (request.backwards ? [...hits].reverse().find((h) => key(h) < from) : hits.find((h) => key(h) > from)) : undefined;
    const pick = first ?? (k === 0 && !request.allSheets ? (request.backwards ? hits[hits.length - 1] : hits[0]) : k > 0 ? (request.backwards ? hits[hits.length - 1] : hits[0]) : undefined);
    if (pick) return { sheet: index, ...pick };
    if (!request.allSheets) return null;
  }
  // Only the starting sheet matched, before `from`: wrap within it.
  if (request.allSheets) {
    const sheet = book.sheets[request.sheet];
    if (sheet && isWorksheet(sheet)) {
      const hits = matches(book, sheet, needle, request);
      if (hits.length) return { sheet: request.sheet, ...hits[request.backwards ? hits.length - 1 : 0] };
    }
  }
  return null;
}

function matches(book: Workbook, sheet: Worksheet, needle: string, request: FindRequest): { row: number; col: number }[] {
  const hits: { row: number; col: number }[] = [];
  sheet.grid.columns.forEach((column, col) => {
    column?.forEach(0, sheet.grid.rows, (row, kind, value, style) => {
      if (kind === Kind.Blank) return;
      const run = request.formulas ? column.formulaAt(row) : undefined;
      let text = run ? '=' + fromFileFormula(run.text) : displayText(book, kind, value, style, 255).text;
      if (!request.matchCase) text = text.toLowerCase();
      if (request.wholeCell ? text === needle : text.includes(needle)) hits.push({ row, col });
    });
  });
  return hits;
}
