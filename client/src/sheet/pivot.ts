// Pivot tables (docs/spreadsheets.md, M6). Read from a sheet's pivot table parts and the cache each uses (its source
// range and fields), and laid out from the source cells in Excel's compact layout (new items after the old, in the order
// they first come in the source): the row fields' items down the first
// column (an outer item's row holds its subtotal, the inner ones indented under it), a column field's items or the
// values across, grand totals last. Excel saves a pivot's cells with the sheet, so a pivot shows as read; Refresh lays it
// out again from its source and writes the cells, and the parts are brought in line on save (pivotWrite.ts).

import { elements } from '@golemdocs/docx';
import type { OpcPackage, XmlElement } from '@golemdocs/docx';
import { BLANK } from './formula/values.ts';
import type { Scalar } from './formula/values.ts';
import { isWorksheet } from './model/workbook.ts';
import type { Workbook } from './model/workbook.ts';
import type { Worksheet } from './model/worksheet.ts';
import { Kind } from './model/column.ts';
import { restyle } from './format/styleChange.ts';
import type { CellRange } from './model/worksheet.ts';
import { parseRange, rangeName } from './refs.ts';
import { mixTo } from './tables.ts';
import type { TablePaint } from './tables.ts';

/** A cache's field: its name, and the values its items index (`sharedItems`, in their order). */
export interface CacheField {
  name: string;
  shared: (string | number | boolean | null)[];
  /** What kinds of values the source holds for it (from the last refresh here): written for fields with no items. */
  summary?: FieldSummary;
}

export interface FieldSummary {
  strings: boolean;
  numbers: boolean;
  integers: boolean;
  blank: boolean;
  min: number | null;
  max: number | null;
}

export interface PivotCache {
  part: string;
  /** Its id in the workbook's `<pivotCaches>`, for a cache made here. */
  id?: number;
  /** The source: a sheet's range. */
  sheet: string;
  ref: string;
  fields: CacheField[];
}

export type PivotFunction = 'sum' | 'count' | 'average' | 'max' | 'min' | 'product' | 'countNums' | 'stdDev' | 'stdDevp' | 'var' | 'varp';

export interface DataField {
  name: string;
  field: number;
  fn: PivotFunction;
  numFmtId: number | null;
}

export interface PivotField {
  axis: 'row' | 'col' | 'page' | null;
  /** The field's items in their order, as indexes into the cache field's shared values. */
  items: number[];
  /** Subtotals shown for it (an outer row field's row holds them). */
  subtotal: boolean;
  /** Its layout down the rows (all default to true, Excel's compact layout): `compact` shares the column of the field
   * before it, indented; `outline` puts its items on rows of their own, with their subtotals at the top when
   * `subtotalTop` (else in a row of their own after them); not `outline` is the tabular layout (an item's first inner item
   * on its row, its subtotal after them). */
  compact?: boolean;
  outline?: boolean;
  subtotalTop?: boolean;
  /** Its items sorted by their values (`sortType`), else in their own order. */
  sort?: 'ascending' | 'descending';
  /** Items not shown (`h`), as indexes into the cache field's shared values: their records are left out of everything. */
  hidden?: number[];
}

export interface PivotTable {
  name: string;
  /** Where it is: its top left, and its size as last laid out. */
  location: CellRange;
  rowFields: number[];
  /** Fields across; -2 stands for the values (when there are several). */
  colFields: number[];
  /** Filters: a field, and the item it shows (its place in the field's items), or null for all of them. */
  pageFields: { field: number; item: number | null }[];
  dataFields: DataField[];
  fields: PivotField[];
  /** Captions Excel shows (`dataCaption`, the row and column headers' own names when set). */
  dataCaption: string;
  rowHeader: string;
  colHeader: string;
  grandRows: boolean;
  grandCols: boolean;
  /** Its built-in style (`PivotStyleLight16`, Excel's default) and which of the style's parts it shows. */
  style: PivotStyle;
  /** The shape of its rows and columns as last laid out (from the file's rowItems and colItems, or a refresh here). */
  look?: PivotLook;
  part: string;
  cache: PivotCache;
  /** Laid out here since it was read: its parts are brought in line when the workbook is written. */
  refreshed?: boolean;
}

export interface PivotStyle {
  name: string;
  rowHeaders: boolean;
  colHeaders: boolean;
  rowStripes: boolean;
  colStripes: boolean;
}

export const DEFAULT_PIVOT_STYLE: PivotStyle = { name: 'PivotStyleLight16', rowHeaders: true, colHeaders: true, rowStripes: false, colStripes: false };

/** A body row: how deep its item is (0 for the outermost row field), whether it has items under it, whether it is a
 * subtotal row of its own (subtotals at the bottom) or the grand total. */
export interface PivotRowLook {
  depth: number;
  leaf: boolean;
  subtotal: boolean;
  grand: boolean;
}

/** Where a pivot's body starts (from its location's top left), and what each body row and column is. */
export interface PivotLook {
  headerRows: number;
  labelCols: number;
  rows: PivotRowLook[];
  /** The body's columns (from `labelCols`): 'sub' for a subtotal, 'grand' for a grand total. */
  cols: ('item' | 'sub' | 'grand')[];
}

const local = (e: XmlElement) => e.name.slice(e.name.indexOf(':') + 1);
const kid = (e: XmlElement | undefined, name: string) => (e ? [...elements(e)].find((c) => local(c) === name) : undefined);
const kids = (e: XmlElement | undefined, name: string) => (e ? [...elements(e)].filter((c) => local(c) === name) : []);
const off = (v: string | undefined) => v === '0' || v === 'false';
const on = (v: string | undefined) => v === '1' || v === 'true';

