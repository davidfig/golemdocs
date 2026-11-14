// What Screen Reader Mode says about a workbook (docs/architecture/accessibility.md, "Spreadsheets"): the cells are drawn on
// the canvas, so moving the active cell, selecting a range, switching sheets and picking a chart are announced in words
// built here. Only called while the mode is on (view.ts `speak`), so nobody else pays for them.

import { t } from '../i18n/index.ts';
import { stripMnemonic } from '../ui/dom.ts';
import { MAX_COLUMNS, MAX_ROWS, columnName } from './model/column.ts';
import type { CellRange } from './model/worksheet.ts';
import type { ChartKindName } from './protocol.ts';
import { cellName } from './refs.ts';

/** A cell's shown value is cut to this many characters: a long text would hold up the next move for too long. */
export const SPOKEN_VALUE = 300;

/** What is known about the active cell, as far as a screen reader is told it. */
export interface SpokenCell {
  row: number;
  col: number;
  /** Its value as shown ('' for an empty cell). */
  display: string;
  /** Its formula with its `=`, when it has one that can be shown. */
  formula?: string | null;
  /** The merged range it starts, if any. */
  merged?: CellRange | null;
  /** Its note's text, if it has one. */
  note?: string | null;
  /** A list validation offers choices (Alt+Down). */
  list?: boolean;
  /** It is on a filter's header row (Alt+Down opens the filter). */
  filter?: boolean;
  /** Locked, on a protected sheet. */
  locked?: boolean;
  /** Inside a PivotTable. */
  pivot?: boolean;
}

const cut = (text: string): string => (text.length > SPOKEN_VALUE ? `${text.slice(0, SPOKEN_VALUE)}…` : text);

/** "B2, 42, formula =A2*2, note: Check this, locked": the address, what it shows, and what else is on the cell. */
export function cellMessage(cell: SpokenCell): string {
  const parts = [cellName(cell.row, cell.col), cell.display ? cut(cell.display) : t('a11y.sheet.blank')];
  if (cell.formula) parts.push(t('a11y.sheet.formula', { formula: cut(cell.formula) }));
  if (cell.merged && (cell.merged.r0 !== cell.merged.r1 || cell.merged.c0 !== cell.merged.c1)) parts.push(t('a11y.sheet.merged', { from: cellName(cell.merged.r0, cell.merged.c0), to: cellName(cell.merged.r1, cell.merged.c1) }));
  if (cell.note) parts.push(t('a11y.sheet.note', { text: cut(cell.note) }));
  if (cell.list) parts.push(t('a11y.sheet.list'));
  if (cell.filter) parts.push(t('a11y.sheet.filter'));
  if (cell.pivot) parts.push(t('a11y.sheet.pivot'));
  if (cell.locked) parts.push(t('a11y.sheet.locked'));
  return parts.join(', ');
}

/** "B2 to D5 selected", or whole columns, rows or the sheet; `count` ranges in all (Ctrl+click added the others). */
export function rangeMessage(range: CellRange, count = 1): string {
  const allRows = range.r0 === 0 && range.r1 >= MAX_ROWS - 1;
  const allCols = range.c0 === 0 && range.c1 >= MAX_COLUMNS - 1;
  let text: string;
  if (allRows && allCols) text = t('a11y.sheet.all');
  else if (allRows) text = range.c0 === range.c1 ? t('a11y.sheet.column', { name: columnName(range.c0) }) : t('a11y.sheet.columns', { from: columnName(range.c0), to: columnName(range.c1) });
  else if (allCols) text = range.r0 === range.r1 ? t('a11y.sheet.row', { number: range.r0 + 1 }) : t('a11y.sheet.rows', { from: range.r0 + 1, to: range.r1 + 1 });
  else if (range.r0 === range.r1 && range.c0 === range.c1) text = t('a11y.sheet.one', { cell: cellName(range.r0, range.c0) });
  else text = t('a11y.sheet.range', { from: cellName(range.r0, range.c0), to: cellName(range.r1, range.c1) });
  return count > 1 ? `${text}, ${t('a11y.sheet.rangeCount', { count })}` : text;
}

/** "Data, sheet 2 of 3": said when another sheet shows. */
export const sheetMessage = (name: string, index: number, count: number): string => t('a11y.sheet.sheet', { name, index: index + 1, count });

const CHART_KINDS = {
  column: 'sheet.op.chartColumn',
  bar: 'sheet.op.chartBar',
  line: 'sheet.op.chartLine',
  area: 'sheet.op.chartArea',
  pie: 'sheet.op.chartPie',
  doughnut: 'sheet.op.chartDoughnut',
  scatter: 'sheet.op.chartScatter',
} as const satisfies Record<ChartKindName, string>;

/** "Column chart: Sales, 1 of 2": a chart picked, by its kind and its title. */
export function chartMessage(kind: ChartKindName | null | undefined, title: string | null | undefined, index: number, count: number): string {
  const name = kind ? t('a11y.sheet.chartKind', { kind: stripMnemonic(t(CHART_KINDS[kind])) }) : t('a11y.sheet.chart');
  const titled = title?.trim() ? t('a11y.sheet.chartTitled', { chart: name, title: cut(title.trim()) }) : name;
  return t('a11y.sheet.of', { item: titled, index: index + 1, count });
}
