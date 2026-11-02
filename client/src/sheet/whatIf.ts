// What-if analysis (docs/spreadsheets.md, M6). Goal Seek: the value of one cell (a constant) that makes a formula's value
// come to a goal. Tried in the worker against the engine itself: the cell is set, the sheet recalculated and the formula
// read, as Excel's Goal Seek does; the cell is put back afterwards, and the page applies the answer as an ordinary edit.
// Data tables (What-If › Data Table, Excel's {=TABLE()}): each cell of one is its formula's value with the input cells set
// to its row's and column's values, worked out the same way after every recalculation.

import type { Engine } from './formula/engine.ts';
import { Kind, columnName } from './model/column.ts';
import type { FormulaRun } from './model/column.ts';
import type { Workbook } from './model/workbook.ts';
import { isWorksheet } from './model/workbook.ts';
import type { CellRange, Worksheet } from './model/worksheet.ts';
import { parseRange, rangeName } from './refs.ts';
import { scenarioSummary } from './scenarios.ts';
import type { SummaryLabels, SummaryValue } from './scenarios.ts';

/** Excel's Goal Seek stops within this of the goal (Options › Formulas › Maximum Change), after at most this many tries. */
export const GOAL_SEEK_CHANGE = 0.001;
const MAX_TRIES = 100;

export interface GoalSeekResult {
  /** Whether a value brings the formula within `GOAL_SEEK_CHANGE` of the goal. */
  found: boolean;
  /** The changing cell's value found (the closest tried, when none is close enough). */
  value: number;
  /** The formula's value with it. */
  result: number | null;
  /** Why it could not start: the target holds no formula, the changing cell holds one. */
  message?: 'goalSeekTarget' | 'goalSeekChanging';
}

/**
 * The value of the changing cell that makes the target's formula equal `goal`. Secant steps from the cell's value; if they
 * fail, steps out on both sides until the formula crosses the goal, then halves the gap.
 */
export function goalSeek(engine: Engine, sheet: Worksheet, sheetIndex: number, target: { row: number; col: number }, goal: number, changing: { row: number; col: number }): GoalSeekResult {
  const grid = sheet.grid;
  if (!grid.columns[target.col]?.formulaAt(target.row)) return { found: false, value: 0, result: null, message: 'goalSeekTarget' };
  const column = grid.columns[changing.col];
  if (column?.formulaAt(changing.row)) return { found: false, value: 0, result: null, message: 'goalSeekChanging' };
  const kind = column?.kind(changing.row) ?? Kind.Empty;
  const raw = column?.value(changing.row) ?? 0;
  const style = column?.style(changing.row) ?? sheet.rowStyles.get(changing.row) ?? sheet.colStyles.get(changing.col) ?? 0;
  const box = { sheet: sheetIndex, r0: changing.row, c0: changing.col, r1: changing.row, c1: changing.col };
  let tries = 0;
  let best = { x: kind === Kind.Number ? raw : 0, f: NaN };
  /** The formula's distance from the goal with the cell at x (NaN for an error or text). */
  const f = (x: number): number => {
    tries++;
    grid.set(changing.row, changing.col, Kind.Number, x, style);
    engine.recalculate([box]);
    const v = engine.value(sheetIndex, target.row, target.col);
    const d = typeof v === 'number' && Number.isFinite(v) ? v - goal : NaN;
    if (!Number.isNaN(d) && (Number.isNaN(best.f) || Math.abs(d) < Math.abs(best.f))) best = { x, f: d };
    return d;
  };
  const close = (d: number) => Math.abs(d) <= 1e-12 * Math.max(1, Math.abs(goal));
  try {
    // Secant steps.
    let x0 = best.x;
    let f0 = f(x0);
    let x1 = x0 === 0 ? 0.01 : x0 * 1.01;
    let f1 = f(x1);
    while (tries < MAX_TRIES / 2 && !close(best.f)) {
      if (Number.isNaN(f0) || Number.isNaN(f1) || f1 === f0) break;
      const x2 = x1 - (f1 * (x1 - x0)) / (f1 - f0);
      if (!Number.isFinite(x2)) break;
      [x0, f0, x1, f1] = [x1, f1, x2, f(x2)];
    }
    if (!close(best.f)) {
      // Out on both sides of the best value so far until the formula crosses the goal, then halving.
      const from = best.x;
      const fFrom = Number.isNaN(best.f) ? f(from) : best.f;
      let bracket: [number, number, number, number] | null = null;
      for (let step = Math.max(Math.abs(from), 1) * 0.01; !bracket && tries < MAX_TRIES * 0.8 && step < 1e300; step *= 2) {
        for (const x of [from + step, from - step]) {
          const d = f(x);
          if (!Number.isNaN(d) && !Number.isNaN(fFrom) && Math.sign(d) !== Math.sign(fFrom)) {
            bracket = x < from ? [x, d, from, fFrom] : [from, fFrom, x, d];
            break;
          }
        }
      }
      if (bracket) {
        let [a, fa, b] = bracket;
        while (tries < MAX_TRIES * 3 && !close(best.f)) {
          const m = (a + b) / 2;
          const fm = f(m);
          if (Number.isNaN(fm) || m === a || m === b) break;
          if (Math.sign(fm) === Math.sign(fa)) [a, fa] = [m, fm];
          else b = m;
        }
      }
    }
  } finally {
    grid.set(changing.row, changing.col, kind, raw, style);
    engine.recalculate([box]);
  }
  const found = !Number.isNaN(best.f) && Math.abs(best.f) <= GOAL_SEEK_CHANGE;
  return { found, value: best.x, result: Number.isNaN(best.f) ? null : best.f + goal };
}