function sharedValue(e: XmlElement): string | number | boolean | null {
  const v = e.attrs.v;
  switch (local(e)) {
    case 'n':
      return v === undefined ? null : +v;
    case 'b':
      return v === '1' || v === 'true';
    case 'm':
      return null;
    default:
      return v ?? '';
  }
}

export function readCache(root: XmlElement, part: string): PivotCache | null {
  const source = kid(kid(root, 'cacheSource'), 'worksheetSource');
  if (!source?.attrs.ref || !source.attrs.sheet) return null;
  const fields = kids(kid(root, 'cacheFields'), 'cacheField').map((f) => ({ name: f.attrs.name ?? '', shared: [...elements(kid(f, 'sharedItems') ?? f)].map(sharedValue) }));
  return { part, sheet: source.attrs.sheet, ref: source.attrs.ref, fields };
}

export function readPivotTable(root: XmlElement, part: string, cache: PivotCache): PivotTable | null {
  const loc = kid(root, 'location');
  const location = loc?.attrs.ref ? parseRange(loc.attrs.ref) : null;
  if (!location) return null;
  const axes: Record<string, PivotField['axis']> = { axisRow: 'row', axisCol: 'col', axisPage: 'page' };
  const fields = kids(kid(root, 'pivotFields'), 'pivotField').map((f): PivotField => {
    const items = kids(kid(f, 'items'), 'item').filter((i) => i.attrs.x !== undefined && !i.attrs.t);
    const hidden = items.filter((i) => on(i.attrs.h)).map((i) => +i.attrs.x!);
    const sort = f.attrs.sortType;
    return {
      axis: axes[f.attrs.axis ?? ''] ?? null,
      items: items.map((i) => +i.attrs.x!),
      subtotal: !off(f.attrs.defaultSubtotal),
      ...(off(f.attrs.compact) && { compact: false }),
      ...(off(f.attrs.outline) && { outline: false }),
      ...(off(f.attrs.subtotalTop) && { subtotalTop: false }),
      ...((sort === 'ascending' || sort === 'descending') && { sort }),
      ...(hidden.length && { hidden }),
    };
  });
  const fieldList = (name: string) => kids(kid(root, name), 'field').map((f) => +(f.attrs.x ?? 0));
  const a = root.attrs;
  const info = kid(root, 'pivotTableStyleInfo')?.attrs;
  const style: PivotStyle = info
    ? { name: info.name ?? '', rowHeaders: !off(info.showRowHeaders), colHeaders: !off(info.showColHeaders), rowStripes: on(info.showRowStripes), colStripes: on(info.showColStripes) }
    : { ...DEFAULT_PIVOT_STYLE, name: '' };
  const rowFields = fieldList('rowFields');
  return {
    name: a.name ?? '',
    location,
    rowFields,
    colFields: fieldList('colFields'),
    pageFields: kids(kid(root, 'pageFields'), 'pageField').map((f) => ({ field: +(f.attrs.fld ?? 0), item: f.attrs.item === undefined ? null : +f.attrs.item })),
    dataFields: kids(kid(root, 'dataFields'), 'dataField').map((d) => ({
      name: d.attrs.name ?? '',
      field: +(d.attrs.fld ?? 0),
      fn: (d.attrs.subtotal as PivotFunction | undefined) ?? 'sum',
      numFmtId: d.attrs.numFmtId === undefined ? null : +d.attrs.numFmtId,
    })),
    fields,
    dataCaption: a.dataCaption ?? 'Values',
    rowHeader: a.rowHeaderCaption ?? 'Row Labels',
    colHeader: a.colHeaderCaption ?? 'Column Labels',
    grandRows: !off(a.rowGrandTotals),
    grandCols: !off(a.colGrandTotals),
    style,
    look: readLook(root, loc!, rowFields.length),
    part,
    cache,
  };
}

/** The shape Excel saved a pivot in: its rowItems and colItems (an item's depth is the members it repeats from the one
 * before, `r`, and the ones it lists). None when they were not saved (a pivot laid out here). */
function readLook(root: XmlElement, loc: XmlElement, rowFieldCount: number): PivotLook | undefined {
  const rowItems = kid(root, 'rowItems');
  if (!rowItems) return undefined;
  const depth = (i: XmlElement) => +(i.attrs.r ?? 0) + Math.max(1, kids(i, 'x').length) - 1;
  const rows = kids(rowItems, 'i').map((i): PivotRowLook => {
    const t = i.attrs.t ?? 'data';
    const d = t === 'grand' ? 0 : depth(i);
    return { depth: d, leaf: t === 'grand' || (t === 'data' && d >= rowFieldCount - 1), subtotal: t !== 'data' && t !== 'grand' && t !== 'blank', grand: t === 'grand' };
  });
  const cols = kids(kid(root, 'colItems'), 'i').map((i) => {
    const t = i.attrs.t ?? 'data';
    return t === 'grand' ? 'grand' : t === 'data' || t === 'blank' ? 'item' : 'sub';
  });
  return { headerRows: +(loc.attrs.firstDataRow ?? 1), labelCols: +(loc.attrs.firstDataCol ?? 1), rows, cols };
}

/** The pivot tables of a sheet, each with its cache. */
export async function readPivotTables(pkg: OpcPackage, sheetPart: string): Promise<PivotTable[]> {
  const rels = await pkg.relationships(sheetPart);
  const out: PivotTable[] = [];
  const caches = new Map<string, PivotCache | null>();
  for (const rel of rels.list) {
    if (!rel.type.endsWith('/pivotTable')) continue;
    const part = rels.partName(rel);
    if (!pkg.has(part)) continue;
    const pivotRels = await pkg.relationships(part);
    const cacheRel = pivotRels.list.find((r) => r.type.endsWith('/pivotCacheDefinition'));
    const cachePart = cacheRel ? pivotRels.partName(cacheRel) : '';
    if (!cachePart || !pkg.has(cachePart)) continue;
    if (!caches.has(cachePart)) caches.set(cachePart, readCache(await pkg.xml(cachePart), cachePart));
    const cache = caches.get(cachePart);
    const table = cache && readPivotTable(await pkg.xml(part), part, cache);
    if (table) out.push(table);
  }
  return out;
}

