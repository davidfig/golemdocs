// Laying out one line of a big text file on a grid of cells, for drawing, caret placement and clicks. The text is monospace:
// every character takes one cell (0.6 em in JetBrains Mono), wide East-Asian characters two, combining marks none, and a tab
// runs to the next multiple of 8. A long line is broken after as many cells as fit (a row never starts with nothing on it).
// Positions are UTF-16 indices, as everywhere else in textEditor/.

/** Cells a tab stop is apart. */
export const TAB = 8;

/** Characters that draw as nothing and take no room, as inclusive [from, to] pairs: combining marks, zero-width joiners and variation selectors. */
const ZERO_RANGES = [
  0x0300, 0x036f, 0x0483, 0x0489, 0x0591, 0x05bd, 0x05bf, 0x05bf, 0x05c1, 0x05c2, 0x05c4, 0x05c5, 0x05c7, 0x05c7, 0x0610, 0x061a, 0x064b, 0x065f, 0x0670, 0x0670,
  0x06d6, 0x06dc, 0x06df, 0x06e4, 0x06e7, 0x06e8, 0x06ea, 0x06ed, 0x200b, 0x200f, 0x2028, 0x202e, 0x2060, 0x2064, 0x20d0, 0x20ff, 0xfe00, 0xfe0f, 0xfe20, 0xfe2f, 0xfeff, 0xfeff,
];

function isZeroWidth(cp: number): boolean {
  for (let i = 0; i < ZERO_RANGES.length; i += 2) if (cp >= ZERO_RANGES[i] && cp <= ZERO_RANGES[i + 1]) return true;
  return false;
}

/** The cells a code point takes: 0, 1, or 2 for the wide and fullwidth East-Asian characters and emoji. */
export function cellWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x300) return 1;
  if (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd))) return 2;
  return isZeroWidth(cp) ? 0 : 1;
}

/** One row of a laid-out line: the text [from, to) and how many cells it fills. */
export interface Row {
  from: number;
  to: number;
  cells: number;
}

/** Text that is plain printable ASCII lays out by arithmetic. */
const PLAIN = /^[\x20-\x7e]*$/;

/** The rows a line breaks into when `columns` cells fit across (at least one row, even for an empty line). */
export function layoutLine(text: string, columns: number): Row[] {
  columns = Math.max(1, Math.floor(columns));
  if (PLAIN.test(text)) {
    if (text.length <= columns) return [{ from: 0, to: text.length, cells: text.length }];
    const rows: Row[] = [];
    for (let from = 0; from < text.length; from += columns) rows.push({ from, to: Math.min(from + columns, text.length), cells: Math.min(columns, text.length - from) });
    return rows;
  }
  const rows: Row[] = [];
  let from = 0;
  let cells = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const length = cp > 0xffff ? 2 : 1;
    let width = cp === 9 ? TAB - (cells % TAB) : cellWidth(cp);
    // Break before a character that does not fit (but never leave a row empty).
    if (width > 0 && cells + width > columns && i > from) {
      rows.push({ from, to: i, cells });
      from = i;
      cells = 0;
      width = cp === 9 ? TAB : width;
    }
    cells += width;
    i += length;
  }
  rows.push({ from, to: text.length, cells });
  return rows;
}

/** How many rows a line takes, without making them (cheap for the plain lines that most are). */
export function rowCount(text: string, columns: number): number {
  columns = Math.max(1, Math.floor(columns));
  return PLAIN.test(text) ? Math.max(1, Math.ceil(text.length / columns)) : layoutLine(text, columns).length;
}

/** Calls `visit` for each character of a row with its UTF-16 index, code point, cell (from the row's start) and width in cells. */
export function forEachCell(text: string, row: Row, visit: (index: number, cp: number, cell: number, width: number) => void): void {
  let cell = 0;
  for (let i = row.from; i < row.to; ) {
    const cp = text.codePointAt(i)!;
    const width = cp === 9 ? TAB - (cell % TAB) : cellWidth(cp);
    visit(i, cp, cell, width);
    cell += width;
    i += cp > 0xffff ? 2 : 1;
  }
}

/** The cell (from the row's start) at which the character at UTF-16 `index` begins; the row's width for its end. */
export function cellAt(text: string, row: Row, index: number): number {
  if (index <= row.from) return 0;
  if (PLAIN.test(text)) return Math.min(index, row.to) - row.from;
  let found = row.cells;
  let cell = 0;
  for (let i = row.from; i < row.to; ) {
    if (i >= index) {
      found = cell;
      break;
    }
    const cp = text.codePointAt(i)!;
    cell += cp === 9 ? TAB - (cell % TAB) : cellWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return found;
}

/** The UTF-16 index of the character boundary nearest to a cell position (fractional cells allowed) in a row. */
export function indexAtCell(text: string, row: Row, target: number): number {
  if (target <= 0) return row.from;
  if (PLAIN.test(text)) return Math.min(row.from + Math.round(target), row.to);
  let cell = 0;
  for (let i = row.from; i < row.to; ) {
    const cp = text.codePointAt(i)!;
    const width = cp === 9 ? TAB - (cell % TAB) : cellWidth(cp);
    if (target < cell + width / 2) return i;
    cell += width;
    i += cp > 0xffff ? 2 : 1;
  }
  return row.to;
}

/** The row holding a UTF-16 index (the last row for its end; a break belongs to the row it starts). */
export function rowOf(rows: readonly Row[], index: number): number {
  for (let r = rows.length - 1; r > 0; r--) if (index >= rows[r].from) return r;
  return 0;
}
