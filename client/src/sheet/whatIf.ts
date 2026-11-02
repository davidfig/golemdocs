// What-if analysis (docs/spreadsheets.md, M6). Goal Seek: the value of one cell (a constant) that makes a formula's value
// come to a goal. Tried in the worker against the engine itself: the cell is set, the sheet recalculated and the formula
// read, as Excel's Goal Seek does; the cell is put back afterwards, and the page applies the answer as an ordinary edit.

import type { Engine } from './formula/engine.ts';
import { Kind } from './model/column.ts';
import type { Worksheet } from './model/worksheet.ts';

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