// --- Data tables ------------------------------------------------------------------------------------------------------

type Cell = { row: number; col: number };

/**
 * A data table: its results (`range`, the cells under and right of its headers) and its input cells. With one input
 * (`rowInput` for a table across, else `colInput` for one down), the input's values are its first row or column outside
 * `range` and its formulas the other; with two, its formula is the corner cell, the row input takes the values across and
 * the column input those down. As saved: `<f t="dataTable" ref dt2D dtr r1 r2>` on the first result cell (r1 the row
 * input when `dtr`, r2 the column input of a two-input table).
 */
export interface DataTable {
  range: CellRange;
  rowInput: Cell | null;
  colInput: Cell | null;
}

const cellOf = (ref: string | undefined): Cell | null => {
  const r = ref ? parseRange(ref.replace(/\$/g, '')) : null;
  return r ? { row: r.r0, col: r.c0 } : null;
};

/** A data table as its formula run says. */
export function dataTableOf(run: FormulaRun): DataTable | null {
  const range = run.ref ? parseRange(run.ref) : null;
  if (!range || range.r0 < 1 || range.c0 < 1) return null;
  const a: Record<string, string> = {};
  for (const m of (run.attrs ?? '').matchAll(/(\w+)="([^"]*)"/g)) a[m[1]] = m[2];
  const on = (v: string | undefined) => v === '1' || v === 'true';
  const r1 = cellOf(a.r1);
  const r2 = cellOf(a.r2);
  if (on(a.dt2D)) return on(a.dtr) ? { range, rowInput: r1, colInput: r2 } : { range, rowInput: r2, colInput: r1 };
  return on(a.dtr) ? { range, rowInput: r1, colInput: null } : { range, rowInput: null, colInput: r1 };
}

/** The formula run a new data table is saved as (on its range's first cell). */
export function dataTableRun(table: DataTable): Omit<FormulaRun, 'first' | 'last'> {
  const name = (c: Cell) => `${columnName(c.col)}${c.row + 1}`;
  const attrs =
    table.rowInput && table.colInput
      ? ` dt2D="1" dtr="1" r1="${name(table.rowInput)}" r2="${name(table.colInput)}"`
      : table.rowInput
        ? ` dt2D="0" dtr="1" r1="${name(table.rowInput)}"`
        : ` dt2D="0" dtr="0" r1="${name(table.colInput!)}"`;
  return { kind: 'dataTable', shared: -1, text: '', originRow: table.range.r0, originCol: table.range.c0, ref: rangeName(table.range), attrs };
}

/** A sheet's data tables. */
export function dataTables(sheet: Worksheet): DataTable[] {
  const out: DataTable[] = [];
  for (const column of sheet.grid.columns) {
    for (const run of column?.formulas ?? []) {
      if (run.kind !== 'dataTable') continue;
      const table = dataTableOf(run);
      if (table) out.push(table);
    }
  }
  return out;
}

/** Cells worked out per pass at most: data tables beyond this keep the values they were saved with. */
const DATA_TABLE_CELLS = 20000;

type Box = { sheet: number; r0: number; c0: number; r1: number; c1: number };

/**
 * Works out every data table of the workbook (for each cell: the inputs set, the engine recalculated, the formula read),
 * puts the inputs back and recalculates what reads the tables. Returns the boxes whose values changed.
 */
