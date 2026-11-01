// Edits to a workbook, with undo (docs/spreadsheets.md, "The editor"). An edit takes a snapshot of what it may change
// before it changes it (a column's snapshot shares its chunks, frozen, so it costs a few references), then a second after,
// so undo and redo each put one back. Formulas typed here are kept as text until the engine (M3) calculates them; references
// in other formulas are moved by the engine too when rows and columns move.

import { Column, Kind, MAX_COLUMNS, MAX_ROWS, columnName } from './model/column.ts';
import type { ColumnState, FormulaRun, Grid } from './model/column.ts';
import { Sizes } from './model/sizes.ts';
import { Workbook, isWorksheet } from './model/workbook.ts';
import type { AnySheet, DefinedName } from './model/workbook.ts';
import { Worksheet, cellKey, keyCol, keyRow } from './model/worksheet.ts';
import type { CellRange, Pane } from './model/worksheet.ts';
import { expandStructured, fromFileFormula, toFileFormula } from './formula/fileNames.ts';
import { shiftFormula } from './formula/shift.ts';
import { deleteSheetText, moveConditional, moveFilter, moveFormulas, moveNotes, moveTables, moveValidations, moveNames, quoteSheet, renameText, rewriteAll } from './formula/move.ts';
import type { Move } from './formula/move.ts';
import { restyle } from './format/styleChange.ts';
import { fillRange } from './fill.ts';
import { pasteCells, pasteTarget } from './pasteCells.ts';
import { applyFilter } from './filter.ts';
import { newTable } from './tables.ts';
import { displayText, editText } from './format/display.ts';
import type { Edges, StyleChange } from './format/styleChange.ts';
import { parseInput } from './input.ts';
import type { Changed, EditOp } from './protocol.ts';

/** The most cells one edit may fill (typing into a whole column fills a million). */
const MAX_FILL = 4_000_000;

type SizesState = ReturnType<Sizes['state']>;

interface SheetSnapshot {
  sheet: Worksheet;
  columns: Map<number, ColumnState | null>;
  extent: [number, number];
  sizes?: { rows: SizesState; cols: SizesState };
  meta?: {
    rowStyles: Map<number, number>;
    colStyles: Map<number, number>;
    rowOutline: Worksheet['rowOutline'];
    colOutline: Worksheet['colOutline'];
    cellAttrs: Map<number, string>;
    rowAttrs: Map<number, string>;
    merges: CellRange[];
    pane: Pane | null;
    conditional: Worksheet['conditional'];
    autoFilter: Worksheet['autoFilter'];
    tables: Worksheet['tables'];
    validations: Worksheet['validations'];
    notes: Worksheet['notes'];
  };
  /** The whole column list (structure moved: columns inserted or deleted). */
  columnList?: (Column | undefined)[];
}

interface BookSnapshot {
  sheets?: { list: AnySheet[]; titles: string[]; parts: NonNullable<Workbook['source']>['parts']; names: DefinedName[]; active: number; removed: string[] };
  sheet?: SheetSnapshot;
  /** Every column's formulas and the defined names, for an edit that moves references throughout the workbook. */
  formulas?: { columns: [Column, FormulaRun[]][]; names: DefinedName[] };
}

interface Step {
  op: EditOp;
  sheet: number;
  before: BookSnapshot;
  after: BookSnapshot;
}

export class History {
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  limit = 100;

  constructor(private readonly book: Workbook) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  apply(sheetIndex: number, op: EditOp): Changed {
    const book = this.book;
    const sheet = book.sheets[sheetIndex];
    const before = snapshot(book, sheetIndex, op);
    const changed = applyEdit(book, sheetIndex, op);
    if (changed.message && !changed.ranges.length && !changed.info) return changed;
    if (op.kind === 'activeSheet') return changed;
    const after = snapshot(book, sheetIndex, op);
    this.undoStack.push({ op, sheet: sheetIndex, before, after });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    if (isWorksheet(sheet)) markDirty(sheet, op);
    return changed;
  }

  /** The sheet the last undo or redo changed, and its kind of edit. */
  lastSheet = 0;
  lastKind: EditOp['kind'] = 'input';

  /** Takes back the last edit for good (it was refused: a value a validation rule does not allow). */
  refuse(): void {
    this.undo();
    this.redoStack.pop();
  }

  undo(): Changed | null {
    const step = this.undoStack.pop();
    if (!step) return null;
    this.lastSheet = step.sheet;
    this.lastKind = step.op.kind;
    restore(this.book, step.before);
    this.redoStack.push(step);
    return afterRestore(this.book, step);
  }

  redo(): Changed | null {
    const step = this.redoStack.pop();
    if (!step) return null;
    this.lastSheet = step.sheet;
    this.lastKind = step.op.kind;
    restore(this.book, step.after);
    this.undoStack.push(step);
    return afterRestore(this.book, step);
  }
}

function afterRestore(book: Workbook, step: Step): Changed {
  const sheet = book.sheets[step.sheet];
  if (sheet && isWorksheet(sheet)) markDirty(sheet, step.op);
  book.dirty ||= !!step.before.sheets;
  return { ranges: [everything()], info: undefined, select: rangeOf(step.op) ?? undefined };
}

function markDirty(sheet: Worksheet, op: EditOp): void {
  sheet.dirty.cells = true;
  if (op.kind !== 'input' && op.kind !== 'paste' && op.kind !== 'clear') sheet.dirty.layout = true;
}

const everything = (): CellRange => ({ r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLUMNS - 1 });

function rangeOf(op: EditOp): CellRange | null {
  switch (op.kind) {
    case 'input':
      return op.range;
    case 'paste':
      return { r0: op.at.row, c0: op.at.col, r1: op.at.row + Math.max(0, op.rows.length - 1), c1: op.at.col + Math.max(0, ...op.rows.map((r) => r.length - 1)) };
    case 'clear':
      return op.ranges[0] ?? null;
    default:
      return null;
  }
}

