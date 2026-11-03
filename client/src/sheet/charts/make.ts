// Making a chart from a block of cells (Insert › Chart), as Excel does: series down the columns, the first row's text
// their names, the first column's text the categories (a scatter chart's first column is its x values). The chart goes
// beside the block, eight columns wide and fifteen rows high, and is written from the model when the workbook is saved.

import { displayText } from '../format/display.ts';
import { quoteSheet } from '../formula/move.ts';
import { Kind, columnName } from '../model/column.ts';
import type { Workbook } from '../model/workbook.ts';
import type { CellRange, Worksheet } from '../model/worksheet.ts';
import type { Chart, ChartGroup, ChartKind, ChartSeries, SheetChart } from './model.ts';

/** What Insert › Chart offers: Excel's chart kinds, columns and bars being one kind turned two ways. */
export type NewChartKind = 'column' | 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter';

/** A block's cells as a chart reads them. */
function cellText(book: Workbook, sheet: Worksheet, row: number, col: number): { text: string; number: number | null } {
  const column = sheet.grid.columns[col];
  const kind = column?.kind(row) ?? Kind.Empty;
  if (kind === Kind.Empty || kind === Kind.Blank) return { text: '', number: null };
  const value = column!.value(row);
  return { text: displayText(book, kind, value, column!.style(row)).text, number: kind === Kind.Number ? value : null };
}

/** An absolute reference to a column's or row's cells (`Sales!$B$2:$B$7`). */
function absolute(sheet: string, r0: number, c0: number, r1: number, c1: number): string {
  const cell = (r: number, c: number) => `$${columnName(c)}$${r + 1}`;
  return `${quoteSheet(sheet)}!${cell(r0, c0)}${r0 === r1 && c0 === c1 ? '' : `:${cell(r1, c1)}`}`;
}

/** The kind of chart group a new chart's kind is. */
export function groupKind(kind: NewChartKind): { kind: ChartKind; direction: 'col' | 'bar' } {
  return kind === 'column' ? { kind: 'bar', direction: 'col' } : kind === 'bar' ? { kind: 'bar', direction: 'bar' } : { kind, direction: 'col' };
}

/** A chart of a block of cells, or null when the block has no numbers to show. */
export function newChart(book: Workbook, sheet: Worksheet, block: CellRange, kind: NewChartKind): SheetChart | null {
  const { r0, c0, r1, c1 } = block;
  // A first row of text (but for its corner) is the series' names; a first column of text is the categories.
  let header = r1 > r0;
  for (let c = c0; c <= c1 && header; c++) if (cellText(book, sheet, r0, c).number !== null) header = false;
  let labels = c1 > c0;
  for (let r = header ? r0 + 1 : r0; r <= r1 && labels; r++) if (cellText(book, sheet, r, c0).number !== null) labels = false;
  const scatter = kind === 'scatter';
  // A scatter chart's first column is its x values, labelled or not.
  const firstSeries = labels || (scatter && c1 > c0) ? c0 + 1 : c0;
  const d0 = header ? r0 + 1 : r0;
  if (firstSeries > c1 || d0 > r1) return null;
  const name = sheet.name;
  const rows = Array.from({ length: r1 - d0 + 1 }, (_, i) => d0 + i);
  const cats = labels || scatter ? rows.map((r) => cellText(book, sheet, r, c0)) : [];
  const g = groupKind(kind);
  const single = kind === 'pie' || kind === 'doughnut';
  const series: ChartSeries[] = [];
  for (let c = firstSeries; c <= c1 && !(single && series.length); c++) {
    const vals = rows.map((r) => cellText(book, sheet, r, c).number);
    series.push({
      name: header ? cellText(book, sheet, r0, c).text || `Series${series.length + 1}` : `Series${series.length + 1}`,
      nameRef: header ? absolute(name, r0, c, r0, c) : null,
      catRef: !scatter && labels ? absolute(name, d0, c0, r1, c0) : null,
      cats: scatter ? [] : cats.map((x) => x.text),
      valRef: absolute(name, d0, c, r1, c),
      vals,
      xRef: scatter && firstSeries > c0 ? absolute(name, d0, c0, r1, c0) : null,
      xs: scatter ? cats.map((x) => x.number) : [],
      color: null,
      pointColors: {},
      line: kind !== 'scatter',
      markers: kind === 'scatter',
    });
  }
  if (!series.some((s) => s.vals.some((v) => v !== null))) return null;
  const group: ChartGroup = { ...g, grouping: g.kind === 'bar' ? 'clustered' : 'standard', series, varyColors: single, gapWidth: 219, holeSize: 75, firstSliceAngle: 0 };
  const axis = { min: null, max: null, numFmt: null, gridlines: false, deleted: false };
  const chart: Chart = {
    title: series.length === 1 ? series[0].name : 'Chart Title',
    legend: single || series.length > 1 ? 'b' : null,
    groups: [group],
    valueAxis: { ...axis, gridlines: true },
    categoryAxis: axis,
  };
  // Beside the block, as Excel places a new chart near its data.
  const col = c1 + 2;
  return { anchor: { from: { row: r0, col, dx: 0, dy: 0 }, to: { row: r0 + 15, col: col + 8, dx: 0, dy: 0 } }, chart, part: '', rId: '', drawingPart: '', generate: true };
}