// --- Layout ------------------------------------------------------------------------------------------------------------

/** A cell of a laid-out pivot: its place from the pivot's top left, a value, and what kind of cell it is. */
export interface PivotCell {
  row: number;
  col: number;
  value: string | number;
  /** For the look (pivot styles): a header, a label, a subtotal row, a grand total, or a value. */
  role: 'header' | 'label' | 'subtotal' | 'grand' | 'value';
  /** Indent level of a row label (compact layout). */
  indent?: number;
  /** A value's value field. */
  data?: number;
}

export interface PivotLayout {
  cells: PivotCell[];
  rows: number;
  cols: number;
  /** Each field's kinds of values in the source, for writing. */
  summaries: FieldSummary[];
  /** The fields' items in order after the refresh (shared values, possibly with new ones appended in the order they
   * first come in the source), for writing. */
  shared: CacheField['shared'][];
  items: number[][];
  firstHeaderRow: number;
  firstDataRow: number;
  firstDataCol: number;
  look: PivotLook;
}

/** The source as records: a field's value per row (strings, numbers, booleans; null for an empty cell). */
export type PivotSource = { names: string[]; records: Scalar[][] };

const key = (v: unknown) => (typeof v === 'string' ? `s${v.toLowerCase()}` : typeof v === 'number' ? `n${v}` : typeof v === 'boolean' ? `b${v}` : 'e');

/** Values for an aggregate. */
function aggregate(fn: PivotFunction, values: Scalar[]): number {
  const nums = values.filter((v): v is number => typeof v === 'number');
  const n = nums.length;
  const sum = nums.reduce((a, b) => a + b, 0);
  const mean = n ? sum / n : 0;
  const ss = nums.reduce((a, b) => a + (b - mean) ** 2, 0);
  switch (fn) {
    case 'count':
      return values.filter((v) => v !== BLANK && v !== null && v !== undefined && v !== '').length;
    case 'countNums':
      return n;
    case 'average':
      return mean;
    case 'max':
      return n ? Math.max(...nums) : 0;
    case 'min':
      return n ? Math.min(...nums) : 0;
    case 'product':
      return n ? nums.reduce((a, b) => a * b, 1) : 0;
    case 'stdDev':
      return n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
    case 'stdDevp':
      return n ? Math.sqrt(ss / n) : 0;
    case 'var':
      return n > 1 ? ss / (n - 1) : 0;
    case 'varp':
      return n ? ss / n : 0;
    default:
      return sum;
  }
}

/** A pivot's source as records: its range's first row the names, each row below a record. `value` reads a cell (the
 * engine's value, or the grid's: the engine keeps its results there). */
export function pivotSource(book: Workbook, p: PivotTable, value: (sheet: number, row: number, col: number) => Scalar): PivotSource | null {
  const index = book.sheets.findIndex((s) => s.name.toLowerCase() === p.cache.sheet.toLowerCase());
  const range = parseRange(p.cache.ref);
  if (index < 0 || !range) return null;
  const width = range.c1 - range.c0 + 1;
  const names = Array.from({ length: width }, (_, i) => String(value(index, range.r0, range.c0 + i) ?? ''));
  const records: Scalar[][] = [];
  for (let r = range.r0 + 1; r <= range.r1; r++) records.push(Array.from({ length: width }, (_, i) => value(index, r, range.c0 + i)));
  return { names, records };
}

/** A cell's value as the grid holds it (a formula's last result). */
export function gridValue(book: Workbook, sheetIndex: number, row: number, col: number): Scalar {
  const sheet = book.sheets[sheetIndex];
  if (!sheet || !isWorksheet(sheet)) return BLANK;
  const column = sheet.grid.columns[col];
  const kind = column?.kind(row) ?? Kind.Empty;
  const v = column?.value(row) ?? 0;
  switch (kind) {
    case Kind.Number:
      return v;
    case Kind.String:
      return book.strings.get(v);
    case Kind.Boolean:
      return v !== 0;
    default:
      return BLANK;
  }
}

/**
 * Refresh: a sheet's pivot (by its place in the list) laid out again from its source, its cells written where its old ones
 * were (cleared first), and the pivot's place, items and cache's values brought up to date. A pivot that would grow over
 * cells that are not its own is refused (`pivotOverlap`), as is one this layout does not know (`pivotUnsupported`).
 */
