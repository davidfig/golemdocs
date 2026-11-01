// Moving references when rows or columns are inserted or deleted, and when sheets are renamed or deleted, as Excel does: a
// reference to a cell that moved follows it ($ or not), a range grows when rows are inserted inside it and shrinks when
// some of its rows are deleted, and a reference whose cells are all deleted becomes #REF!.
//
// A formula run is one text for many cells, and a relative reference reaches a different row from each cell; an insert can
// move the cells some of them read and not others. So a run is cut where that changes, and each piece gets its own text.

import { MAX_COLUMNS, MAX_ROWS, columnIndex, columnName } from '../model/column.ts';
import type { Column, FormulaRun } from '../model/column.ts';
import { isWorksheet } from '../model/workbook.ts';
import type { Workbook } from '../model/workbook.ts';
import { parseRange, rangeName } from '../refs.ts';
import { shiftFormula } from './shift.ts';

/** Rows or columns inserted (`n` > 0) or deleted (`n` < 0, so -n of them from `at`) on a sheet. */
export interface Move {
  sheet: number;
  axis: 'row' | 'col';
  at: number;
  n: number;
}

/** A reference, optionally after a sheet name: A1, A1:B2, A:C, 3:5. Same groups as shift.ts's. */
const REFERENCE =
  /(?<![\w.$!\]])((?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?(?:(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?::(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7}))?|(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})|(\$?)(\d{1,7}):(\$?)(\d{1,7}))(?![\w(.!])/g;

/** String literals and structured references, which are never rewritten. */
const LITERAL = /"(?:[^"]|"")*"|\[[^\]]*(?:\[[^\]]*\][^\]]*)*\]/g;

/** Applies `fn` to the parts of a formula outside string literals. */
function outsideLiterals(formula: string, fn: (part: string) => string): string {
  let out = '';
  let at = 0;
  for (const m of formula.matchAll(LITERAL)) {
    out += fn(formula.slice(at, m.index)) + m[0];
    at = m.index! + m[0].length;
  }
  return out + fn(formula.slice(at));
}

const unquote = (name: string): string => (name.startsWith("'") ? name.slice(1, -1).replace(/''/g, "'") : name);

/** A sheet name as references write it: quoted unless it is a plain word that could not be read as something else. */
export const quoteSheet = (name: string): string => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) && !/^(TRUE|FALSE)$/i.test(name) ? name : `'${name.replace(/'/g, "''")}'`);

/** Where an index goes: moved past an insert, closed up after a delete; null when it was deleted or pushed off the sheet. */
function moveIndex(i: number, at: number, n: number, limit: number): number | null {
  if (i < at) return i;
  if (n > 0) return i + n < limit ? i + n : null;
  return i >= at - n ? i + n : null;
}

/** A span's new ends (a range shrinks when some of it is deleted), or null when all of it was. */
function moveSpan(a: number, b: number, at: number, n: number, limit: number): [number, number] | null {
  if (n > 0) {
    const x = a >= at ? a + n : a;
    const y = b >= at ? b + n : b;
    if (x >= limit) return null;
    return [x, Math.min(y, limit - 1)];
  }
  const d = -n;
  const x = a < at ? a : a >= at + d ? a - d : at;
  const y = b < at ? b : b >= at + d ? b - d : at - 1;
  return y < x ? null : [x, y];
}

/**
 * Moves the references in a formula, written as it is in its cell (A1 style, as people write it or with the file's
 * prefixes), on `target` (a sheet's name) for an insert or delete along `axis`. `home` is the formula's own sheet's name
 * (its references without a sheet name are on it), or null for a defined name's formula.
 */