/** The columns an edit's cells are in: 'all' for an edit that moves structure, 'cells' for one that may change any cell. */
function columnsOf(op: EditOp): number[] | 'all' | 'cells' | null {
  switch (op.kind) {
    case 'input':
      return range(op.range.c0, op.range.c1);
    case 'paste': {
      const r = rangeOf(op)!;
      return range(r.c0, Math.min(MAX_COLUMNS - 1, r.c1));
    }
    case 'clear':
      return [...new Set(op.ranges.flatMap((r) => range(r.c0, r.c1)))];
    case 'format':
      return [...new Set(op.ranges.flatMap((r) => range(r.c0, Math.min(r.c1, r.c0 + 4096))))];
    case 'replace':
      return op.cells ? [...new Set(op.cells.map((c) => c.col))] : 'cells';
    case 'sort':
      return 'cells';
    case 'fill':
      return range(op.target.c0, op.target.c1);
    case 'pasteCells': {
      const t = pasteTarget(op.source, op.at, op.transpose);
      return range(t.c0, t.c1);
    }
    case 'createTable':
      return 'cells';
    case 'insertRows':
    case 'deleteRows':
    case 'insertColumns':
    case 'deleteColumns':
      return 'all';
    default:
      return null;
  }
}

const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** Whether an edit can change formulas anywhere in the workbook (references to moved cells or renamed sheets). */
const movesReferences = (op: EditOp): boolean =>
  op.kind === 'insertRows' || op.kind === 'deleteRows' || op.kind === 'insertColumns' || op.kind === 'deleteColumns' || op.kind === 'renameSheet' || op.kind === 'deleteSheet' || op.kind === 'autoFilter';

function snapshot(book: Workbook, index: number, op: EditOp): BookSnapshot {
  const out: BookSnapshot = {};
  if (movesReferences(op)) {
    const columns: [Column, FormulaRun[]][] = [];
    for (const sheet of book.sheets) if (isWorksheet(sheet)) for (const column of sheet.grid.columns) if (column?.formulas.length) columns.push([column, column.formulas.map((f) => ({ ...f }))]);
    out.formulas = { columns, names: book.names.map((n) => ({ ...n })) };
  }
  if (op.kind === 'addSheet' || op.kind === 'deleteSheet' || op.kind === 'renameSheet' || op.kind === 'moveSheet') {
    out.sheets = { list: book.sheets.slice(), titles: book.sheets.map((s) => s.name), parts: book.source ? book.source.parts.map((p) => ({ ...p })) : [], names: book.names.map((n) => ({ ...n })), active: book.activeSheet, removed: (book.source?.removed ?? []).slice() };
    return out;
  }
  const sheet = book.sheets[index];
  if (!sheet || !isWorksheet(sheet)) return out;
  const columns = new Map<number, ColumnState | null>();
  const which = columnsOf(op);
  const grid = sheet.grid;
  if (which === 'all' || which === 'cells') grid.columns.forEach((c, i) => c && columns.set(i, c.snapshot()));
  else if (which) for (const c of which) columns.set(c, grid.columns[c]?.snapshot() ?? null);
  const snap: SheetSnapshot = { sheet, columns, extent: [grid.rows, grid.cols] };
  const structural = which === 'all';
  if (which === 'cells') snap.extent = [grid.rows, grid.cols];
  if (structural) snap.columnList = grid.columns.slice();
  if (structural || op.kind === 'rowHeight' || op.kind === 'columnWidth' || op.kind === 'hideRows' || op.kind === 'hideColumns' || op.kind === 'autoFilter' || op.kind === 'filter') {
    snap.sizes = { rows: copySizes(sheet.rowSizes.state()), cols: copySizes(sheet.colSizes.state()) };
  }
  if (structural || op.kind === 'freeze' || op.kind === 'merge' || op.kind === 'unmerge' || op.kind === 'clear' || op.kind === 'format' || op.kind === 'pasteCells' || op.kind === 'createTable' || op.kind === 'autoFilter' || op.kind === 'filter' || op.kind === 'sort') {
    snap.meta = {
      rowStyles: new Map(sheet.rowStyles),
      colStyles: new Map(sheet.colStyles),
      rowOutline: new Map(sheet.rowOutline),
      colOutline: new Map(sheet.colOutline),
      cellAttrs: new Map(sheet.cellAttrs),
      rowAttrs: new Map(sheet.rowAttrs),
      merges: sheet.merges.map((m) => ({ ...m })),
      pane: sheet.pane && { ...sheet.pane },
      conditional: sheet.conditional,
      autoFilter: sheet.autoFilter,
      tables: sheet.tables,
      validations: sheet.validations,
      notes: sheet.notes,
    };
  }
  out.sheet = snap;
  return out;
}

const copySizes = (s: SizesState): SizesState => ({ defaultSize: s.defaultSize, own: s.own && s.own.slice(), hidden: s.hidden && s.hidden.slice() });

