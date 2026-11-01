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
import { parseRange } from './refs.ts';

/** A cache's field: its name, and the values its items index (`sharedItems`, in their order). */
export interface CacheField {
  name: string;
  shared: (string | number | boolean | null)[];
}

export interface PivotCache {
  part: string;
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
}

export interface PivotTable {
  name: string;
  /** Where it is: its top left, and its size as last laid out. */
  location: CellRange;
  rowFields: number[];
  /** Fields across; -2 stands for the values (when there are several). */
  colFields: number[];
  pageFields: number[];
  dataFields: DataField[];
  fields: PivotField[];
  /** Captions Excel shows (`dataCaption`, the row and column headers' own names when set). */
  dataCaption: string;
  rowHeader: string;
  colHeader: string;
  grandRows: boolean;
  grandCols: boolean;
  part: string;
  cache: PivotCache;
  /** Laid out here since it was read: its parts are brought in line when the workbook is written. */
  refreshed?: boolean;
}

const local = (e: XmlElement) => e.name.slice(e.name.indexOf(':') + 1);
const kid = (e: XmlElement | undefined, name: string) => (e ? [...elements(e)].find((c) => local(c) === name) : undefined);
const kids = (e: XmlElement | undefined, name: string) => (e ? [...elements(e)].filter((c) => local(c) === name) : []);
const off = (v: string | undefined) => v === '0' || v === 'false';

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
  const fields = kids(kid(root, 'pivotFields'), 'pivotField').map(
    (f): PivotField => ({
      axis: axes[f.attrs.axis ?? ''] ?? null,
      items: kids(kid(f, 'items'), 'item')
        .filter((i) => i.attrs.x !== undefined && !i.attrs.t)
        .map((i) => +i.attrs.x!),
      subtotal: !off(f.attrs.defaultSubtotal),
    }),
  );
  const fieldList = (name: string) => kids(kid(root, name), 'field').map((f) => +(f.attrs.x ?? 0));
  const a = root.attrs;
  return {
    name: a.name ?? '',
    location,
    rowFields: fieldList('rowFields'),
    colFields: fieldList('colFields'),
    pageFields: kids(kid(root, 'pageFields'), 'pageField').map((f) => +(f.attrs.fld ?? 0)),
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
    part,
    cache,
  };
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
}

export interface PivotLayout {
  cells: PivotCell[];
  rows: number;
  cols: number;
  /** The fields' items in order after the refresh (shared values, possibly with new ones appended in the order they
   * first come in the source), for writing. */
  shared: CacheField['shared'][];
  items: number[][];
  firstHeaderRow: number;
  firstDataRow: number;
  firstDataCol: number;
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
  const inOld = (r: number, c: number) => r >= old.r0 && r <= old.r1 && c >= old.c0 && c <= old.c1;
  for (let r = at.r0; r <= at.r1; r++) {
    for (let c = at.c0; c <= at.c1; c++) {
      if (inOld(r, c)) continue;
      const kind = grid.columns[c]?.kind(r) ?? Kind.Empty;
      if (kind !== Kind.Empty && kind !== Kind.Blank) return { range: null, message: 'pivotOverlap' };
    }
  }
  for (let c = old.c0; c <= old.c1; c++) {
    const column = grid.columns[c];
    if (!column) continue;
    for (let r = old.r0; r <= old.r1; r++) {
      if (column.formulaAt(r)) column.setFormula(r, null);
      grid.set(r, c, Kind.Empty, 0, 0);
    }
  }
  // Values in the data field's own number format, when it has one.
  const formats = p.dataFields.map((d) => (d.numFmtId ? restyle(book.styles, 0, { numFmt: book.styles.formatCode(d.numFmtId) }, { top: false, bottom: false, left: false, right: false }, null) : 0));
  const colField = p.colFields.find((f) => f !== -2);
  for (const cell of layout.cells) {
    const r = at.r0 + cell.row;
    const c = at.c0 + cell.col;
    if (typeof cell.value === 'number') grid.set(r, c, Kind.Number, cell.value, formats[colField === undefined ? Math.max(0, cell.col - 1) % Math.max(1, p.dataFields.length) : 0] ?? 0);
    else grid.set(r, c, Kind.String, book.strings.add(cell.value), 0);
  }
  const fields = p.fields.map((f, i) => ({ ...f, items: layout.items[i] ?? f.items }));
  const cache = { ...p.cache, fields: p.cache.fields.map((f, i) => ({ ...f, shared: layout.shared[i] })) };
  // Other pivots of the same cache share its values.
  sheet.pivots = sheet.pivots.map((x, i) => (i === index ? { ...p, location: at, fields, cache, refreshed: true } : x.cache.part === cache.part ? { ...x, cache } : x));
  return { range: { r0: Math.min(old.r0, at.r0), c0: Math.min(old.c0, at.c0), r1: Math.max(old.r1, at.r1), c1: Math.max(old.c1, at.c1) } };
}

