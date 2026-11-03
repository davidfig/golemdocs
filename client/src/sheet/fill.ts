// AutoFill (dragging the fill handle): a range's cells carried on into the cells it is dragged over, as Excel does it.
// Along each column (or row): numbers continue their straight-line trend (one number is copied; one date goes on by days),
// text ending in a number counts on, month and day names go round, formulas are copied with their relative references
// moved, and everything else is copied in turn. Looks are copied in turn too.

import { Kind } from './model/column.ts';
import type { FormulaRun } from './model/column.ts';
import type { Workbook } from './model/workbook.ts';
import type { CellRange, Worksheet } from './model/worksheet.ts';
import { numberFormat } from './format/numberFormat.ts';
import { shiftFormula } from './formula/shift.ts';

const LISTS = [
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
];

interface Source {
  kind: Kind;
  value: number;
  style: number;
  formula: { run: FormulaRun; text: string } | null;
}

/** Text in the case of an example: all capitals, a capital first, or as it is in the list. */
const likeCase = (example: string, word: string): string => (example === example.toUpperCase() ? word.toUpperCase() : example[0] === example[0].toLowerCase() ? word.toLowerCase() : word);

/** How one line (a column or row) of source cells goes on: the cell at position p (0..n-1 the sources, then on; negative going back). */
function series(book: Workbook, cells: Source[]): (p: number) => Source {
  const n = cells.length;
  const at = (p: number) => cells[((p % n) + n) % n];
  const texts = cells.map((c) => (c.kind === Kind.String && !c.formula ? book.strings.get(c.value) : null));
  // A straight line through numbers at positions 0..n-1 (least squares, as Excel's AutoFill).
  const line = (values: number[]) => {
    const m = values.length;
    const mx = (m - 1) / 2;
    const my = values.reduce((a, b) => a + b, 0) / m;
    let sxy = 0;
    let sxx = 0;
    values.forEach((v, i) => {
      sxy += (i - mx) * (v - my);
      sxx += (i - mx) ** 2;
    });
    const slope = sxx ? sxy / sxx : 0;
    return (p: number) => +(my + slope * (p - mx)).toPrecision(15);
  };
  if (cells.every((c) => c.kind === Kind.Number && !c.formula)) {
    if (n >= 2) {
      const f = line(cells.map((c) => c.value));
      return (p) => (p >= 0 && p < n ? cells[p] : { ...at(p), value: f(p) });
    }
    const isDate = numberFormat(book.styles.formatCode(book.styles.format(cells[0].style)?.numFmt ?? 0)).isDate;
    if (isDate) return (p) => ({ ...cells[0], value: cells[0].value + p });
    return at;
  }
  // Month and day names.
  for (const list of LISTS) {
    const index = texts.map((t) => (t === null ? -1 : list.findIndex((w) => w.toLowerCase() === t.toLowerCase())));
    if (index.every((i) => i >= 0)) {
      const step = n >= 2 ? index[1] - index[0] : 1;
      return (p) => {
        if (p >= 0 && p < n) return cells[p];
        const i = (((index[0] + step * p) % list.length) + list.length) % list.length;
        return { ...at(p), kind: Kind.String, value: book.strings.add(likeCase(texts[0]!, list[i])) };
      };
    }
  }
  // Text ending in a number: the number counts on (by the trend of the sources' numbers when they share their text).
  const parts = texts.map((t) => (t === null ? null : /^(.*?)(\d+)$/.exec(t)));
  if (parts.every((m) => m) && parts.every((m) => m![1] === parts[0]![1])) {
    const numbers = parts.map((m) => +m![2]);
    const f = n >= 2 ? line(numbers) : (p: number) => numbers[0] + p;
    const width = parts[0]![2].length;
    return (p) => {
      if (p >= 0 && p < n) return cells[p];
      const v = Math.max(0, Math.round(f(p)));
      return { ...at(p), kind: Kind.String, value: book.strings.add(parts[0]![1] + String(v).padStart(width, '0')) };
    };
  }
  return at;
}