function restore(book: Workbook, snap: BookSnapshot): void {
  if (snap.formulas) {
    for (const [column, runs] of snap.formulas.columns) column.formulas = runs.map((f) => ({ ...f }));
    book.names = snap.formulas.names.map((n) => ({ ...n }));
  }
  if (snap.sheets) {
    book.sheets = snap.sheets.list.slice();
    book.sheets.forEach((s, i) => (s.name = snap.sheets!.titles[i]));
    if (book.source) {
      book.source.parts = snap.sheets.parts.map((p) => ({ ...p }));
      book.source.removed = snap.sheets.removed.slice();
    }
    book.names = snap.sheets.names.map((n) => ({ ...n }));
    book.activeSheet = snap.sheets.active;
    book.dirty = true;
  }
  const s = snap.sheet;
  if (!s) return;
  const { sheet } = s;
  const grid = sheet.grid;
  if (s.columnList) grid.columns = s.columnList.slice();
  for (const [c, state] of s.columns) {
    if (state === null) grid.columns[c] = undefined;
    else (grid.columns[c] ??= new Column()).restore(state);
  }
  [grid.rows, grid.cols] = s.extent;
  if (s.sizes) {
    sheet.rowSizes = Sizes.from(MAX_ROWS, copySizes(s.sizes.rows));
    sheet.colSizes = Sizes.from(MAX_COLUMNS, copySizes(s.sizes.cols));
  }
  if (s.meta) {
    sheet.rowStyles = new Map(s.meta.rowStyles);
    sheet.colStyles = new Map(s.meta.colStyles);
    sheet.rowOutline = new Map(s.meta.rowOutline);
    sheet.colOutline = new Map(s.meta.colOutline);
    sheet.cellAttrs = new Map(s.meta.cellAttrs);
    sheet.rowAttrs = new Map(s.meta.rowAttrs);
    sheet.merges = s.meta.merges.map((m) => ({ ...m }));
    sheet.pane = s.meta.pane && { ...s.meta.pane };
    sheet.conditional = s.meta.conditional;
    sheet.autoFilter = s.meta.autoFilter;
    sheet.tables = s.meta.tables;
    sheet.validations = s.meta.validations;
    sheet.notes = s.meta.notes;
  }
}

/** Applies an edit (no undo: History.apply records it). */
export function applyEdit(book: Workbook, index: number, op: EditOp): Changed {
  const sheet = book.sheets[index];
  switch (op.kind) {
    case 'addSheet':
      return addSheet(book, op.at, op.name);
    case 'deleteSheet':
      return deleteSheet(book, op.sheet);
    case 'renameSheet':
      return renameSheet(book, op.sheet, op.name);
    case 'moveSheet':
      return moveSheet(book, op.from, op.to);
    case 'activeSheet':
      book.activeSheet = Math.max(0, Math.min(book.sheets.length - 1, op.sheet));
      book.dirty = true;
      return { ranges: [] };
  }
  if (!sheet || !isWorksheet(sheet)) return { ranges: [], message: 'not a worksheet' };
  const grid = sheet.grid;
  switch (op.kind) {
    case 'input': {
      const { r0, c0, r1, c1 } = op.range;
      if ((r1 - r0 + 1) * (c1 - c0 + 1) > MAX_FILL) return { ranges: [], message: 'too many cells' };
      const parsed = parseInput(op.text, book.date1904);
      for (let c = c0; c <= c1; c++) {
        const column = grid.column(c);
        if (parsed.kind === 'formula') {
          // One formula typed into a range is one run per column, relative to the range's first cell.
          const table = sheet.tables.find((t) => r0 >= t.range.r0 && r0 <= t.range.r1 && c >= t.range.c0 && c <= t.range.c1);
          column.setFormulas(r0, r1, { text: toFileFormula(expandStructured(parsed.text, table?.displayName ?? null)), originRow: r0, originCol: c0, kind: r1 > r0 || c1 > c0 ? 'shared' : 'normal', shared: -1, dynamic: true });
          for (let r = r0; r <= r1; r++) grid.set(r, c, Kind.Blank, 0, column.style(r));
          continue;
        }
        for (let r = r0; r <= r1; r++) setValue(book, grid, r, c, parsed);
      }
      return { ranges: [op.range] };
    }
    case 'paste': {
      const { row, col } = op.at;
      op.rows.forEach((cells, dr) =>
        cells.forEach((text, dc) => {
          const r = row + dr;
          const c = col + dc;
          if (r >= MAX_ROWS || c >= MAX_COLUMNS) return;
          const parsed = parseInput(text, book.date1904);
          if (parsed.kind === 'formula') {
            grid.column(c).setFormula(r, { text: toFileFormula(parsed.text), originRow: r, originCol: c, kind: 'normal', shared: -1, dynamic: true });
            grid.set(r, c, Kind.Blank, 0, grid.column(c).style(r));
          } else setValue(book, grid, r, c, parsed);
        }),
      );
      const filled = rangeOf(op)!;
      return { ranges: [filled], select: filled };
    }
    case 'clear': {
      for (const r of op.ranges) {
        for (let c = r.c0; c <= Math.min(r.c1, grid.cols - 1); c++) {
          const column = grid.columns[c];
          if (!column) continue;
          const cells: [number, number, number][] = [];
          column.forEach(r.r0, Math.min(r.r1 + 1, MAX_ROWS), (row, kind, _value, style) => cells.push([row, kind, style]));
          for (const [row, , style] of cells) {
            if (op.what === 'formats') {
              column.set(row, column.kind(row), column.value(row), 0);
              continue;
            }
            if (op.what === 'contents' && style) column.set(row, Kind.Blank, 0, style);
            else column.set(row, Kind.Empty, 0, 0);
          }
          if (op.what !== 'formats') column.setFormulas(r.r0, Math.min(r.r1, MAX_ROWS - 1), null);
        }
        if (op.what === 'all') sheet.merges = sheet.merges.filter((m) => !(m.r0 >= r.r0 && m.r1 <= r.r1 && m.c0 >= r.c0 && m.c1 <= r.c1));
      }
      grid.measure();
      return { ranges: op.ranges };
    }
    case 'format':
      return formatCells(book, sheet, op.ranges, op.change);
    case 'replace':
      return replaceText(book, sheet, op);
    case 'sort':
      return sortRows(book, sheet, op);
    case 'autoFilter':
      return setAutoFilter(book, index, sheet, op.range);
    case 'filter': {
      const filter = sheet.autoFilter;
      if (!filter) return { ranges: [] };
      const offset = op.col - filter.range.c0;
      const columns = filter.columns.filter((c) => c.col !== offset);
      if (op.values !== null) columns.push({ col: offset, values: op.values, blanks: op.blanks });
      sheet.autoFilter = { range: filter.range, columns: columns.sort((a, b) => a.col - b.col) };
      applyFilter(book, sheet, sheet.autoFilter);
      return { ranges: [everything()] };
    }
    case 'createTable':
      return createTable(book, sheet, op.range);
    case 'pasteCells': {
      const t = pasteTarget(op.source, op.at, op.transpose);
      if ((t.r1 - t.r0 + 1) * (t.c1 - t.c0 + 1) > MAX_FILL) return { ranges: [], message: 'too many cells' };
      const filled = pasteCells(book, op.from, op.source, sheet, op.at, op.what, op.transpose);
      grid.measure();
      return filled ? { ranges: [filled], select: filled } : { ranges: [] };
    }
    case 'fill': {
      const t = op.target;
      if ((t.r1 - t.r0 + 1) * (t.c1 - t.c0 + 1) > MAX_FILL) return { ranges: [], message: 'too many cells' };
      fillRange(book, sheet, op.source, t);
      return { ranges: [{ ...t }], select: { ...t } };
    }
    case 'insertRows':
      moveReferences(book, { sheet: index, axis: 'row', at: op.at, n: op.count }, () => insertRows(sheet, op.at, op.count));
      return { ranges: [{ r0: op.at, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLUMNS - 1 }], info: undefined };
    case 'deleteRows':
      moveReferences(book, { sheet: index, axis: 'row', at: op.at, n: -op.count }, () => deleteRows(sheet, op.at, op.count));
      return { ranges: [{ r0: op.at, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLUMNS - 1 }] };
    case 'insertColumns':
      moveReferences(book, { sheet: index, axis: 'col', at: op.at, n: op.count }, () => insertColumns(sheet, op.at, op.count));
      return { ranges: [{ r0: 0, c0: op.at, r1: MAX_ROWS - 1, c1: MAX_COLUMNS - 1 }] };
    case 'deleteColumns':
      moveReferences(book, { sheet: index, axis: 'col', at: op.at, n: -op.count }, () => deleteColumns(sheet, op.at, op.count));
      return { ranges: [{ r0: 0, c0: op.at, r1: MAX_ROWS - 1, c1: MAX_COLUMNS - 1 }] };
    case 'rowHeight':
      for (const r of op.rows) sheet.rowSizes.set(r, op.size);
      return { ranges: [everything()] };
    case 'columnWidth':
      for (const c of op.cols) sheet.colSizes.set(c, op.size);
      return { ranges: [everything()] };
    case 'hideRows':
      for (const r of op.rows) sheet.rowSizes.setHidden(r, op.hidden);
      return { ranges: [everything()] };
    case 'hideColumns':
      for (const c of op.cols) sheet.colSizes.setHidden(c, op.hidden);
      return { ranges: [everything()] };
    case 'freeze':
      sheet.pane = op.pane && (op.pane.rows || op.pane.cols) ? op.pane : null;
      return { ranges: [] };
    case 'merge': {
      const m = op.range;
      sheet.merges = sheet.merges.filter((x) => x.r1 < m.r0 || x.r0 > m.r1 || x.c1 < m.c0 || x.c0 > m.c1);
      if (m.r0 !== m.r1 || m.c0 !== m.c1) sheet.merges.push({ ...m });
      // Only the top-left cell keeps its value, as in Excel.
      for (let c = m.c0; c <= m.c1; c++) {
        const column = grid.columns[c];
        if (!column) continue;
        for (let r = m.r0; r <= m.r1; r++) {
          if (r === m.r0 && c === m.c0) continue;
          const style = column.style(r);
          if (column.kind(r) !== Kind.Empty) column.set(r, style ? Kind.Blank : Kind.Empty, 0, style);
          if (column.formulaAt(r)) column.setFormula(r, null);
        }
      }
      return { ranges: [m] };
    }
    case 'unmerge':
      sheet.merges = sheet.merges.filter((x) => x.r1 < op.range.r0 || x.r0 > op.range.r1 || x.c1 < op.range.c0 || x.c0 > op.range.c1);
      return { ranges: [op.range] };
  }
}

