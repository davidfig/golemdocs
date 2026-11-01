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
  sheet.pivots = sheet.pivots.map((x, i) => (i === index ? { ...p, location: at, fields, cache, refreshed: true } : x.cache.part === cache.part ? { ...x, cache } : x));
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
  }
  const label = (f: number, i: number) => {
    const v = shared[f][i];
    return v === null ? '(blank)' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : v;
  };
  // Filters: only the records of the items they show.
  let all = source.records.map((_, r) => r);
  for (const page of p.pageFields) {
    if (page.item === null) continue;
    const shown = items[page.field]?.[page.item];
    all = all.filter((r) => recordIndex[r][page.field] === shown);
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
  // Columns: the column fields' tree, a subtotal after an outer item's group (not over the values), grand totals last.
  const colLevels = p.colFields;
  const header = colLevels.length ? 1 + colLevels.length : 1;
  const columns: { records: number[]; data: number | null }[] = [];
  const walkCols = (nodes: AxisNode[], depth: number) => {
    for (const n of nodes) {
      put(1 + depth, 1 + columns.length, n.label, 'header');
      if (!n.children.length) {
        columns.push({ records: n.records, data: n.data });
        continue;
      }
      walkCols(n.children, depth + 1);
      if (colLevels[depth + 1] !== -2 && p.fields[n.field]?.subtotal !== false) {
        put(1 + depth, 1 + columns.length, `${n.label} Total`, 'header');
        columns.push({ records: n.records, data: n.data });
      }
    }
  };
  if (colLevels.length) {
    walkCols(tree(colLevels, 0, all), 0);
    const real = colLevels.some((f) => f >= 0);
    if (real && p.grandCols) {
      if (colLevels.includes(-2)) {
        p.dataFields.forEach((d, data) => {
          put(1, 1 + columns.length, `Total ${d.name}`, 'header');
          columns.push({ records: all, data });
        });
      } else {
        put(1, 1 + columns.length, 'Grand Total', 'header');
        columns.push({ records: all, data: null });
      }
    }
    // The caption row: the value's name (when there is one), and what is across.
    if (p.dataFields.length === 1) put(0, 0, p.dataFields[0].name, 'header');
    put(0, 1, real ? p.colHeader : p.dataCaption, 'header');
  } else {
    columns.push({ records: all, data: null });
    // One value, and not down the rows: its name heads the column.
    if (!p.rowFields.includes(-2)) put(0, 1, p.dataFields[0].name, 'header');
  }
  put(header - 1, 0, p.rowHeader, 'header');
  // Rows: the row fields' tree, an outer item's row holding its subtotal (but not when the values are under it).
  let row = header;
  const rowValues = (under: number[], data: number | null, role: PivotCell['role']) =>
    columns.forEach((c, j) => {
      const d = data ?? c.data ?? 0;
      put(row, 1 + j, valueOf(under, c.records, d), role, undefined, d);
    });
  const walkRows = (nodes: AxisNode[], depth: number) => {
    for (const n of nodes) {
      const leaf = !n.children.length;
      put(row, 0, n.label, leaf ? 'label' : 'subtotal', depth);
      if (leaf) rowValues(n.records, n.data, 'value');
      else if (p.rowFields[depth + 1] !== -2 && p.fields[n.field]?.subtotal !== false) rowValues(n.records, n.data, 'subtotal');
      row++;
      if (!leaf) walkRows(n.children, depth + 1);
    }
  };
  walkRows(tree(p.rowFields, 0, all), 0);
  if (p.grandRows) {
    if (p.rowFields.includes(-2)) {
      p.dataFields.forEach((d, data) => {
        put(row, 0, `Total ${d.name}`, 'grand');
        rowValues(all, data, 'grand');
        row++;
      });
    } else {
      put(row, 0, 'Grand Total', 'grand');
      rowValues(all, null, 'grand');
      row++;
    }
  }
  // Filters above the body, a blank row between: each field's name, and the item it shows.
  p.pageFields.forEach((page, k) => {
    const r = -(p.pageFields.length + 1) + k;
    put(r, 0, p.cache.fields[page.field]?.name ?? '', 'header');
    put(r, 1, page.item === null ? '(All)' : label(page.field, items[page.field]?.[page.item] ?? 0), 'label');
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
  return { cells, rows: row, cols: 1 + columns.length, shared, items, summaries, firstHeaderRow: header > 1 ? 1 : 0, firstDataRow: header, firstDataCol: 1 };
}

// --- The field list ----------------------------------------------------------------------------------------------------

/** What the field list chooses: the source's fields (by place) down, across, as values (with their functions) and as
 * filters (with the item each shows, as its text, or null for all). */
export interface PivotChoice {
  rows: number[];
  cols: number[];
  values: { field: number; fn: PivotFunction }[];
  filters: { field: number; item: string | null }[];
}

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
  };
}

/** A pivot given the field list's choice: its fields' places and its values; the values across when there are several. */
export function applyChoice(p: PivotTable, choice: PivotChoice): PivotTable {
  const names = p.cache.fields.map((f) => f.name);
  const several = choice.values.length > 1;
  const used = new Set([...choice.rows, ...choice.cols, ...choice.filters.map((f) => f.field)]);
  const fields = p.cache.fields.map(
    (_, i): PivotField => ({
      axis: choice.rows.includes(i) ? 'row' : choice.cols.includes(i) ? 'col' : choice.filters.some((f) => f.field === i) ? 'page' : null,
      items: used.has(i) ? [...(p.fields[i]?.items ?? [])] : [],
      subtotal: p.fields[i]?.subtotal ?? true,
    }),
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
    refreshed: true,
  };
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
    part: '',
    cache: { part: '', sheet: sourceSheet, ref: rangeName(block), fields: names.map((n) => ({ name: n, shared: [] })) },
    refreshed: true,
  };
}
