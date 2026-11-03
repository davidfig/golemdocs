// AutoFilter (Sheet › Filter): a range whose first row holds buttons, and for some of its columns the values to show; the
// rows of the range that show anything else are hidden. Read from and written to the sheet's `<autoFilter>` (a column
// filtered another way than by values, such as a custom or top-10 filter, is kept as it was and left alone).

import { el, elements } from '@golemdocs/docx';
import type { XmlElement } from '@golemdocs/docx';
import { displayText } from './format/display.ts';
import { Kind } from './model/column.ts';
import type { Workbook } from './model/workbook.ts';
import type { CellRange, Worksheet } from './model/worksheet.ts';
import { parseRange, rangeName } from './refs.ts';

export interface FilterColumn {
  /** Offset of the column in the range. */
  col: number;
  /** The values shown (as the cells show them); null: the column is filtered another way (kept in `element`). */
  values: string[] | null;
  /** Empty cells are shown too. */
  blanks: boolean;
  /** The column's element as read, kept for filters other than by values. */
  element?: XmlElement;
}

export interface AutoFilter {
  range: CellRange;
  columns: FilterColumn[];
}

export function readAutoFilter(root: XmlElement): AutoFilter | null {
  const e = [...elements(root)].find((c) => c.name === 'autoFilter');
  const range = e?.attrs.ref ? parseRange(e.attrs.ref) : null;
  if (!e || !range) return null;
  const columns: FilterColumn[] = [];
  for (const fc of elements(e)) {
    if (fc.name !== 'filterColumn') continue;
    const col = +(fc.attrs.colId ?? 0);
    const filters = [...elements(fc)].find((c) => c.name === 'filters');
    if (filters) columns.push({ col, values: [...elements(filters)].filter((f) => f.name === 'filter').map((f) => f.attrs.val ?? ''), blanks: filters.attrs.blank === '1' || filters.attrs.blank === 'true' });
    else columns.push({ col, values: null, blanks: false, element: fc });
  }
  return { range, columns };
}

export function autoFilterElement(filter: AutoFilter): XmlElement {
  return el(
    'autoFilter',
    { ref: rangeName(filter.range) },
    filter.columns.map((c) =>
      c.values === null && c.element
        ? c.element
        : el('filterColumn', { colId: c.col }, [el('filters', c.blanks ? { blank: 1 } : {}, (c.values ?? []).map((v) => el('filter', { val: v })))]),
    ),
  );
}

/** A cell's text as a filter compares it: what it shows, or null when it is empty. */
export function filterText(book: Workbook, sheet: Worksheet, row: number, col: number): string | null {
  const column = sheet.grid.columns[col];
  const kind = column?.kind(row) ?? Kind.Empty;
  if (kind === Kind.Empty || kind === Kind.Blank) return null;
  const text = displayText(book, kind, column!.value(row), column!.style(row)).text;
  return text === '' ? null : text;
}

/** The distinct values of a column of the filter (below its header), sorted, and whether some cells are empty. */
export function filterValues(book: Workbook, sheet: Worksheet, filter: AutoFilter, col: number): { values: string[]; blanks: boolean } {
  const seen = new Set<string>();
  let blanks = false;
  for (let row = filter.range.r0 + 1; row <= filter.range.r1; row++) {
    const text = filterText(book, sheet, row, col);
    if (text === null) blanks = true;
    else seen.add(text);
  }
  const values = [...seen].sort((a, b) => {
    const x = Number(a.replace(/[,$%]/g, ''));
    const y = Number(b.replace(/[,$%]/g, ''));
    return Number.isFinite(x) && Number.isFinite(y) ? x - y : a.localeCompare(b, undefined, { sensitivity: 'base' });
  });
  return { values, blanks };
}

/** Hides the rows of the range that a column's filter does not show, and shows the rest. */
export function applyFilter(book: Workbook, sheet: Worksheet, filter: AutoFilter): void {
  const tests = filter.columns
    .filter((c) => c.values !== null)
    .map((c) => {
      const shown = new Set(c.values!.map((v) => v.toLowerCase()));
      return (row: number) => {
        const text = filterText(book, sheet, row, filter.range.c0 + c.col);
        return text === null ? c.blanks : shown.has(text.toLowerCase());
      };
    });
  for (let row = filter.range.r0 + 1; row <= filter.range.r1; row++) sheet.rowSizes.setHidden(row, !tests.every((test) => test(row)));
}
