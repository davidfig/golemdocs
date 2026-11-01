// Cell references as people and files write them ("B3", "A1:C10", "$A$1"), to and from the model's 0-based rows and columns.

import { columnIndex, columnName } from './model/column.ts';
import type { CellRange } from './model/worksheet.ts';

/** "B3" to {row: 2, col: 1}; null if it is not a cell reference. */
export function parseCell(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim());
  if (!m) return null;
  return { row: +m[2] - 1, col: columnIndex(m[1]) };
}

/** "A1:B3" (or "A1") to a range. */
export function parseRange(ref: string): CellRange | null {
  const [a, b] = ref.split(':');
  const start = parseCell(a);
  const end = b ? parseCell(b) : start;
  if (!start || !end) return null;
  return { r0: Math.min(start.row, end.row), c0: Math.min(start.col, end.col), r1: Math.max(start.row, end.row), c1: Math.max(start.col, end.col) };
}

export const cellName = (row: number, col: number): string => `${columnName(col)}${row + 1}`;
export const rangeName = (r: CellRange): string => (r.r0 === r.r1 && r.c0 === r.c1 ? cellName(r.r0, r.c0) : `${cellName(r.r0, r.c0)}:${cellName(r.r1, r.c1)}`);