/** The block of filled cells around a cell (Excel's current region): grown while any cell next to it holds something. */
export function currentRegion(grid: Grid, row: number, col: number): CellRange {
  const filled = (r: number, c: number) => r >= 0 && c >= 0 && (grid.columns[c]?.kind(r) ?? Kind.Empty) !== Kind.Empty;
  let r0 = row;
  let r1 = row;
  let c0 = col;
  let c1 = col;
  for (let grew = true; grew; ) {
    grew = false;
    const rowHas = (r: number) => r >= 0 && r < MAX_ROWS && Array.from({ length: c1 - c0 + 3 }, (_, i) => c0 - 1 + i).some((c) => filled(r, c));
    const colHas = (c: number) => c >= 0 && c < MAX_COLUMNS && Array.from({ length: r1 - r0 + 3 }, (_, i) => r0 - 1 + i).some((r) => filled(r, c));
    if (rowHas(r0 - 1)) (r0--, (grew = true));
    if (r1 < grid.rows && rowHas(r1 + 1)) (r1++, (grew = true));
    if (colHas(c0 - 1)) (c0--, (grew = true));
    if (c1 < grid.cols && colHas(c1 + 1)) (c1++, (grew = true));
  }
  return { r0, c0, r1, c1 };
}

/** Excel's sort order: numbers, then text (any case), then logicals, then errors; empty cells always last. */
function sortKey(book: Workbook, kind: Kind, value: number): [number, number | string] {
  switch (kind) {
    case Kind.Number:
      return [0, value];
    case Kind.String:
      return [1, book.strings.get(value).toLowerCase()];
    case Kind.Boolean:
      return [2, value];
    case Kind.Error:
      return [3, 0];
    default:
      return [4, 0];
  }
}