export function moveText(text: string, home: string | null, target: string, axis: 'row' | 'col', at: number, n: number): string {
  const lower = target.toLowerCase();
  return outsideLiterals(text, (part) =>
    part.replace(REFERENCE, (whole, sheet: string | undefined, ...g: string[]) => {
      const on = sheet ? unquote(sheet.slice(0, -1)).toLowerCase() : home?.toLowerCase();
      if (on !== lower) return whole;
      const prefix = sheet ?? '';
      const rowAxis = axis === 'row';
      const limit = rowAxis ? MAX_ROWS : MAX_COLUMNS;
      if (g[2] !== undefined) {
        // A1 or A1:B2.
        const c0 = columnIndex(g[1]);
        const r0 = +g[3] - 1;
        const c1 = g[5] !== undefined ? columnIndex(g[5]) : c0;
        const r1 = g[5] !== undefined ? +g[7] - 1 : r0;
        const span = rowAxis ? moveSpan(Math.min(r0, r1), Math.max(r0, r1), at, n, limit) : moveSpan(Math.min(c0, c1), Math.max(c0, c1), at, n, limit);
        if (g[5] === undefined) {
          const moved = moveIndex(rowAxis ? r0 : c0, at, n, limit);
          if (moved === null) return prefix + '#REF!';
          return rowAxis ? `${prefix}${g[0]}${g[1]}${g[2]}${moved + 1}` : `${prefix}${g[0]}${columnName(moved)}${g[2]}${g[3]}`;
        }
        if (!span) return prefix + '#REF!';
        const [x, y] = span;
        if (rowAxis) return `${prefix}${g[0]}${g[1]}${g[2]}${x + 1}:${g[4]}${g[5]}${g[6]}${y + 1}`;
        return `${prefix}${g[0]}${columnName(x)}${g[2]}${g[3]}:${g[4]}${columnName(y)}${g[6]}${g[7]}`;
      }
      if (g[9] !== undefined) {
        // A:C, moved only by columns.
        if (rowAxis) return whole;
        const span = moveSpan(columnIndex(g[9]), columnIndex(g[11]), at, n, limit);
        return span ? `${prefix}${g[8]}${columnName(span[0])}:${g[10]}${columnName(span[1])}` : prefix + '#REF!';
      }
      if (g[13] !== undefined) {
        // 3:5, moved only by rows.
        if (!rowAxis) return whole;
        const span = moveSpan(+g[13] - 1, +g[15] - 1, at, n, limit);
        return span ? `${prefix}${g[12]}${span[0] + 1}:${g[14]}${span[1] + 1}` : prefix + '#REF!';
      }
      return whole;
    }),
  );
}

/** The rows of a run at which a relative row reference to the target sheet starts or stops reaching moved rows. */
function breakpoints(run: FormulaRun, home: string, target: string, move: Move): number[] {
  const lower = target.toLowerCase();
  const out: number[] = [];
  const edges = move.n > 0 ? [move.at] : [move.at, move.at - move.n];
  outsideLiterals(run.text, (part) => {
    for (const m of part.matchAll(REFERENCE)) {
      const sheet = m[1];
      const on = sheet ? unquote(sheet.slice(0, -1)).toLowerCase() : home.toLowerCase();
      if (on !== lower) continue;
      const rows: [string, string][] = [];
      if (m[4] !== undefined) {
        rows.push([m[4], m[5]]);
        if (m[7] !== undefined) rows.push([m[8], m[9]]);
      } else if (m[15] !== undefined) rows.push([m[14], m[15]], [m[16], m[17]]);
      for (const [abs, digits] of rows) {
        if (abs) continue;
        // The cell at row r reads row i + (r - origin); it reaches an edge e at r = e - i + origin.
        const i = +digits - 1;
        for (const e of edges) out.push(e - i + run.originRow);
      }
    }
    return part;
  });
  return out;
}

/** A sheet's position change for a cell (null when deleted). */
const movedCell = (index: number, move: Move, axis: 'row' | 'col'): number | null =>
  move.axis !== axis ? index : moveIndex(index, move.at, move.n, axis === 'row' ? MAX_ROWS : MAX_COLUMNS);

/**
 * The formula runs of a whole workbook after a move: every reference to the moved sheet follows its cells. Runs on the moved
 * sheet are given in the positions they will have once its cells have moved (the caller moves the cells, then puts these
 * lists in). Returns new lists only for the columns that change.
 */