export function refreshPivot(book: Workbook, sheet: Worksheet, index: number): { range: CellRange | null; message?: string } {
  const p = sheet.pivots[index];
  if (!p) return { range: null };
  if (!pivotSupported(p)) return { range: null, message: 'pivotUnsupported' };
  const source = pivotSource(book, p, (s, r, c) => gridValue(book, s, r, c));
  if (!source) return { range: null, message: 'pivotUnsupported' };
  const layout = pivotLayout(p, source);
  const old = p.location;
  const at = { r0: old.r0, c0: old.c0, r1: old.r0 + layout.rows - 1, c1: old.c0 + layout.cols - 1 };
  const grid = sheet.grid;
  // Its filters sit above its body, a blank row between: those rows are its own too.
  const above = p.pageFields.length ? p.pageFields.length + 1 : 0;
  const inOld = (r: number, c: number) => r >= old.r0 - above && r <= old.r1 && c >= old.c0 && c <= Math.max(old.c1, old.c0 + 1);
  for (let r = at.r0 - above; r <= at.r1; r++) {
    for (let c = at.c0; c <= at.c1; c++) {
      if (inOld(r, c)) continue;
      const kind = grid.columns[c]?.kind(r) ?? Kind.Empty;
      if (kind !== Kind.Empty && kind !== Kind.Blank) return { range: null, message: 'pivotOverlap' };
    }
  }
  for (let c = old.c0; c <= Math.max(old.c1, old.c0 + 1); c++) {
    const column = grid.columns[c];
    if (!column) continue;
    for (let r = Math.max(0, old.r0 - above); r <= old.r1; r++) {
      if (column.formulaAt(r)) column.setFormula(r, null);
      grid.set(r, c, Kind.Empty, 0, 0);
    }
  }
  // Values in the data field's own number format, when it has one.
  const formats = p.dataFields.map((d) => (d.numFmtId ? restyle(book.styles, 0, { numFmt: book.styles.formatCode(d.numFmtId) }, { top: false, bottom: false, left: false, right: false }, null) : 0));
  for (const cell of layout.cells) {
    const r = at.r0 + cell.row;
    const c = at.c0 + cell.col;
    if (r < 0) continue;
    if (typeof cell.value === 'number') grid.set(r, c, Kind.Number, cell.value, formats[cell.data ?? 0] ?? 0);
    else grid.set(r, c, Kind.String, book.strings.add(cell.value), 0);
  }
  const fields = p.fields.map((f, i) => ({ ...f, items: layout.items[i] ?? f.items }));
  const cache = { ...p.cache, fields: p.cache.fields.map((f, i) => ({ ...f, shared: layout.shared[i], summary: layout.summaries[i] })) };
  // Other pivots of the same cache share its values.
  sheet.pivots = sheet.pivots.map((x, i) => (i === index ? { ...p, location: at, fields, cache, look: layout.look, refreshed: true } : x.cache.part === cache.part ? { ...x, cache } : x));
  return { range: { r0: Math.min(old.r0, at.r0), c0: Math.min(old.c0, at.c0), r1: Math.max(old.r1, at.r1), c1: Math.max(old.c1, at.c1) } };
}


/** Whether a pivot's shape is one this layout knows (more is kept as read, not refreshed here): the values (-2) last on
 * their axis, after at most one field there. */
export function pivotSupported(p: PivotTable): boolean {
  const ok = (fields: number[]) => {
    const at = fields.indexOf(-2);
    return at < 0 || (at === fields.length - 1 && at <= 1);
  };
  return p.rowFields.length > 0 && p.dataFields.length > 0 && ok(p.rowFields) && ok(p.colFields);
}

/** A node of an axis's tree: an item of a field (`field`, `item`: a shared value's index) or a value field (`data`). */
interface AxisNode {
  field: number;
  data: number | null;
  label: string | number;
  children: AxisNode[];
  /** The records under it. */
  records: number[];
}

