// Tables (Excel's "Format as Table", docs/spreadsheets.md M5): a named range with a header row of column names, maybe a
// totals row, and a style. Read from the sheet's table parts (xl/tables/tableN.xml); formulas reach them by structured
// references (`Sales[Amount]`, `Sales[[#This Row],[Price]]`, `[@Price]` inside the table), resolved here into ranges.
// The built-in styles are drawn as Excel draws them in kind: a header in the style's colour, banded rows tinted from it.

import { child, el, elements, textContent } from '@golemdocs/docx';
import type { XmlElement } from '@golemdocs/docx';
import type { CellRange } from './model/worksheet.ts';
import { parseRange, rangeName } from './refs.ts';
import { autoFilterElement, readAutoFilter } from './filter.ts';
import type { AutoFilter, FilterColumn } from './filter.ts';

export interface Table {
  name: string;
  /** What formulas call it (Excel's displayName). */
  displayName: string;
  range: CellRange;
  columns: string[];
  /** It has a header row (headerRowCount is not 0). */
  header: boolean;
  /** It has a totals row. */
  totals: boolean;
  style: string | null;
  rowStripes: boolean;
  columnStripes: boolean;
  firstColumn: boolean;
  lastColumn: boolean;
  /** The table part it was read from ('' for a table made here, until it is first written), its relationship from the
   * sheet, and its XML, written back with the range as it now is. */
  part: string;
  rId?: string;
  xml: XmlElement;
  /** Its own AutoFilter's columns (buttons on its header row), or null when it has none. */
  filterColumns: FilterColumn[] | null;
}

/** A column's `<calculatedColumnFormula>` (file form, for the first data row), or null. */
export function calculatedFormula(t: Table, index: number): string | null {
  const column = [...elements(child(t.xml, 'tableColumns') ?? t.xml)].filter((c) => c.name === 'tableColumn')[index];
  const f = column && child(column, 'calculatedColumnFormula');
  return f ? textContent(f) : null;
}

/** The table with a column's calculated formula set (its XML copied: the old table stays as it was, for undo). */
export function withCalculated(t: Table, index: number, formula: string): Table {
  const xml = structuredClone(t.xml);
  const column = [...elements(child(xml, 'tableColumns') ?? xml)].filter((c) => c.name === 'tableColumn')[index];
  if (!column) return t;
  column.children = [...column.children.filter((c) => typeof c === 'string' || c.name !== 'calculatedColumnFormula'), el('calculatedColumnFormula', {}, [formula])];
  return { ...t, xml };
}

/** A table's AutoFilter: its header and data rows (not a totals row), and the columns it filters. */
export function tableFilter(t: Table): AutoFilter | null {
  return t.filterColumns && t.header ? { range: { ...t.range, r1: t.range.r1 - (t.totals ? 1 : 0) }, columns: t.filterColumns } : null;
}

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/** A table made here (Sheet › Insert Table), with a header row and banded rows in Excel's default style. */
export function newTable(id: number, name: string, range: CellRange, columns: string[]): Table {
  const ref = rangeName(range);
  const xml = el('table', { xmlns: MAIN, id, name, displayName: name, ref, totalsRowShown: 0 }, [
    el('autoFilter', { ref }),
    el('tableColumns', { count: columns.length }, columns.map((c, i) => el('tableColumn', { id: i + 1, name: c }))),
    el('tableStyleInfo', { name: 'TableStyleMedium2', showFirstColumn: 0, showLastColumn: 0, showRowStripes: 1, showColumnStripes: 0 }),
  ]);
  return { name, displayName: name, range, columns, header: true, totals: false, style: 'TableStyleMedium2', rowStripes: true, columnStripes: false, firstColumn: false, lastColumn: false, part: '', xml, filterColumns: [] };
}

export function readTable(root: XmlElement, part: string): Table | null {
  const a = root.attrs;
  const range = a.ref ? parseRange(a.ref) : null;
  if (!range) return null;
  const info = child(root, 'tableStyleInfo');
  const on = (v: string | undefined) => v === '1' || v === 'true';
  return {
    name: a.name ?? a.displayName ?? '',
    displayName: a.displayName ?? a.name ?? '',
    range,
    columns: [...elements(child(root, 'tableColumns') ?? root)].filter((c) => c.name === 'tableColumn').map((c) => c.attrs.name ?? ''),
    header: a.headerRowCount !== '0',
    totals: !!a.totalsRowCount && a.totalsRowCount !== '0',
    style: info?.attrs.name ?? null,
    rowStripes: on(info?.attrs.showRowStripes),
    columnStripes: on(info?.attrs.showColumnStripes),
    firstColumn: on(info?.attrs.showFirstColumn),
    lastColumn: on(info?.attrs.showLastColumn),
    part,
    xml: root,
    filterColumns: readAutoFilter(root)?.columns ?? null,
  };
}

/** The table's XML with its range as it now is (and its AutoFilter's, which covers all but a totals row). */
export function tableXml(table: Table): XmlElement {
  const root = table.xml;
  root.attrs.ref = rangeName(table.range);
  // The AutoFilter comes first in a table's XML.
  const filter = tableFilter(table);
  const at = root.children.findIndex((c) => typeof c !== 'string' && c.name === 'autoFilter');
  if (filter && at >= 0) root.children[at] = autoFilterElement(filter);
  else if (filter) root.children.unshift(autoFilterElement(filter));
  else if (at >= 0) root.children.splice(at, 1);
  return root;
}

/** The rows of a table's data (between its header and its totals). */
export const dataRows = (t: Table): [number, number] => [t.range.r0 + (t.header ? 1 : 0), t.range.r1 - (t.totals ? 1 : 0)];