/** Sort: the rows of a range reordered by key columns; formulas move with their rows, their relative references as if copied. */
function sortRows(book: Workbook, sheet: Worksheet, op: Extract<EditOp, { kind: 'sort' }>): Changed {
  const grid = sheet.grid;
  const single = op.range.r0 === op.range.r1 && op.range.c0 === op.range.c1;
  const r = single ? currentRegion(grid, op.range.r0, op.range.c0) : { ...op.range, r1: Math.min(op.range.r1, Math.max(grid.rows - 1, op.range.r0)) };
  if ((r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1) > MAX_FILL) return { ranges: [], message: 'too many cells' };
  // A header: the first row is all text where the row under it is not, or its look differs (bold) from the row under it.
  const header =
    op.header ??
    (r.r1 > r.r0 &&
      Array.from({ length: r.c1 - r.c0 + 1 }, (_, i) => r.c0 + i).every((c) => {
        const column = grid.columns[c];
        const k = column?.kind(r.r0) ?? Kind.Empty;
        return k === Kind.String || k === Kind.Empty;
      }) &&
      Array.from({ length: r.c1 - r.c0 + 1 }, (_, i) => r.c0 + i).some((c) => {
        const column = grid.columns[c];
        return (column?.kind(r.r0 + 1) ?? Kind.Empty) !== Kind.String || column?.style(r.r0) !== column?.style(r.r0 + 1);
      }));
  const first = header ? r.r0 + 1 : r.r0;
  if (first >= r.r1) return { ranges: [], select: r };
  const rows = Array.from({ length: r.r1 - first + 1 }, (_, i) => first + i);
  const keyCols = op.keys.filter((k) => k.col >= r.c0 && k.col <= r.c1);
  const keys = new Map(rows.map((row) => [row, keyCols.map((k) => sortKey(book, grid.columns[k.col]?.kind(row) ?? Kind.Empty, grid.columns[k.col]?.value(row) ?? 0))]));
  const order = rows.slice().sort((a, b) => {
    const ka = keys.get(a)!;
    const kb = keys.get(b)!;
    for (let i = 0; i < keyCols.length; i++) {
      const [ra, va] = ka[i];
      const [rb, vb] = kb[i];
      // Empty cells stay last either way.
      if (ra === 4 || rb === 4) {
        if (ra !== rb) return ra === 4 ? 1 : -1;
        continue;
      }
      const c = ra !== rb ? ra - rb : va < vb ? -1 : va > vb ? 1 : 0;
      if (c) return keyCols[i].descending ? -c : c;
    }
    return a - b;
  });
  for (let c = r.c0; c <= r.c1; c++) {
    const column = grid.columns[c];
    if (!column) continue;
    const cells = rows.map((row) => {
      const run = column.formulaAt(row);
      return { kind: column.kind(row), value: column.value(row), style: column.style(row), formula: run ? { run, text: row === run.originRow && c === run.originCol ? run.text : shiftFormula(run.text, row - run.originRow, c - run.originCol) } : null };
    });
    const byRow = new Map(rows.map((row, i) => [row, cells[i]]));
    const kept = column.formulas.filter((f) => f.last < first || f.first > r.r1);
    const cut = column.formulas.filter((f) => !(f.last < first || f.first > r.r1));
    // Runs that reach outside the range keep their cells outside it.
    for (const f of cut) {
      if (f.first < first) kept.push({ ...f, last: first - 1 });
      if (f.last > r.r1) kept.push({ ...f, first: r.r1 + 1 });
    }
    order.forEach((source, i) => {
      const target = rows[i];
      const cell = byRow.get(source)!;
      column.set(target, cell.kind, cell.value, cell.style);
      if (cell.formula) {
        const { run, text } = cell.formula;
        kept.push({ ...run, text: shiftFormula(text, target - source, 0), first: target, last: target, originRow: target, originCol: c, kind: run.kind === 'shared' ? 'normal' : run.kind, shared: -1 });
      }
    });
    column.formulas = kept.sort((a, b) => a.first - b.first);
  }
  return { ranges: [r], select: r };
}

/** Sheet › Insert Table: a new table over a range; its header names are the first row's text (empty ones become Column1...). */
function createTable(book: Workbook, sheet: Worksheet, range: CellRange): Changed {
  const r = range.r0 === range.r1 && range.c0 === range.c1 ? currentRegion(sheet.grid, range.r0, range.c0) : range;
  if (sheet.tables.some((t) => t.range.r0 <= r.r1 && t.range.r1 >= r.r0 && t.range.c0 <= r.c1 && t.range.c1 >= r.c0)) return { ranges: [], message: 'tableOverlap' };
  if (sheet.autoFilter && sheet.autoFilter.range.r0 <= r.r1 && sheet.autoFilter.range.r1 >= r.r0 && sheet.autoFilter.range.c0 <= r.c1 && sheet.autoFilter.range.c1 >= r.c0) return { ranges: [], message: 'tableOverlap' };
  const all = book.sheets.flatMap((s) => (isWorksheet(s) ? s.tables : []));
  const taken = new Set([...all.map((t) => t.displayName.toLowerCase()), ...book.names.map((n) => n.name.toLowerCase())]);
  let n = 1;
  while (taken.has(`table${n}`)) n++;
  const id = Math.max(0, ...all.map((t) => +(t.xml.attrs.id ?? 0))) + 1;
  // Header names: as shown, unique; an empty header cell gets Column1, Column2... written in it.
  const names: string[] = [];
  for (let c = r.c0; c <= r.c1; c++) {
    const column = sheet.grid.columns[c];
    const kind = column?.kind(r.r0) ?? Kind.Empty;
    let name = kind === Kind.Empty || kind === Kind.Blank ? '' : displayText(book, kind, column!.value(r.r0), column!.style(r.r0)).text.trim();
    if (!name) {
      name = `Column${c - r.c0 + 1}`;
      sheet.grid.set(r.r0, c, Kind.String, book.strings.add(name), column?.style(r.r0) ?? 0);
    }
    let unique = name;
    for (let k = 2; names.some((x) => x.toLowerCase() === unique.toLowerCase()); k++) unique = `${name}${k}`;
    if (unique !== name) sheet.grid.set(r.r0, c, Kind.String, book.strings.add(unique), column?.style(r.r0) ?? 0);
    names.push(unique);
  }
  sheet.tables = [...sheet.tables, newTable(id, `Table${n}`, r, names)];
  return { ranges: [r], select: r };
}