/** Lays a pivot out from its source records (see the top of the file). */
export function pivotLayout(p: PivotTable, source: PivotSource): PivotLayout {
  const fieldCount = p.cache.fields.length;
  // Each field's items: the existing order, then values new to the cache, in the cache's order.
  const shared = p.cache.fields.map((f) => [...f.shared]);
  const items = p.fields.map((f) => [...f.items]);
  const axisFields = [...new Set([...p.rowFields, ...p.colFields, ...p.pageFields.map((f) => f.field)].filter((f) => f >= 0))];
  const recordIndex: number[][] = source.records.map(() => Array(fieldCount).fill(-1));
  for (const f of axisFields) {
    const known = new Map(shared[f].map((v, i) => [key(v), i]));
    source.records.forEach((rec, r) => {
      const raw = rec[f];
      const v = raw === BLANK || raw === undefined || typeof raw === 'object' ? null : raw;
      const k = key(v);
      let i = known.get(k);
      if (i === undefined) {
        i = shared[f].length;
        known.set(k, i);
        shared[f].push(v as string | number | boolean | null);
      }
      recordIndex[r][f] = i;
    });
    // Values the field's items do not list yet (new to the cache, or added to it by another pivot's refresh) go after
    // them, in the cache's order, as Excel adds them.
    const listed = new Set(items[f] ?? []);
    const missing = [...new Set(recordIndex.map((r) => r[f]))].filter((i) => !listed.has(i)).sort((a, b) => a - b);
    items[f] = [...(items[f] ?? []), ...missing];
    // A sorted field's items in order of their values (Excel saves them so; new ones go in their places).
    const sort = p.fields[f]?.sort;
    if (sort) items[f].sort((a, b) => compareItems(shared[f][a], shared[f][b], sort === 'descending'));
  }
  const label = (f: number, i: number) => {
    const v = shared[f][i];
    return v === null ? '(blank)' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : v;
  };
  // Filters: only the records of the items they show; and none of a hidden item's, on any axis.
  let all = source.records.map((_, r) => r);
  for (const page of p.pageFields) {
    if (page.item === null) continue;
    const shown = items[page.field]?.[page.item];
    all = all.filter((r) => recordIndex[r][page.field] === shown);
  }
  for (const f of axisFields) {
    const hidden = new Set(p.fields[f]?.hidden ?? []);
    if (hidden.size) all = all.filter((r) => !hidden.has(recordIndex[r][f]));
  }
  /** The tree of an axis's fields over some records: items with records under them, in the field's order. */
  const tree = (levels: number[], depth: number, under: number[]): AxisNode[] => {
    if (depth >= levels.length) return [];
    const f = levels[depth];
    if (f === -2) return p.dataFields.map((d, data) => ({ field: -2, data, label: d.name, children: tree(levels, depth + 1, under), records: under }));
    return (items[f] ?? []).flatMap((i) => {
      const here = under.filter((r) => recordIndex[r][f] === i);
      return here.length ? [{ field: f, data: null, label: label(f, i), children: tree(levels, depth + 1, here), records: here }] : [];
    });
  };
  /** A value cell: the records under both its row's and its column's items, in a value field. */
  const valueOf = (rows: number[], cols: number[], data: number) => {
    const set = new Set(cols);
    const values = rows.filter((r) => set.has(r)).map((r) => source.records[r][p.dataFields[data].field] ?? BLANK);
    // No records where the row and column meet: the cell stays empty, as Excel leaves it.
    return values.length ? aggregate(p.dataFields[data].fn, values) : null;
  };
  const cells: PivotCell[] = [];
  const put = (row: number, col: number, value: string | number | null, role: PivotCell['role'], indent?: number, data?: number) => {
    if (value !== null) cells.push({ row, col, value, role, ...(indent !== undefined && { indent }), ...(data !== undefined && { data }) });
  };
  // The row labels' columns (one for the compact layout); the values after them.
  const labels = rowLabelColumns(p);
  const dc = labels.count;
  // Columns: the column fields' tree, a subtotal after an outer item's group (not over the values), grand totals last.
  const colLevels = p.colFields;
  const header = colLevels.length ? 1 + colLevels.length : 1;
  const columns: { records: number[]; data: number | null; kind: PivotLook['cols'][number] }[] = [];
  const walkCols = (nodes: AxisNode[], depth: number) => {
    for (const n of nodes) {
      put(1 + depth, dc + columns.length, n.label, 'header');
      if (!n.children.length) {
        columns.push({ records: n.records, data: n.data, kind: 'item' });
        continue;
      }
      walkCols(n.children, depth + 1);
      if (colLevels[depth + 1] !== -2 && p.fields[n.field]?.subtotal !== false) {
        put(1 + depth, dc + columns.length, `${n.label} Total`, 'header');
        columns.push({ records: n.records, data: n.data, kind: 'sub' });
      }
    }
  };
  if (colLevels.length) {
    walkCols(tree(colLevels, 0, all), 0);
    const real = colLevels.some((f) => f >= 0);
    if (real && p.grandCols) {
      if (colLevels.includes(-2)) {
        p.dataFields.forEach((d, data) => {
          put(1, dc + columns.length, `Total ${d.name}`, 'header');
          columns.push({ records: all, data, kind: 'grand' });
        });
      } else {
        put(1, dc + columns.length, 'Grand Total', 'header');
        columns.push({ records: all, data: null, kind: 'grand' });
      }
    }
    // The caption row: the value's name (when there is one), and what is across.
    if (p.dataFields.length === 1) put(0, 0, p.dataFields[0].name, 'header');
    put(0, dc, real ? p.colHeader : p.dataCaption, 'header');
  } else {
    columns.push({ records: all, data: null, kind: 'item' });
    // One value, and not down the rows: its name heads the column.
    if (!p.rowFields.includes(-2)) put(0, dc, p.dataFields[0].name, 'header');
  }
  // The label columns' heads: the row header, then the name of the field each further column starts with.
  put(header - 1, 0, p.rowHeader, 'header');
  p.rowFields.forEach((f, d) => {
    if (labels.col[d] > 0 && labels.col[d - 1] !== labels.col[d]) put(header - 1, labels.col[d], f === -2 ? p.dataCaption : (p.cache.fields[f]?.name ?? ''), 'header');
  });
  // Rows: the row fields' tree. An item with items under it has a row of its own (outline) holding its subtotal (at the
  // top), or a subtotal row after them (at the bottom); in the tabular layout its first inner item is on its row and its
  // subtotal after them. No subtotals over the values.
  let row = header;
  const rowLooks: PivotRowLook[] = [];
  const endRow = (look: PivotRowLook) => {
    rowLooks.push(look);
    row++;
  };
  const rowValues = (under: number[], data: number | null, role: PivotCell['role']) =>
    columns.forEach((c, j) => {
      const d = data ?? c.data ?? 0;
      put(row, dc + j, valueOf(under, c.records, d), role, undefined, d);
    });
  const walkRows = (nodes: AxisNode[], depth: number) => {
    for (const n of nodes) {
      const leaf = !n.children.length;
      put(row, labels.col[depth], n.label, leaf ? 'label' : 'subtotal', labels.indent[depth]);
      if (leaf) {
        rowValues(n.records, n.data, 'value');
        endRow({ depth, leaf, subtotal: false, grand: false });
        continue;
      }
      const options = rowFieldOptions(p, depth);
      const subtotals = p.rowFields[depth + 1] !== -2 && p.fields[n.field]?.subtotal !== false;
      const top = options.outline && options.subtotalTop;
      if (options.outline) {
        if (subtotals && top) rowValues(n.records, n.data, 'subtotal');
        endRow({ depth, leaf, subtotal: false, grand: false });
      }
      walkRows(n.children, depth + 1);
      if (subtotals && !top) {
        put(row, labels.col[depth], `${n.label} Total`, 'subtotal', labels.indent[depth]);
        rowValues(n.records, n.data, 'subtotal');
        endRow({ depth, leaf, subtotal: true, grand: false });
      }
    }
  };
  walkRows(tree(p.rowFields, 0, all), 0);
  if (p.grandRows) {
    if (p.rowFields.includes(-2)) {
      p.dataFields.forEach((d, data) => {
        put(row, 0, `Total ${d.name}`, 'grand');
        rowValues(all, data, 'grand');
        endRow({ depth: 0, leaf: true, subtotal: false, grand: true });
      });
    } else {
      put(row, 0, 'Grand Total', 'grand');
      rowValues(all, null, 'grand');
      endRow({ depth: 0, leaf: true, subtotal: false, grand: true });
    }
  }
  // Filters above the body, a blank row between: each field's name, and the item it shows.
  p.pageFields.forEach((page, k) => {
    const r = -(p.pageFields.length + 1) + k;
    put(r, 0, p.cache.fields[page.field]?.name ?? '', 'header');
    const several = page.item === null && !!p.fields[page.field]?.hidden?.length;
    put(r, 1, page.item === null ? (several ? '(Multiple Items)' : '(All)') : label(page.field, items[page.field]?.[page.item] ?? 0), 'label');
  });
  const summaries = p.cache.fields.map((_, f): FieldSummary => {
    const values = source.records.map((rec) => rec[f]);
    const numbers = values.filter((v): v is number => typeof v === 'number');
    return {
      strings: values.some((v) => typeof v === 'string' || typeof v === 'boolean'),
      numbers: numbers.length > 0,
      integers: numbers.every(Number.isInteger),
      blank: values.some((v) => v === BLANK || v === undefined),
      min: numbers.length ? Math.min(...numbers) : null,
      max: numbers.length ? Math.max(...numbers) : null,
    };
  });
  return { cells, rows: row, cols: dc + columns.length, shared, items, summaries, firstHeaderRow: header > 1 ? 1 : 0, firstDataRow: header, firstDataCol: dc, look: { headerRows: header, labelCols: dc, rows: rowLooks, cols: columns.map((c) => c.kind) } };
}