export function moveFormulas(book: Workbook, move: Move): Map<Column, FormulaRun[]> {
  const target = book.sheets[move.sheet].name;
  const lower = target.toLowerCase();
  const mentions = (text: string, home: string) => (home.toLowerCase() === lower ? true : text.toLowerCase().includes(lower.replace(/'/g, "''")));
  const out = new Map<Column, FormulaRun[]>();
  book.sheets.forEach((sheet, s) => {
    if (!isWorksheet(sheet)) return;
    const onTarget = s === move.sheet;
    sheet.grid.columns.forEach((column, c) => {
      if (!column?.formulas.length) return;
      const newCol = onTarget ? movedCell(c, move, 'col') : c;
      let changed = false;
      const runs: FormulaRun[] = [];
      for (const run of column.formulas) {
        const touchesCells = onTarget && (move.axis === 'col' ? c >= move.at : run.last >= move.at);
        const refs = mentions(run.text, sheet.name);
        if (!touchesCells && !refs) {
          runs.push(run);
          continue;
        }
        changed = true;
        if (newCol === null) continue;
        // Cut the run where the cells it reads (or its own cells) start or stop moving.
        const cuts = new Set<number>();
        if (move.axis === 'row') {
          if (onTarget) {
            cuts.add(move.at);
            if (move.n < 0) cuts.add(move.at - move.n);
          }
          if (refs) for (const b of breakpoints(run, sheet.name, target, move)) cuts.add(b);
        }
        const starts = [run.first, ...[...cuts].filter((b) => b > run.first && b <= run.last).sort((a, b) => a - b)];
        for (let k = 0; k < starts.length; k++) {
          const p0 = starts[k];
          const p1 = k + 1 < starts.length ? starts[k + 1] - 1 : run.last;
          // Rows of the piece that remain once the move is done.
          let first = p0;
          while (first <= p1 && onTarget && movedCell(first, move, 'row') === null) first++;
          if (first > p1) continue;
          let last = p1;
          while (last >= first && onTarget && movedCell(last, move, 'row') === null) last--;
          const text = refs ? moveText(shiftFormula(run.text, first - run.originRow, c - run.originCol), sheet.name, target, move.axis, move.at, move.n) : shiftFormula(run.text, first - run.originRow, c - run.originCol);
          const newFirst = onTarget ? movedCell(first, move, 'row')! : first;
          const newLast = onTarget ? movedCell(last, move, 'row')! : last;
          let ref = run.ref;
          if (ref && onTarget) {
            const r = parseRange(ref);
            if (r) {
              const moved = moveText(rangeName(r), target, target, move.axis, move.at, move.n);
              ref = moved.includes('#REF!') ? rangeName({ r0: newFirst, c0: newCol, r1: newFirst, c1: newCol }) : moved;
            }
          }
          runs.push({ ...run, text, first: newFirst, last: newLast, originRow: newFirst, originCol: newCol, shared: -1, ...(ref !== undefined && { ref }) });
        }
      }
      if (changed) {
        out.set(column, runs);
        sheet.dirty.cells = true;
      }
    });
  });
  return out;
}

/** The moved sheet's conditional formats: their ranges follow the cells (a range all deleted goes), their formulas too. */
export function moveConditional(book: Workbook, move: Move): void {
  const sheet = book.sheets[move.sheet];
  if (!isWorksheet(sheet) || !sheet.conditional.length) return;
  const name = sheet.name;
  sheet.conditional = sheet.conditional.flatMap((format) => {
    const ranges = format.ranges.flatMap((r) => {
      const moved = moveText(rangeName(r), name, name, move.axis, move.at, move.n);
      const range = moved.includes('#REF!') ? null : parseRange(moved);
      return range ? [range] : [];
    });
    if (!ranges.length) return [];
    const rules = format.rules.map((rule) => ({
      ...rule,
      formulas: rule.formulas.map((f) => moveText(f, name, name, move.axis, move.at, move.n)),
    }));
    return [{ ...format, ranges, rules }];
  });
  sheet.dirty.layout = true;
}

/** The moved sheet's AutoFilter range follows its cells (and goes if all of it was deleted). */
export function moveFilter(book: Workbook, move: Move): void {
  const sheet = book.sheets[move.sheet];
  if (!isWorksheet(sheet) || !sheet.autoFilter) return;
  const moved = moveText(rangeName(sheet.autoFilter.range), sheet.name, sheet.name, move.axis, move.at, move.n);
  const range = moved.includes('#REF!') ? null : parseRange(moved);
  sheet.autoFilter = range ? { ...sheet.autoFilter, range } : null;
}

/** The moved sheet's tables follow their cells (a table all deleted keeps its range). */
export function moveTables(book: Workbook, move: Move): void {
  const sheet = book.sheets[move.sheet];
  if (!isWorksheet(sheet) || !sheet.tables.length) return;
  sheet.tables = sheet.tables.map((t) => {
    const moved = moveText(rangeName(t.range), sheet.name, sheet.name, move.axis, move.at, move.n);
    const range = moved.includes('#REF!') ? null : parseRange(moved);
    return range ? { ...t, range } : t;
  });
}

/** The moved sheet's validation rules follow their cells, their formulas too (a rule whose cells are all deleted goes). */
export function moveValidations(book: Workbook, move: Move): void {
  const sheet = book.sheets[move.sheet];
  if (!isWorksheet(sheet) || !sheet.validations.length) return;
  const name = sheet.name;
  const text = (f: string | undefined) => (f === undefined || f.startsWith('"') ? f : moveText(f, name, name, move.axis, move.at, move.n));
  sheet.validations = sheet.validations.flatMap((v) => {
    const ranges = v.ranges.flatMap((r) => {
      const moved = moveText(rangeName(r), name, name, move.axis, move.at, move.n);
      const range = moved.includes('#REF!') ? null : parseRange(moved);
      return range ? [range] : [];
    });
    return ranges.length ? [{ ...v, ranges, formula1: text(v.formula1), formula2: text(v.formula2) }] : [];
  });
}

/** The moved sheet's notes follow their cells (a note whose cell was deleted goes, as in Excel). */
export function moveNotes(book: Workbook, move: Move): void {
  const sheet = book.sheets[move.sheet];
  if (!isWorksheet(sheet) || !sheet.notes.length) return;
  const limit = move.axis === 'row' ? MAX_ROWS : MAX_COLUMNS;
  sheet.notes = sheet.notes.flatMap((n) => {
    const index = move.axis === 'row' ? n.row : n.col;
    const moved = index < move.at ? index : move.n > 0 ? index + move.n : index >= move.at - move.n ? index + move.n : -1;
    if (moved < 0 || moved >= limit) return [];
    return [{ ...n, ...(move.axis === 'row' ? { row: moved } : { col: moved }) }];
  });
}

/** Defined names after a move. */
export function moveNames(book: Workbook, move: Move): void {
  const target = book.sheets[move.sheet].name;
  book.names = book.names.map((n) => {
    const home = n.sheet === undefined ? null : (book.sheets[n.sheet]?.name ?? null);
    const formula = moveText(n.formula, home, target, move.axis, move.at, move.n);
    return formula === n.formula ? n : { ...n, formula };
  });
}

/** References to a renamed sheet, with its new name (quoted as it needs). */
export function renameText(text: string, from: string, to: string): string {
  const lower = from.toLowerCase();
  return outsideLiterals(text, (part) =>
    part.replace(/(?<![\w.$!\]])('(?:[^']|'')+'|[A-Za-z_][\w.]*)(?::('(?:[^']|'')+'|[A-Za-z_][\w.]*))?!/g, (whole, a: string, b: string | undefined) => {
      const first = unquote(a).toLowerCase() === lower ? to : unquote(a);
      const second = b === undefined ? undefined : unquote(b).toLowerCase() === lower ? to : unquote(b);
      if (first === unquote(a) && second === (b === undefined ? undefined : unquote(b))) return whole;
      if (second === undefined) return `${quoteSheet(first)}!`;
      // A 3D reference is quoted as one name when either end needs it.
      const plain = quoteSheet(first) === first && quoteSheet(second) === second;
      return plain ? `${first}:${second}!` : `'${first.replace(/'/g, "''")}:${second.replace(/'/g, "''")}'!`;
    }),
  );
}

/** References to a deleted sheet become #REF!. */
export function deleteSheetText(text: string, name: string): string {
  const lower = name.toLowerCase();
  return outsideLiterals(text, (part) =>
    part.replace(REFERENCE, (whole, sheet: string | undefined) => (sheet && unquote(sheet.slice(0, -1)).toLowerCase() === lower ? '#REF!' : whole)),
  );
}

/** Rewrites every formula and defined name of a workbook with `fn` (for renamed and deleted sheets). */
export function rewriteAll(book: Workbook, fn: (text: string) => string): void {
  for (const sheet of book.sheets) {
    if (!isWorksheet(sheet)) continue;
    for (const column of sheet.grid.columns) {
      if (!column?.formulas.length) continue;
      let changed = false;
      const runs = column.formulas.map((run) => {
        const text = fn(run.text);
        if (text === run.text) return run;
        changed = true;
        return { ...run, text, shared: -1 };
      });
      if (changed) {
        column.formulas = runs;
        sheet.dirty.cells = true;
      }
    }
  }
  book.names = book.names.map((n) => {
    const formula = fn(n.formula);
    return formula === n.formula ? n : { ...n, formula };
  });
}
