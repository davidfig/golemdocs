// Pasting cells copied in the same workbook (Edit › Paste, Sheet › Paste Special): values, formulas (their relative
// references moved as if copied), and looks, or only some of them, and rows and columns swapped (transpose). Text from
// elsewhere is pasted as typed instead (the `paste` edit).

import { Kind, MAX_COLUMNS, MAX_ROWS } from './model/column.ts';
import type { FormulaRun } from './model/column.ts';
import type { Workbook } from './model/workbook.ts';
import { isWorksheet } from './model/workbook.ts';
import type { CellRange, Worksheet } from './model/worksheet.ts';
import { shiftFormula } from './formula/shift.ts';
import { joinRuns } from './fill.ts';

export type PasteWhat = 'all' | 'values' | 'formulas' | 'formats';

interface Copied {
  kind: Kind;
  value: number;
  style: number;
  /** The formula as written in its cell, and whether it is dynamic. */
  formula: { text: string; dynamic: boolean } | null;
}

/** The range a paste fills: the source's size (swapped for transpose) from `at`, clipped to the sheet. */
export function pasteTarget(source: CellRange, at: { row: number; col: number }, transpose: boolean): CellRange {
  const rows = transpose ? source.c1 - source.c0 + 1 : source.r1 - source.r0 + 1;
  const cols = transpose ? source.r1 - source.r0 + 1 : source.c1 - source.c0 + 1;
  return { r0: at.row, c0: at.col, r1: Math.min(MAX_ROWS - 1, at.row + rows - 1), c1: Math.min(MAX_COLUMNS - 1, at.col + cols - 1) };
}

export function pasteCells(book: Workbook, fromSheet: number, source: CellRange, target: Worksheet, at: { row: number; col: number }, what: PasteWhat, transpose: boolean): CellRange | null {
  const from = book.sheets[fromSheet];
  if (!from || !isWorksheet(from)) return null;
  // Read every source cell first: the source and the target may overlap.
  const cells: Copied[][] = [];
  for (let r = source.r0; r <= source.r1; r++) {
    const row: Copied[] = [];
    for (let c = source.c0; c <= source.c1; c++) {
      const column = from.grid.columns[c];
      const run = column?.formulaAt(r);
      row.push({
        kind: column?.kind(r) ?? Kind.Empty,
        value: column?.value(r) ?? 0,
        style: column?.style(r) ?? 0,
        formula: run ? { text: r === run.originRow && c === run.originCol ? run.text : shiftFormula(run.text, r - run.originRow, c - run.originCol), dynamic: !!run.dynamic } : null,
      });
    }
    cells.push(row);
  }
  const range = pasteTarget(source, at, transpose);
  const grid = target.grid;
  const placed = new Map<number, FormulaRun[]>();
  for (let r = range.r0; r <= range.r1; r++) {
    for (let c = range.c0; c <= range.c1; c++) {
      const i = transpose ? c - range.c0 : r - range.r0;
      const j = transpose ? r - range.r0 : c - range.c0;
      const cell = cells[i][j];
      const column = grid.column(c);
      const style = what === 'values' || what === 'formulas' ? column.style(r) : cell.style;
      if (what === 'formats') {
        grid.set(r, c, column.kind(r) === Kind.Empty && style ? Kind.Blank : column.kind(r), column.value(r), style);
        continue;
      }
      const formula = what !== 'values' && cell.formula;
      if (formula) {
        // Moved as copied: by the distance from where it was to where it goes.
        const text = shiftFormula(formula.text, r - (source.r0 + i), c - (source.c0 + j));
        const runs = placed.get(c) ?? [];
        runs.push({ text, first: r, last: r, originRow: r, originCol: c, kind: 'normal', shared: -1, ...(formula.dynamic && { dynamic: true }) });
        placed.set(c, runs);
      }
      const kind = cell.kind === Kind.Empty && style ? Kind.Blank : cell.kind;
      grid.set(r, c, kind, cell.value, style);
    }
  }
  if (what !== 'formats') {
    for (let c = range.c0; c <= range.c1; c++) {
      const column = grid.column(c);
      column.setFormulas(range.r0, range.r1, null);
      const runs = placed.get(c);
      if (runs) column.formulas = joinRuns([...column.formulas, ...runs].sort((a, b) => a.first - b.first));
    }
  }
  return range;
}
