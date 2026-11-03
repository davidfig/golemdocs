// The clipboard for cells (docs/spreadsheets.md, "The editor"): a range goes out as tab-separated text and as an HTML
// table (so pasting into a document makes a table, and into Excel or another sheet keeps the cells apart); text comes in
// as rows of cells, from tab-separated text or an HTML table.

import { MAX_COLUMNS, MAX_ROWS } from './model/column.ts';
import type { Workbook } from './model/workbook.ts';
import type { CellRange, Worksheet } from './model/worksheet.ts';
import { displayText } from './format/display.ts';

/** The most cells one copy takes: past this the text would be too big for the clipboard to be any use. */
export const MAX_COPY_CELLS = 2_000_000;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function copyRange(book: Workbook, sheet: Worksheet, range: CellRange): { text: string; html: string } {
  const r1 = Math.min(range.r1, Math.max(range.r0, sheet.grid.rows - 1), MAX_ROWS - 1);
  const c1 = Math.min(range.c1, Math.max(range.c0, sheet.grid.cols - 1), MAX_COLUMNS - 1);
  if ((r1 - range.r0 + 1) * (c1 - range.c0 + 1) > MAX_COPY_CELLS) throw new Error('tooManyToCopy');
  const rows: string[][] = Array.from({ length: r1 - range.r0 + 1 }, () => Array<string>(c1 - range.c0 + 1).fill(''));
  for (let c = range.c0; c <= c1; c++) {
    sheet.grid.columns[c]?.forEach(range.r0, r1 + 1, (row, kind, value, style) => {
      rows[row - range.r0][c - range.c0] = displayText(book, kind, value, style, 255).text;
    });
  }
  // A cell with a tab, newline or quote is quoted, as Excel does.
  const quote = (s: string) => (/[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const text = rows.map((r) => r.map(quote).join('\t')).join('\r\n') + '\r\n';
  const html = `<table>${rows.map((r) => `<tr>${r.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</table>`;
  return { text, html };
}

/** Rows of cells from tab-separated text (quoted cells may hold tabs, newlines and doubled quotes). */
export function parseTabbed(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let i = 0;
  const end = text.length;
  while (i < end) {
    const ch = text[i];
    if (ch === '"' && cell === '') {
      // A quoted cell runs to the closing quote.
      let j = i + 1;
      let value = '';
      while (j < end) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          j++;
          break;
        }
        value += text[j++];
      }
      // Not followed by a separator: it was not a quoted cell after all.
      if (j < end && text[j] !== '\t' && text[j] !== '\n' && text[j] !== '\r') {
        cell += ch;
        i++;
        continue;
      }
      cell = value;
      i = j;
      continue;
    }
    if (ch === '\t') {
      row.push(cell);
      cell = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      cell += ch;
      i++;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Rows of cells from the first table in HTML (the page parses it; this is the shape it is given in). */
export function rowsFromTable(table: { rows: ArrayLike<{ cells: ArrayLike<{ textContent: string | null; colSpan?: number }> }> }): string[][] {
  const out: string[][] = [];
  for (let r = 0; r < table.rows.length; r++) {
    const row: string[] = [];
    const cells = table.rows[r].cells;
    for (let c = 0; c < cells.length; c++) {
      row.push((cells[c].textContent ?? '').trim());
      for (let span = 1; span < (cells[c].colSpan ?? 1); span++) row.push('');
    }
    out.push(row);
  }
  return out;
}