/** A row field's layout, by its place in the row fields (the values, -2, take the compact layout). */
function rowFieldOptions(p: PivotTable, depth: number): { compact: boolean; outline: boolean; subtotalTop: boolean } {
  const f = p.fields[p.rowFields[depth]];
  return { compact: f?.compact !== false, outline: f?.outline !== false, subtotalTop: f?.subtotalTop !== false };
}

const labelColumns = new WeakMap<PivotTable, { col: number[]; indent: number[]; count: number }>();

/** Where each row field's labels go (by its place in the row fields): its column, and its indent there. A field after a
 * compact one (in the outline layout) shares its column, indented one more; any other starts a column of its own. */
export function rowLabelColumns(p: PivotTable): { col: number[]; indent: number[]; count: number } {
  let out = labelColumns.get(p);
  if (!out) {
    const col: number[] = [];
    const indent: number[] = [];
    p.rowFields.forEach((_, d) => {
      const before = d > 0 ? rowFieldOptions(p, d - 1) : null;
      const shares = !!before && before.compact && before.outline;
      col.push(d === 0 ? 0 : shares ? col[d - 1] : col[d - 1] + 1);
      indent.push(d === 0 ? 0 : shares ? indent[d - 1] + 1 : 0);
    });
    out = { col, indent, count: col.length ? col[col.length - 1] + 1 : 1 };
    labelColumns.set(p, out);
  }
  return out;
}

/** Excel's order for a sorted field's items: numbers, then text (ignoring case), then logical values; blanks last. */
function compareItems(a: string | number | boolean | null, b: string | number | boolean | null, descending: boolean): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const rank = (v: string | number | boolean) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
  let c = rank(a) - rank(b);
  if (!c) {
    const x = typeof a === 'string' ? a.toLowerCase() : +a;
    const y = typeof b === 'string' ? b.toLowerCase() : +b;
    c = x < y ? -1 : x > y ? 1 : 0;
  }
  return descending ? -c : c;
}

// --- The field list ----------------------------------------------------------------------------------------------------

/** What the field list chooses: the source's fields (by place) down, across, as values (with their functions) and as
 * filters (with the item each shows, as its text, or null for all). */
export interface PivotChoice {
  rows: number[];
  cols: number[];
  values: { field: number; fn: PivotFunction }[];
  filters: { field: number; item: string | null }[];
  /** Its layout down the rows, where its subtotals go, and which grand totals it shows (as they were when left out). */
  layout?: PivotLayoutKind;
  subtotals?: 'top' | 'bottom' | 'none';
  grand?: 'both' | 'rows' | 'cols' | 'none';
}

export type PivotLayoutKind = 'compact' | 'outline' | 'tabular';

const FN_NAMES: Record<PivotFunction, string> = { sum: 'Sum', count: 'Count', average: 'Average', max: 'Max', min: 'Min', product: 'Product', countNums: 'Count', stdDev: 'StdDev', stdDevp: 'StdDevp', var: 'Var', varp: 'Varp' };

/** A pivot's fields as the field list shows them. */
export function pivotChoice(p: PivotTable): PivotChoice {
  return {
    rows: p.rowFields.filter((f) => f >= 0),
    cols: p.colFields.filter((f) => f >= 0),
    values: p.dataFields.map((d) => ({ field: d.field, fn: d.fn })),
    filters: p.pageFields.map((f) => {
      const shared = f.item === null ? undefined : p.fields[f.field]?.items[f.item];
      const v = shared === undefined ? null : p.cache.fields[f.field]?.shared[shared];
      return { field: f.field, item: v === null || v === undefined ? null : String(v) };
    }),
    ...pivotOptions(p),
  };
}

/** A pivot's layout, subtotals and grand totals, as the field list shows them (its first row field's layout). */
export function pivotOptions(p: PivotTable): Required<Pick<PivotChoice, 'layout' | 'subtotals' | 'grand'>> {
  const rows = p.rowFields.filter((f) => f >= 0).map((f) => p.fields[f]);
  const first = rows[0];
  const layout: PivotLayoutKind = first?.outline === false ? 'tabular' : first?.compact === false ? 'outline' : 'compact';
  const subtotals = rows.length && rows.every((f) => f?.subtotal === false) ? 'none' : rows.some((f) => f?.subtotalTop === false) || layout === 'tabular' ? 'bottom' : 'top';
  const grand = p.grandRows && p.grandCols ? 'both' : p.grandRows ? 'rows' : p.grandCols ? 'cols' : 'none';
  return { layout, subtotals, grand };
}