export function calculateDataTables(book: Workbook, engine: Engine): Box[] {
  const done: Box[] = [];
  let budget = DATA_TABLE_CELLS;
  book.sheets.forEach((sheet, s) => {
    if (!isWorksheet(sheet)) return;
    for (const table of dataTables(sheet)) {
      const { r0, c0, r1, c1 } = table.range;
      const size = (r1 - r0 + 1) * (c1 - c0 + 1);
      if (size > budget || (!table.rowInput && !table.colInput)) continue;
      budget -= size;
      const grid = sheet.grid;
      const inputs = [table.rowInput, table.colInput].filter((c): c is Cell => !!c);
      const saved = inputs.map((c) => {
        const column = grid.columns[c.col];
        return { ...c, kind: column?.kind(c.row) ?? Kind.Empty, value: column?.value(c.row) ?? 0, style: column?.style(c.row) ?? 0 };
      });
      const copy = (from: Cell, to: Cell) => {
        const column = grid.columns[from.col];
        grid.set(to.row, to.col, column?.kind(from.row) ?? Kind.Empty, column?.value(from.row) ?? 0, grid.columns[to.col]?.style(to.row) ?? 0);
      };
      const boxes = inputs.map((c) => ({ sheet: s, r0: c.row, c0: c.col, r1: c.row, c1: c.col }));
      // Two inputs: the corner's formula; one: the formula heading the cell's column (inputs down) or row (across).
      const formulaFor = (r: number, c: number): Cell => (table.rowInput && table.colInput ? { row: r0 - 1, col: c0 - 1 } : table.rowInput ? { row: r, col: c0 - 1 } : { row: r0 - 1, col: c });
      const results: [number, number, ReturnType<Engine['value']>][] = [];
      try {
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            if (table.rowInput) copy({ row: r0 - 1, col: c }, table.rowInput);
            if (table.colInput) copy({ row: r, col: c0 - 1 }, table.colInput);
            engine.recalculate(boxes);
            const at = formulaFor(r, c);
            results.push([r, c, engine.value(s, at.row, at.col)]);
          }
        }
      } finally {
        for (const c of saved) grid.set(c.row, c.col, c.kind, c.value, c.style);
        engine.recalculate(boxes);
      }
      for (const [r, c, v] of results) engine.write(s, r, c, v);
      const box = { sheet: s, r0, c0, r1, c1 };
      done.push(box, ...engine.recalculate([box]));
    }
  });
  return done;
}

// --- Scenarios ---------------------------------------------------------------------------------------------------------

const asValue = (v: ReturnType<Engine['value']>): SummaryValue => (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : v === null || v === undefined ? null : String(v));

/** The scenario summary's rows (scenarios.ts): each scenario shown in turn against the engine for its result cells, the
 * sheet put back afterwards. */
export function scenarioSummaryRows(book: Workbook, engine: Engine, sheetIndex: number, results: { row: number; col: number }[], labels: SummaryLabels): SummaryValue[][] | null {
  const sheet = book.sheets[sheetIndex];
  if (!isWorksheet(sheet) || !sheet.scenarios?.list.length) return null;
  const scenarios = sheet.scenarios;
  const grid = sheet.grid;
  const cells = [...new Map(scenarios.list.flatMap((x) => x.inputs).map((i) => [`${i.row},${i.col}`, { row: i.row, col: i.col }])).values()];
  const saved = cells.map((c) => {
    const column = grid.columns[c.col];
    return { ...c, kind: column?.kind(c.row) ?? Kind.Empty, value: column?.value(c.row) ?? 0, style: column?.style(c.row) ?? 0 };
  });
  const boxes = cells.map((c) => ({ sheet: sheetIndex, r0: c.row, c0: c.col, r1: c.row, c1: c.col }));
  const now = new Map(results.map((c) => [`${c.row},${c.col}`, asValue(engine.value(sheetIndex, c.row, c.col))]));
  const shown = scenarios.list.map((x) => {
    for (const i of x.inputs) {
      const n = i.value.trim() === '' ? NaN : Number(i.value);
      const style = grid.columns[i.col]?.style(i.row) ?? 0;
      if (Number.isFinite(n)) grid.set(i.row, i.col, Kind.Number, n, style);
      else grid.set(i.row, i.col, Kind.String, book.strings.add(i.value), style);
    }
    engine.recalculate(boxes);
    const out = new Map(results.map((c) => [`${c.row},${c.col}`, asValue(engine.value(sheetIndex, c.row, c.col))]));
    for (const c of saved) grid.set(c.row, c.col, c.kind, c.value, c.style);
    return out;
  });
  engine.recalculate(boxes);
  return scenarioSummary(scenarios, labels, (c) => asValue(engine.value(sheetIndex, c.row, c.col)), results, (i, c) => (i === null ? now : shown[i]).get(`${c.row},${c.col}`) ?? null);
}