/** Fills `target` (which holds `source` at one end) from `source`. */
export function fillRange(book: Workbook, sheet: Worksheet, source: CellRange, target: CellRange): void {
  const grid = sheet.grid;
  const down = target.r1 > source.r1 || target.r0 < source.r0;
  const lines = down ? [source.c0, source.c1] : [source.r0, source.r1];
  for (let line = lines[0]; line <= lines[1]; line++) {
    const cells: Source[] = [];
    const span = down ? [source.r0, source.r1] : [source.c0, source.c1];
    for (let i = span[0]; i <= span[1]; i++) {
      const [row, col] = down ? [i, line] : [line, i];
      const column = grid.columns[col];
      const run = column?.formulaAt(row);
      cells.push({
        kind: column?.kind(row) ?? Kind.Empty,
        value: column?.value(row) ?? 0,
        style: column?.style(row) ?? 0,
        formula: run ? { run, text: row === run.originRow && col === run.originCol ? run.text : shiftFormula(run.text, row - run.originRow, col - run.originCol) } : null,
      });
    }
    const next = series(book, cells);
    const range = down ? [target.r0, target.r1] : [target.c0, target.c1];
    // Formulas placed, gathered so each column's runs are rebuilt once (a formula filled down is one run).
    const placed = new Map<number, FormulaRun[]>();
    for (let i = range[0]; i <= range[1]; i++) {
      if (i >= span[0] && i <= span[1]) continue;
      const p = i - span[0];
      const cell = next(p);
      const [row, col] = down ? [i, line] : [line, i];
      if (cell.formula) {
        const from = span[0] + (((p % cells.length) + cells.length) % cells.length);
        const shift = i - from;
        const text = shiftFormula(cell.formula.text, down ? shift : 0, down ? 0 : shift);
        const runs = placed.get(col) ?? [];
        const last = runs[runs.length - 1];
        // One source cell filled down: every row is the same formula, relative to its own row, so they join one run.
        if (down && cells.length === 1 && last && last.last === row - 1) last.last = row;
        else runs.push({ text, first: row, last: row, originRow: row, originCol: col, kind: 'normal', shared: -1, ...(cell.formula.run.dynamic && { dynamic: true }) });
        placed.set(col, runs);
        grid.set(row, col, Kind.Blank, 0, cell.style);
      } else {
        grid.set(row, col, cell.kind === Kind.Empty && cell.style ? Kind.Blank : cell.kind, cell.value, cell.style);
      }
    }
    // The filled cells' old formulas go; the new ones come in.
    const columns = down ? [line] : range.length ? Array.from({ length: range[1] - range[0] + 1 }, (_, k) => range[0] + k).filter((c) => c < span[0] || c > span[1]) : [];
    for (const col of columns) {
      const column = grid.column(col);
      const cut = (a: number, b: number) => a <= b && column.setFormulas(a, b, null);
      if (down) {
        cut(target.r0, source.r0 - 1);
        cut(source.r1 + 1, target.r1);
      } else cut(line, line);
      const runs = placed.get(col);
      if (runs) column.formulas = joinRuns([...column.formulas, ...runs].sort((a, b) => a.first - b.first));
    }
  }
}

/** Joins runs next to each other that are the same formula relative to their cells (a formula filled on from its cell). */
export function joinRuns(runs: FormulaRun[]): FormulaRun[] {
  const out: FormulaRun[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    const same =
      last &&
      last.last === run.first - 1 &&
      last.kind !== 'array' &&
      run.kind !== 'array' &&
      last.kind !== 'dataTable' &&
      !!last.dynamic === !!run.dynamic &&
      shiftFormula(last.text, run.originRow - last.originRow, run.originCol - last.originCol) === run.text;
    if (same) out[out.length - 1] = { ...last, last: run.last, kind: 'shared', shared: -1 };
    else out.push(run);
  }
  return out;
}