/** Whether a pivot's shape is one this layout knows (more is kept as read, not refreshed here). */
export function pivotSupported(p: PivotTable): boolean {
  const realCols = p.colFields.filter((f) => f !== -2);
  return p.rowFields.length > 0 && p.dataFields.length > 0 && realCols.length <= 1 && (realCols.length === 0 || p.dataFields.length === 1) && !p.pageFields.length;
}

/** Lays a pivot out from its source records (see the top of the file). */
export function pivotLayout(p: PivotTable, source: PivotSource): PivotLayout {
  const fieldCount = p.cache.fields.length;
  // Each field's items: the existing order, then values new to the cache, sorted.
  const shared = p.cache.fields.map((f) => [...f.shared]);
  const items = p.fields.map((f) => [...f.items]);
  const axisFields = [...p.rowFields, ...p.colFields.filter((f) => f !== -2)];
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
  }
  // Only items with data show.
  const used = axisFields.map((f) => new Set(recordIndex.map((r) => r[f])));
  const shown = (f: number) => items[f].filter((i) => used[axisFields.indexOf(f)].has(i));
  const label = (f: number, i: number) => {
    const v = shared[f][i];
    return v === null ? '(blank)' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : v;
  };
  const colField = p.colFields.find((f) => f !== -2);
  const colItems = colField === undefined ? [] : shown(colField);
  const dataCols = colField === undefined ? p.dataFields.map((_, d) => ({ item: null as number | null, data: d })) : [...colItems.map((item) => ({ item, data: 0 })), ...(p.grandCols ? [{ item: null, data: 0 }] : [])];
  const valueOf = (match: (rec: number[]) => boolean, col: { item: number | null; data: number }) => {
    const d = p.dataFields[col.data];
    const values: Scalar[] = [];
    source.records.forEach((rec, r) => {
      if (!match(recordIndex[r])) return;
      if (colField !== undefined && col.item !== null && recordIndex[r][colField] !== col.item) return;
      values.push(rec[d.field] ?? BLANK);
    });
    // No records where the row and column meet: the cell stays empty, as Excel leaves it.
    return values.length ? aggregate(d.fn, values) : null;
  };
  const push = (row: number, col: number, value: number | null, role: PivotCell['role']) => {
    if (value !== null) cells.push({ row, col, value, role });
  };
  const cells: PivotCell[] = [];
  // Headers: two rows when something is across (a column field, or several values), else one.
  const twoRows = colField !== undefined || p.dataFields.length > 1;
  const headerRow = twoRows ? 1 : 0;
  if (twoRows) {
    if (colField !== undefined) cells.push({ row: 0, col: 0, value: p.dataFields[0].name, role: 'header' });
    cells.push({ row: 0, col: 1, value: colField !== undefined ? p.colHeader : p.dataCaption, role: 'header' });
  }
  cells.push({ row: headerRow, col: 0, value: p.rowHeader, role: 'header' });
  dataCols.forEach((c, j) => cells.push({ row: headerRow, col: 1 + j, value: colField === undefined ? p.dataFields[c.data].name : c.item === null ? 'Grand Total' : label(colField, c.item), role: 'header' }));
  // Rows: the row fields' items, outer first, an outer item's subtotal on its own row.
  let row = headerRow + 1;
  const walk = (depth: number, match: (rec: number[]) => boolean) => {
    const f = p.rowFields[depth];
    for (const i of shown(f)) {
      const here = (rec: number[]) => match(rec) && rec[f] === i;
      if (!source.records.some((_, r) => here(recordIndex[r]))) continue;
      const last = depth === p.rowFields.length - 1;
      cells.push({ row, col: 0, value: label(f, i), role: last ? 'label' : 'subtotal', indent: depth });
      if (last || p.fields[f]?.subtotal !== false) dataCols.forEach((c, j) => push(row, 1 + j, valueOf(here, c), last ? 'value' : 'subtotal'));
      row++;
      if (!last) walk(depth + 1, here);
    }
  };
  walk(0, () => true);
  if (p.grandRows) {
    cells.push({ row, col: 0, value: 'Grand Total', role: 'grand' });
    dataCols.forEach((c, j) => push(row, 1 + j, valueOf(() => true, c), 'grand'));
    row++;
  }
  return { cells, rows: row, cols: 1 + dataCols.length, shared, items, firstHeaderRow: twoRows ? 1 : 0, firstDataRow: headerRow + 1, firstDataCol: 1 };
}