/** Sheet › Filter on (over a range, or the block around a cell) or off (every row it hid is shown again). */
function setAutoFilter(book: Workbook, index: number, sheet: Worksheet, range: CellRange | null): Changed {
  const old = sheet.autoFilter;
  if (old) for (let row = old.range.r0 + 1; row <= old.range.r1; row++) sheet.rowSizes.setHidden(row, false);
  book.names = book.names.filter((n) => !(n.name === '_xlnm._FilterDatabase' && n.sheet === index));
  sheet.autoFilter = null;
  if (range) {
    const r = range.r0 === range.r1 && range.c0 === range.c1 ? currentRegion(sheet.grid, range.r0, range.c0) : range;
    sheet.autoFilter = { range: r, columns: [] };
    // Excel keeps a filter's range in a hidden name of the sheet.
    book.names.push({ name: '_xlnm._FilterDatabase', formula: `${quoteSheet(sheet.name)}!${absolute(r)}`, sheet: index, hidden: true });
  }
  book.dirty = true;
  return { ranges: [everything()] };
}

const absolute = (r: CellRange): string => `$${columnName(r.c0)}$${r.r0 + 1}:$${columnName(r.c1)}$${r.r1 + 1}`;

/** Edit › Replace: the text in each cell's contents as typed, replaced and entered again as if typed. */
function replaceText(book: Workbook, sheet: Worksheet, op: Extract<EditOp, { kind: 'replace' }>): Changed {
  if (!op.text) return { ranges: [], count: 0 };
  const grid = sheet.grid;
  const flags = op.matchCase ? 'g' : 'gi';
  const pattern = new RegExp(op.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  const changes: { row: number; col: number; text: string }[] = [];
  const consider = (row: number, col: number) => {
    const column = grid.columns[col];
    if (!column) return;
    const kind = column.kind(row);
    if (kind === Kind.Empty || kind === Kind.Blank) return;
    const run = column.formulaAt(row);
    const text = run ? '=' + fromFileFormula(row === run.originRow && col === run.originCol ? run.text : shiftFormula(run.text, row - run.originRow, col - run.originCol)) : editText(book, kind, column.value(row), column.style(row));
    const same = op.matchCase ? text === op.text : text.toLowerCase() === op.text.toLowerCase();
    if (op.wholeCell ? !same : !pattern.test(text)) return;
    pattern.lastIndex = 0;
    changes.push({ row, col, text: op.wholeCell ? op.with : text.replace(pattern, () => op.with) });
  };
  if (op.cells) for (const { row, col } of op.cells) consider(row, col);
  else grid.columns.forEach((column, col) => column?.forEach(0, grid.rows, (row) => consider(row, col)));
  for (const { row, col, text } of changes) {
    const parsed = parseInput(text, book.date1904);
    if (parsed.kind === 'formula') {
      const column = grid.column(col);
      column.setFormula(row, { text: toFileFormula(parsed.text), originRow: row, originCol: col, kind: 'normal', shared: -1, dynamic: true });
      grid.set(row, col, Kind.Blank, 0, column.style(row));
    } else setValue(book, grid, row, col, parsed);
  }
  return { ranges: changes.map(({ row, col }) => ({ r0: row, c0: col, r1: row, c1: col })), count: changes.length };
}

/**
 * Applies a style change to ranges of cells. A range of whole columns (or rows) changes the columns' (rows') own style and
 * the cells in them that hold something, as Excel does, rather than a million empty cells.
 */
function formatCells(book: Workbook, sheet: Worksheet, ranges: CellRange[], change: StyleChange): Changed {
  const grid = sheet.grid;
  const styles = book.styles;
  const cache = new Map<string, number>();
  const restyled = (style: number, edges: Edges, value: number | null): number => {
    // Most cells share a few styles: each (style, edges) pair is worked out once.
    const key = `${style}:${+edges.top}${+edges.bottom}${+edges.left}${+edges.right}:${change.decimals ? value : ''}`;
    let out = cache.get(key);
    if (out === undefined) cache.set(key, (out = restyle(styles, style, change, edges, value)));
    return out;
  };
  for (const r of ranges) {
    const wholeColumns = r.r0 === 0 && r.r1 >= MAX_ROWS - 1;
    const wholeRows = r.c0 === 0 && r.c1 >= MAX_COLUMNS - 1;
    const edgesOf = (row: number, col: number): Edges => ({ top: row === r.r0, bottom: row === r.r1, left: col === r.c0, right: col === r.c1 });
    if (wholeColumns || wholeRows) {
      if (wholeColumns) for (let c = r.c0; c <= Math.min(r.c1, MAX_COLUMNS - 1); c++) sheet.colStyles.set(c, restyled(sheet.colStyles.get(c) ?? 0, edgesOf(r.r0, c), null));
      if (wholeRows && !wholeColumns) for (let row = r.r0; row <= r.r1; row++) sheet.rowStyles.set(row, restyled(sheet.rowStyles.get(row) ?? 0, edgesOf(row, r.c0), null));
      for (let c = r.c0; c <= Math.min(r.c1, grid.cols - 1); c++) {
        const column = grid.columns[c];
        if (!column) continue;
        const cells: [number, Kind, number, number][] = [];
        column.forEach(r.r0, Math.min(r.r1 + 1, MAX_ROWS), (row, kind, value, style) => cells.push([row, kind, value, style]));
        for (const [row, kind, value, style] of cells) column.set(row, kind, value, restyled(style, edgesOf(row, c), kind === Kind.Number ? value : null));
      }
      continue;
    }
    if ((r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1) > MAX_FILL) return { ranges: [], message: 'too many cells' };
    for (let c = r.c0; c <= r.c1; c++) {
      const column = grid.column(c);
      for (let row = r.r0; row <= r.r1; row++) {
        const kind = column.kind(row);
        const value = column.value(row);
        // An empty cell takes its row's or column's style before the change, as Excel does.
        const style = kind === Kind.Empty ? (sheet.rowStyles.get(row) ?? sheet.colStyles.get(c) ?? 0) : column.style(row);
        const next = restyled(style, edgesOf(row, c), kind === Kind.Number ? value : null);
        if (kind === Kind.Empty && next === 0) continue;
        grid.set(row, c, kind === Kind.Empty ? Kind.Blank : kind, value, next);
      }
    }
  }
  return { ranges: ranges.map((r) => ({ ...r })) };
}

/** Moves cells (`move`) and every reference to them, in formulas anywhere in the workbook and in defined names. */
function moveReferences(book: Workbook, change: Move, moveCells: () => void): void {
  const lists = moveFormulas(book, change);
  moveCells();
  for (const [column, runs] of lists) column.formulas = runs;
  moveNames(book, change);
  moveConditional(book, change);
  moveFilter(book, change);
  moveTables(book, change);
  moveValidations(book, change);
  moveNotes(book, change);
}

/** Puts a value typed or pasted into a cell, giving a General cell the format the typing implied. */
function setValue(book: Workbook, grid: Grid, r: number, c: number, parsed: Exclude<ReturnType<typeof parseInput>, { kind: 'formula' }>): void {
  const column = grid.column(c);
  if (column.formulaAt(r)) column.setFormula(r, null);
  let style = column.style(r);
  switch (parsed.kind) {
    case Kind.Empty:
      grid.set(r, c, style ? Kind.Blank : Kind.Empty, 0, style);
      return;
    case Kind.Number:
      if (parsed.format && book.styles.format(style)?.numFmt === 0) {
        style = book.styles.internFormat({ ...book.styles.format(style), numFmt: book.styles.formatId(parsed.format) });
      }
      grid.set(r, c, Kind.Number, parsed.value, style);
      return;
    case Kind.String:
      grid.set(r, c, Kind.String, book.strings.add(parsed.text), style);
      return;
    case Kind.Boolean:
    case Kind.Error:
      grid.set(r, c, parsed.kind, parsed.value, style);
  }
}

/**
 * A per-row (or per-column) map after an insert (`n` > 0) or delete (`n` < 0) at `at`: entries after it move, deleted ones go.
 * `index` gives an entry's row or column from its key, `move` the key moved by `d`.
 */
function shiftKeys<T>(map: Map<number, T>, at: number, n: number, limit: number, index: (k: number) => number = (k) => k, move: (k: number, d: number) => number = (k, d) => k + d): Map<number, T> {
  const out = new Map<number, T>();
  for (const [k, v] of map) {
    const i = index(k);
    if (i < at) out.set(k, v);
    else if (n < 0 && i < at - n) continue;
    else if (i + n < limit) out.set(move(k, n), v);
  }
  return out;
}

function insertRows(sheet: Worksheet, at: number, n: number): void {
  sheet.grid.insertRows(at, n);
  sheet.rowSizes.insert(at, n);
  sheet.rowStyles = shiftKeys(sheet.rowStyles, at, n, MAX_ROWS);
  sheet.rowOutline = shiftKeys(sheet.rowOutline, at, n, MAX_ROWS);
  sheet.rowAttrs = shiftKeys(sheet.rowAttrs, at, n, MAX_ROWS);
  sheet.cellAttrs = shiftKeys(sheet.cellAttrs, at, n, MAX_ROWS, keyRow, (k, d) => cellKey(keyRow(k) + d, keyCol(k)));
  sheet.merges = sheet.merges.flatMap((m) => (m.r1 < at ? [m] : m.r0 >= at ? [{ ...m, r0: m.r0 + n, r1: m.r1 + n }] : [{ ...m, r1: m.r1 + n }])).filter((m) => m.r1 < MAX_ROWS);
}

function deleteRows(sheet: Worksheet, at: number, n: number): void {
  sheet.grid.deleteRows(at, n);
  sheet.rowSizes.remove(at, n);
  sheet.rowStyles = shiftKeys(sheet.rowStyles, at, -n, MAX_ROWS);
  sheet.rowOutline = shiftKeys(sheet.rowOutline, at, -n, MAX_ROWS);
  sheet.rowAttrs = shiftKeys(sheet.rowAttrs, at, -n, MAX_ROWS);
  sheet.cellAttrs = shiftKeys(sheet.cellAttrs, at, -n, MAX_ROWS, keyRow, (k, d) => cellKey(keyRow(k) + d, keyCol(k)));
  sheet.merges = sheet.merges.flatMap((m) => {
    const r0 = m.r0 < at ? m.r0 : Math.max(at, m.r0 - n);
    const r1 = m.r1 < at ? m.r1 : m.r1 < at + n ? at - 1 : m.r1 - n;
    return r1 < r0 || (r0 === r1 && m.c0 === m.c1) ? [] : [{ ...m, r0, r1 }];
  });
}

function insertColumns(sheet: Worksheet, at: number, n: number): void {
  sheet.grid.insertColumns(at, n);
  moveFormulaOrigins(sheet.grid, at, n);
  sheet.colSizes.insert(at, n);
  sheet.colStyles = shiftKeys(sheet.colStyles, at, n, MAX_COLUMNS);
  sheet.colOutline = shiftKeys(sheet.colOutline, at, n, MAX_COLUMNS);
  sheet.cellAttrs = shiftKeys(sheet.cellAttrs, at, n, MAX_COLUMNS, keyCol, (k, d) => cellKey(keyRow(k), keyCol(k) + d));
  sheet.merges = sheet.merges.flatMap((m) => (m.c1 < at ? [m] : m.c0 >= at ? [{ ...m, c0: m.c0 + n, c1: m.c1 + n }] : [{ ...m, c1: m.c1 + n }])).filter((m) => m.c1 < MAX_COLUMNS);
}

function deleteColumns(sheet: Worksheet, at: number, n: number): void {
  sheet.grid.deleteColumns(at, n);
  moveFormulaOrigins(sheet.grid, at + n, -n);
  sheet.colSizes.remove(at, n);
  sheet.colStyles = shiftKeys(sheet.colStyles, at, -n, MAX_COLUMNS);
  sheet.colOutline = shiftKeys(sheet.colOutline, at, -n, MAX_COLUMNS);
  sheet.cellAttrs = shiftKeys(sheet.cellAttrs, at, -n, MAX_COLUMNS, keyCol, (k, d) => cellKey(keyRow(k), keyCol(k) + d));
  sheet.merges = sheet.merges.flatMap((m) => {
    const c0 = m.c0 < at ? m.c0 : Math.max(at, m.c0 - n);
    const c1 = m.c1 < at ? m.c1 : m.c1 < at + n ? at - 1 : m.c1 - n;
    return c1 < c0 || (c0 === c1 && m.r0 === m.r1) ? [] : [{ ...m, c0, c1 }];
  });
}

/** Formula runs whose first cell's column moved keep pointing at it. */
function moveFormulaOrigins(grid: Grid, from: number, n: number): void {
  for (const column of grid.columns) for (const run of column?.formulas ?? []) if (run.originCol >= from) run.originCol += n;
}

// --- Sheets ---

/** Excel's rules for a sheet name: 1 to 31 characters, none of : \ / ? * [ ], not starting or ending with ', and unique. */
export function sheetNameProblem(book: Workbook, name: string, except = -1): string | null {
  if (!name.trim()) return 'empty';
  if (name.length > 31) return 'tooLong';
  if (/[:\\/?*[\]]/.test(name) || name.startsWith("'") || name.endsWith("'")) return 'characters';
  if (book.sheets.some((s, i) => i !== except && s.name.toLowerCase() === name.toLowerCase())) return 'taken';
  return null;
}

/** "Sheet4": the first SheetN not in use. */
export function nextSheetName(book: Workbook): string {
  for (let n = book.sheets.length + 1; ; n++) if (!sheetNameProblem(book, `Sheet${n}`)) return `Sheet${n}`;
}

function addSheet(book: Workbook, at: number, name: string): Changed {
  const problem = sheetNameProblem(book, name);
  if (problem) return { ranges: [], message: problem };
  const sheetId = Math.max(0, ...book.sheets.map((s) => s.sheetId)) + 1;
  const sheet = new Worksheet(name, sheetId);
  sheet.dirty.cells = true;
  book.sheets.splice(at, 0, sheet);
  book.source?.parts.splice(at, 0, { part: '', rId: '', loaded: true });
  for (const n of book.names) if (n.sheet !== undefined && n.sheet >= at) n.sheet++;
  book.activeSheet = at;
  book.dirty = true;
  return { ranges: [everything()] };
}

function deleteSheet(book: Workbook, index: number): Changed {
  if (book.sheets.filter((s) => s.state === 'visible').length <= 1 && book.sheets[index]?.state === 'visible') return { ranges: [], message: 'lastSheet' };
  const part = book.source?.parts[index];
  if (part?.part && book.source) (book.source.removed ??= []).push(part.part);
  rewriteAll(book, (text) => deleteSheetText(text, book.sheets[index].name));
  book.sheets.splice(index, 1);
  book.source?.parts.splice(index, 1);
  book.names = book.names.filter((n) => n.sheet !== index).map((n) => (n.sheet !== undefined && n.sheet > index ? { ...n, sheet: n.sheet - 1 } : n));
  book.activeSheet = Math.min(book.activeSheet >= index && book.activeSheet > 0 ? book.activeSheet - 1 : book.activeSheet, book.sheets.length - 1);
  book.dirty = true;
  return { ranges: [everything()] };
}

function renameSheet(book: Workbook, index: number, name: string): Changed {
  const problem = sheetNameProblem(book, name, index);
  if (problem) return { ranges: [], message: problem };
  const old = book.sheets[index].name;
  rewriteAll(book, (text) => renameText(text, old, name));
  book.sheets[index].name = name;
  book.dirty = true;
  return { ranges: [] };
}

function moveSheet(book: Workbook, from: number, to: number): Changed {
  if (from === to) return { ranges: [] };
  const [sheet] = book.sheets.splice(from, 1);
  book.sheets.splice(to, 0, sheet);
  if (book.source) {
    const [part] = book.source.parts.splice(from, 1);
    book.source.parts.splice(to, 0, part);
  }
  const map = (i: number) => (i === from ? to : from < to ? (i > from && i <= to ? i - 1 : i) : i >= to && i < from ? i + 1 : i);
  book.names = book.names.map((n) => (n.sheet === undefined ? n : { ...n, sheet: map(n.sheet) }));
  book.activeSheet = map(book.activeSheet);
  book.dirty = true;
  return { ranges: [] };
}