/** A pivot given the field list's choice: its fields' places and its values; the values across when there are several. */
export function applyChoice(p: PivotTable, choice: PivotChoice): PivotTable {
  const names = p.cache.fields.map((f) => f.name);
  const several = choice.values.length > 1;
  const used = new Set([...choice.rows, ...choice.cols, ...choice.filters.map((f) => f.field)]);
  const fields = p.cache.fields.map(
    (_, i): PivotField => {
      const field: PivotField = {
        ...p.fields[i],
        axis: choice.rows.includes(i) ? 'row' : choice.cols.includes(i) ? 'col' : choice.filters.some((f) => f.field === i) ? 'page' : null,
        items: used.has(i) ? [...(p.fields[i]?.items ?? [])] : [],
        subtotal: p.fields[i]?.subtotal ?? true,
      };
      if (!used.has(i)) delete field.hidden;
      // The layout and subtotals the choice gives (all fields alike, as Excel's Report Layout and Subtotals set them).
      if (choice.layout) {
        delete field.compact;
        delete field.outline;
        if (choice.layout !== 'compact') field.compact = false;
        if (choice.layout === 'tabular') field.outline = false;
      }
      if (choice.subtotals) {
        field.subtotal = choice.subtotals !== 'none';
        delete field.subtotalTop;
        if (choice.subtotals === 'bottom') field.subtotalTop = false;
      }
      return field;
    },
  );
  // A filter's item: its place in the field's items (its value added to the cache when the cache does not have it yet).
  const cache = { ...p.cache, fields: p.cache.fields.map((f) => ({ ...f, shared: [...f.shared] })) };
  const pageFields = choice.filters.map(({ field, item }) => {
    if (item === null) return { field, item: null };
    const shared = cache.fields[field].shared;
    let at = shared.findIndex((v) => v !== null && String(v).toLowerCase() === item.toLowerCase());
    if (at < 0) at = shared.push(item) - 1;
    let place = fields[field].items.indexOf(at);
    if (place < 0) place = fields[field].items.push(at) - 1;
    return { field, item: place };
  });
  return {
    ...p,
    rowFields: choice.rows,
    colFields: several ? [...choice.cols, -2] : choice.cols,
    pageFields,
    dataFields: choice.values.map((v) => ({ name: `${FN_NAMES[v.fn]} of ${names[v.field] ?? ''}`, field: v.field, fn: v.fn, numFmtId: null })),
    fields,
    cache,
    ...(choice.grand && { grandRows: choice.grand === 'both' || choice.grand === 'rows', grandCols: choice.grand === 'both' || choice.grand === 'cols' }),
    look: undefined,
    refreshed: true,
  };
}

// --- Sorting and filtering a field (its button's card) --------------------------------------------------------------

/** Where a pivot's field buttons are (sheet cells) and the fields each is for: a label column's head (the fields whose
 * labels are in that column), the column labels' head, and each filter's item. `filtered` when one of its fields hides
 * items or shows one. */
export function pivotButtons(p: PivotTable, look: PivotLook): { row: number; col: number; fields: number[]; filtered: boolean }[] {
  const out: { row: number; col: number; fields: number[]; filtered: boolean }[] = [];
  const { r0, c0 } = p.location;
  const filtered = (fields: number[]) => fields.some((f) => !!p.fields[f]?.hidden?.length || p.pageFields.some((page) => page.field === f && page.item !== null));
  const labels = rowLabelColumns(p);
  for (let c = 0; c < look.labelCols; c++) {
    const fields = p.rowFields.filter((f, d) => f >= 0 && labels.col[d] === c);
    if (fields.length) out.push({ row: r0 + look.headerRows - 1, col: c0 + c, fields, filtered: filtered(fields) });
  }
  const across = p.colFields.filter((f) => f >= 0);
  if (across.length) out.push({ row: r0, col: c0 + look.labelCols, fields: across, filtered: filtered(across) });
  p.pageFields.forEach((page, k) => out.push({ row: r0 - (p.pageFields.length + 1) + k, col: c0 + 1, fields: [page.field], filtered: filtered([page.field]) }));
  return out;
}

/** An item's text, as the pivot shows it. */
function itemText(p: PivotTable, field: number, shared: number): string {
  const v = p.cache.fields[field]?.shared[shared];
  return v === null || v === undefined ? '(blank)' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
}

/** A field's items (their texts, in its order) and those shown (null: all of them), for its card. */
export function pivotFieldItems(p: PivotTable, field: number): { values: string[]; shown: string[] | null } {
  const f = p.fields[field];
  if (!f) return { values: [], shown: null };
  const values = f.items.map((x) => itemText(p, field, x));
  const page = p.pageFields.find((x) => x.field === field);
  if (page && page.item !== null) return { values, shown: [values[page.item] ?? ''] };
  const hidden = new Set(f.hidden ?? []);
  return { values, shown: hidden.size ? f.items.filter((x) => !hidden.has(x)).map((x) => itemText(p, field, x)) : null };
}

/** A pivot with a field sorted, or showing only some of its items (null: all). A filter showing one item shows it as its
 * item; showing several, as hidden items, as Excel does. */
export function setPivotField(p: PivotTable, field: number, change: { sort?: 'ascending' | 'descending'; shown?: string[] | null }): PivotTable {
  const f = p.fields[field];
  if (!f) return p;
  const next: PivotField = { ...f };
  if (change.sort) next.sort = change.sort;
  let pageFields = p.pageFields;
  if (change.shown !== undefined) {
    const shown = change.shown && new Set(change.shown.map((v) => v.toLowerCase()));
    const hidden = shown ? f.items.filter((x) => !shown.has(itemText(p, field, x).toLowerCase())) : [];
    delete next.hidden;
    const isPage = p.pageFields.some((x) => x.field === field);
    const single = isPage && shown && f.items.length - hidden.length === 1 ? f.items.findIndex((x) => !hidden.includes(x)) : -1;
    if (isPage) pageFields = p.pageFields.map((x) => (x.field === field ? { field, item: single >= 0 ? single : null } : x));
    if (hidden.length && single < 0) next.hidden = hidden;
  }
  return { ...p, fields: p.fields.map((x, i) => (i === field ? next : x)), pageFields, look: undefined, refreshed: true };
}