/** A column name as written inside brackets ('-escaped [ ] # ' characters taken out). */
const unescape = (name: string): string => name.replace(/'(.)/g, '$1').trim();

/** Splits a specifier's inside at its top-level commas. */
function items(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "'") i++;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(inner.slice(start).trim());
  return out.filter((s) => s !== '');
}

/**
 * The range a structured reference's specifier (`[Amount]`, `[[#Headers],[A]:[C]]`, `[@Price]`, `[#All]`) names in a table,
 * for a formula in row `row`; null when it names nothing (a column that is not there, This Row outside the data).
 */
export function resolveStructured(table: Table, spec: string, row: number): CellRange | null {
  let inner = spec.trim();
  if (!inner.startsWith('[') || !inner.endsWith(']')) return null;
  inner = inner.slice(1, -1).trim();
  let thisRow = false;
  if (inner.startsWith('@')) {
    thisRow = true;
    inner = inner.slice(1).trim();
    if (inner && !inner.startsWith('[')) inner = `[${inner}]`;
  }
  // A plain column name, as in `Table1[Amount]`.
  if (inner && !inner.startsWith('[') && !inner.startsWith('#')) inner = `[${inner}]`;
  const keywords = new Set<string>();
  let c0 = 0;
  let c1 = table.columns.length - 1;
  const column = (name: string) => table.columns.findIndex((c) => c.toLowerCase() === unescape(name).toLowerCase());
  for (const item of items(inner)) {
    const span = /^\[(.*?)\]\s*:\s*\[(.*)\]$/s.exec(item);
    if (span) {
      const a = column(span[1]);
      const b = column(span[2]);
      if (a < 0 || b < 0) return null;
      c0 = Math.min(a, b);
      c1 = Math.max(a, b);
      continue;
    }
    const single = /^\[(.*)\]$/s.exec(item);
    const word = (single ? single[1] : item).trim();
    if (word.startsWith('#')) {
      keywords.add(word.toLowerCase());
      continue;
    }
    const a = column(word);
    if (a < 0) return null;
    c0 = c1 = a;
  }
  const [d0, d1] = dataRows(table);
  let r0: number;
  let r1: number;
  if (thisRow || keywords.has('#this row')) {
    if (row < d0 || row > d1) return null;
    r0 = r1 = row;
  } else if (keywords.has('#all')) {
    [r0, r1] = [table.range.r0, table.range.r1];
  } else {
    const headers = keywords.has('#headers');
    const totals = keywords.has('#totals');
    const data = keywords.has('#data') || (!headers && !totals);
    if (headers && !table.header) return null;
    if (totals && !table.totals) return null;
    r0 = headers ? table.range.r0 : data ? d0 : table.range.r1;
    r1 = totals ? table.range.r1 : data ? d1 : table.range.r0;
  }
  return { r0, c0: table.range.c0 + c0, r1, c1: table.range.c0 + c1 };
}

/** What a built-in table style paints a cell of the table with: a fill, a bold font, a font colour, a line under it. */
export interface TablePaint {
  fill?: number;
  bold?: boolean;
  color?: number;
  /** A line along the top or bottom of the cell (RGB). */
  top?: number;
  bottom?: number;
}

/**
 * How a built-in style (TableStyleLight1-21, Medium1-28, Dark1-11) paints a cell. Each family uses one theme colour by its
 * number (black, or accents 1 to 6, going round), as Excel's do; this follows their shape, not every pixel.
 */
export function tablePaint(table: Table, row: number, col: number, accents: number[], dark: number): TablePaint | null {
  const m = /^TableStyle(Light|Medium|Dark)(\d+)$/.exec(table.style ?? '');
  if (!m) return null;
  const family = m[1];
  const n = +m[2];
  const accent = (n - 1) % 7 === 0 ? dark : accents[((n - 1) % 7) - 1] ?? dark;
  const [d0, d1] = dataRows(table);
  const isHeader = table.header && row === table.range.r0;
  const isTotal = table.totals && row === table.range.r1;
  const band = table.rowStripes && row >= d0 && row <= d1 && (row - d0) % 2 === 0;
  const colBand = table.columnStripes && (col - table.range.c0) % 2 === 0;
  const tint = (t: number) => mixTo(accent, 0xffffff, t);
  const out: TablePaint = {};
  if (family === 'Medium') {
    if (isHeader) Object.assign(out, { fill: accent, bold: true, color: 0xffffff });
    else if (isTotal) Object.assign(out, { bold: true, top: accent });
    else if (band || colBand) out.fill = tint(0.8);
  } else if (family === 'Dark') {
    if (isHeader) Object.assign(out, { fill: 0x000000, bold: true, color: 0xffffff, bottom: 0xffffff });
    else if (isTotal) Object.assign(out, { fill: mixTo(accent, 0x000000, 0.5), bold: true, color: 0xffffff });
    else Object.assign(out, { fill: band || colBand ? mixTo(accent, 0x000000, 0.25) : accent, color: 0xffffff });
  } else {
    if (isHeader) Object.assign(out, { bold: true, bottom: accent });
    else if (isTotal) Object.assign(out, { bold: true, top: accent });
    else if (band || colBand) out.fill = tint(0.8);
  }
  if ((table.firstColumn && col === table.range.c0) || (table.lastColumn && col === table.range.c1)) out.bold = true;
  return out.fill === undefined && !out.bold && out.color === undefined && out.top === undefined && out.bottom === undefined ? null : out;
}

function mixTo(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