/** A reference as typed (`=Sales!$B$2:$B$7`, `B2:B7`): with its sheet, or null when it is not a range of cells. */
export function chartRef(text: string, sheet: string): string | null {
  const t = text.trim().replace(/^=/, '');
  if (!t) return null;
  const bang = t.lastIndexOf('!');
  const where = bang < 0 ? quoteSheet(sheet) : t.slice(0, bang);
  const cells = bang < 0 ? t : t.slice(bang + 1);
  if (!/^\$?[A-Za-z]{1,3}\$?\d+(:\$?[A-Za-z]{1,3}\$?\d+)?$/.test(cells)) return null;
  if (bang >= 0 && !/^('([^']|'')+'|[A-Za-z_][\w.]*)$/.test(where)) return null;
  return `${where}!${cells.toUpperCase()}`;
}

/** A chart's series as Select Data gave them (the chart's existing series keep their looks by place), or null when a
 * reference is not a range of cells. */
export function withData(chart: Chart, data: { series: { name: string; values: string }[]; categories: string }, sheet: string): ChartGroup[] | null {
  const all = chart.groups.flatMap((g) => g.series);
  const catRef = data.categories.trim() ? chartRef(data.categories, sheet) : null;
  if (data.categories.trim() && !catRef) return null;
  const scatter = chart.groups[0].kind === 'scatter';
  const series: ChartSeries[] = [];
  for (const [i, s] of data.series.entries()) {
    const valRef = chartRef(s.values, sheet);
    if (!valRef) return null;
    const named = s.name.trim().startsWith('=');
    const nameRef = named ? chartRef(s.name, sheet) : null;
    if (named && !nameRef) return null;
    const old = all[i];
    series.push({
      name: named ? (old?.name ?? `Series${i + 1}`) : s.name.trim() || `Series${i + 1}`,
      nameRef,
      catRef: scatter ? null : catRef,
      cats: [],
      valRef,
      vals: [],
      xRef: scatter ? catRef : null,
      xs: [],
      color: old?.color ?? null,
      pointColors: old?.pointColors ?? {},
      line: old?.line ?? chart.groups[0].kind !== 'scatter',
      markers: old?.markers ?? chart.groups[0].kind === 'scatter',
    });
  }
  if (!series.length) return null;
  // Every series goes into the first group (a combination chart becomes one kind).
  return [{ ...chart.groups[0], series }];
}

/** A chart turned into another kind: its series kept, its grouping and colours as the new kind has them. */
export function changeKind(c: SheetChart, kind: NewChartKind): SheetChart {
  const g = groupKind(kind);
  const single = kind === 'pie' || kind === 'doughnut';
  const old = c.chart.groups[0];
  const series = c.chart.groups.flatMap((x) => x.series).slice(0, single ? 1 : undefined);
  const group: ChartGroup = {
    ...old,
    ...g,
    grouping: g.kind === 'bar' ? (old.grouping === 'standard' ? 'clustered' : old.grouping) : old.grouping === 'clustered' ? 'standard' : old.grouping,
    series: series.map((s) => ({ ...s, line: kind !== 'scatter', markers: kind === 'scatter' || (kind === 'line' && s.markers), xRef: kind === 'scatter' ? (s.xRef ?? s.catRef) : null, catRef: kind === 'scatter' ? null : (s.catRef ?? s.xRef) })),
    varyColors: single,
  };
  if (single || g.kind === 'scatter' || g.kind === 'line') group.grouping = g.kind === 'line' && old.grouping !== 'clustered' ? old.grouping : 'standard';
  return { ...c, chart: { ...c.chart, groups: [group], legend: c.chart.legend ?? (single ? 'b' : null) } };
}