/** A new pivot (Insert › PivotTable) of a block of cells, its first row the fields' names; laid out by a refresh. */
export function newPivot(sourceSheet: string, block: CellRange, names: string[], name: string, at: CellRange): PivotTable {
  return {
    name,
    location: at,
    rowFields: [],
    colFields: [],
    pageFields: [],
    dataFields: [],
    fields: names.map(() => ({ axis: null, items: [], subtotal: true })),
    dataCaption: 'Values',
    rowHeader: 'Row Labels',
    colHeader: 'Column Labels',
    grandRows: true,
    grandCols: true,
    style: { ...DEFAULT_PIVOT_STYLE },
    part: '',
    cache: { part: '', sheet: sourceSheet, ref: rangeName(block), fields: names.map((n) => ({ name: n, shared: [] })) },
    refreshed: true,
  };
}

// --- The look --------------------------------------------------------------------------------------------------------

const looks = new WeakMap<PivotTable, PivotLook | null>();

/** A pivot's shape for drawing: as saved or last laid out, or (for one saved without it, as this app saves them) laid
 * out once from its source. */
export function pivotLookOf(book: Workbook, p: PivotTable): PivotLook | null {
  if (p.look) return p.look;
  let look = looks.get(p);
  if (look === undefined) {
    const source = pivotSupported(p) ? pivotSource(book, p, (s, r, c) => gridValue(book, s, r, c)) : null;
    look = source ? pivotLayout(p, source).look : null;
    looks.set(p, look);
  }
  return look;
}

/** What a pivot style paints a cell with: a table style's paint, and a row label's indent and alignment. */
export interface PivotPaint extends TablePaint {
  indent?: number;
  left?: boolean;
}

/**
 * How a built-in pivot style (PivotStyleLight1-28, Medium1-28, Dark1-28) paints a cell at `row`, `col` from the pivot's
 * top left (its body's, not its filters'). Each style uses one theme colour by its number (black, or accents 1 to 6,
 * going round), as Excel's do; this follows their shape (shaded or lined headers and grand totals, bold outer items,
 * stripes), not every pixel. Row labels are indented by their depth whatever the style.
 */
export function pivotPaint(p: PivotTable, look: PivotLook, row: number, col: number, accents: number[], dark: number): PivotPaint | null {
  const out: PivotPaint = {};
  const body = row - look.headerRows;
  const at = body >= 0 ? look.rows[body] : undefined;
  if (body >= 0 && !at) return null;
  if (at && col < look.labelCols) {
    out.left = true;
    const labels = rowLabelColumns(p);
    const indent = labels.col[at.depth] === col ? labels.indent[at.depth] : 0;
    if (!at.grand && indent) out.indent = indent;
  }
  const m = /^PivotStyle(Light|Medium|Dark)(\d+)$/.exec(p.style.name);
  if (m) {
    const family = m[1];
    const n = +m[2];
    const accent = (n - 1) % 7 === 0 ? dark : accents[((n - 1) % 7) - 1] ?? dark;
    const group = Math.floor((n - 1) / 7);
    const tint = (t: number) => mixTo(accent, 0xffffff, t);
    const header = body < 0 && p.style.colHeaders;
    const lastHeader = body === -1;
    const grand = !!at?.grand || (body >= 0 && look.cols[col - look.labelCols] === 'grand' && p.style.colHeaders);
    // An outer item's row, with its subtotal (or a subtotal row of its own).
    const outer = !!at && !at.grand && (!at.leaf || at.subtotal) && at.depth === 0 && p.style.rowHeaders;
    const stripe = !!at && !at.grand && ((p.style.rowStripes && body % 2 === 0) || (p.style.colStripes && col >= look.labelCols && (col - look.labelCols) % 2 === 0));
    if (family === 'Light') {
      if (header) {
        if (group === 1) Object.assign(out, { fill: accent, bold: true, color: 0xffffff });
        else Object.assign(out, { fill: group >= 2 ? tint(0.8) : undefined, bold: true, bottom: lastHeader ? accent : undefined });
      } else if (at?.grand) Object.assign(out, { fill: group >= 2 ? tint(0.8) : undefined, bold: true, top: accent });
      else if (outer) Object.assign(out, { bold: true, fill: group === 3 ? tint(0.9) : undefined, bottom: group === 1 ? undefined : accent });
      else if (stripe) out.fill = tint(0.8);
    } else if (family === 'Medium') {
      if (header) Object.assign(out, { fill: accent, bold: true, color: 0xffffff });
      else if (at?.grand) Object.assign(out, { fill: tint(0.4), bold: true, top: accent });
      else if (outer) Object.assign(out, { fill: tint(0.6), bold: true });
      else if (grand) Object.assign(out, { fill: tint(0.8), bold: true });
      else if (stripe) out.fill = tint(0.8);
    } else {
      if (header) Object.assign(out, { fill: mixTo(accent, 0x000000, 0.5), bold: true, color: 0xffffff });
      else if (at?.grand) Object.assign(out, { fill: mixTo(accent, 0x000000, 0.5), bold: true, color: 0xffffff });
      else if (outer) Object.assign(out, { fill: accent, bold: true, color: 0xffffff });
      else Object.assign(out, { fill: stripe || grand ? tint(0.4) : tint(0.6) });
    }
  }
  for (const k of Object.keys(out) as (keyof PivotPaint)[]) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : null;
}
