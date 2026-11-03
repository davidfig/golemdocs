// A sheet's sparklines laid out for drawing (docs/spreadsheets.md, M6): all of them in one scene in sheet points (one
// batch for the page to draw, however many cells have one). Each is drawn inside its cell from its values now: a line
// (with markers and coloured high, low, first, last and negative points as its group asks), columns, or win/loss bars.

import type { Engine } from '../formula/engine.ts';
import { resolveColor } from '../model/theme.ts';
import type { Workbook } from '../model/workbook.ts';
import type { Worksheet } from '../model/worksheet.ts';
import type { ChartScene } from '../protocol.ts';
import type { SparklineGroup } from '../sparklines.ts';
import { Painter, numbersOf } from './scene.ts';

/** Excel's colours for a group that does not give its own. */
const DEFAULTS = { series: 0x376092, negative: 0xd00000, axis: 0x000000, markers: 0xd00000, first: 0xd00000, last: 0xd00000, high: 0xd00000, low: 0xd00000 };

const PAD_X = 2;
const PAD_Y = 2.5;

/** One scene with every sparkline of the sheet, or null when it has none. */
export function sparklineScene(book: Workbook, engine: Engine, sheetIndex: number, sheet: Worksheet): ChartScene | null {
  if (!sheet.sparklines.some((g) => g.sparklines.length)) return null;
  const p = new Painter();
  for (const group of sheet.sparklines) drawGroup(p, book, engine, sheetIndex, sheet, group);
  return {
    id: `${sheetIndex}:sparklines`,
    x: 0,
    y: 0,
    width: sheet.colSizes.total(),
    height: sheet.rowSizes.total(),
    points: Float32Array.from(p.points),
    colors: Uint32Array.from(p.colors),
    texts: [],
    title: null,
    data: { series: [], categories: '' },
  };
}

function drawGroup(p: Painter, book: Workbook, engine: Engine, sheetIndex: number, sheet: Worksheet, g: SparklineGroup): void {
  const color = (key: keyof typeof DEFAULTS) => resolveColor(g.colors[key], book.theme, DEFAULTS[key]);
  const series = g.sparklines.map((s) => numbersOf(engine, book, sheetIndex, s.ref, []));
  // The group's own scale, when its sparklines share one.
  const all = series.flat().filter((v): v is number => v !== null);
  const groupLo = all.length ? Math.min(...all) : 0;
  const groupHi = all.length ? Math.max(...all) : 0;
  g.sparklines.forEach((s, i) => {
    if (sheet.rowSizes.hidden(s.row) || sheet.colSizes.hidden(s.col)) return;
    const values = series[i];
    const numbers = values.filter((v): v is number => v !== null);
    if (!numbers.length) return;
    const x0 = sheet.colSizes.position(s.col) + PAD_X;
    const y0 = sheet.rowSizes.position(s.row) + PAD_Y;
    const w = sheet.colSizes.size(s.col) - PAD_X * 2;
    const h = sheet.rowSizes.size(s.row) - PAD_Y * 2;
    if (w <= 2 || h <= 2) return;
    let lo = g.minAxis === 'custom' && g.manualMin !== null ? g.manualMin : g.minAxis === 'group' ? groupLo : Math.min(...numbers);
    let hi = g.maxAxis === 'custom' && g.manualMax !== null ? g.manualMax : g.maxAxis === 'group' ? groupHi : Math.max(...numbers);
    // Columns stand on zero when the values are all on one side of it.
    if (g.kind === 'column') ((lo = Math.min(lo, 0)), (hi = Math.max(hi, 0)));
    if (hi <= lo) hi = lo + 1;
    const n = values.length;
    const yOf = (v: number) => y0 + h - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * h;
    const highest = Math.max(...numbers);
    const lowest = Math.min(...numbers);
    const firstAt = values.findIndex((v) => v !== null);
    const lastAt = values.length - 1 - [...values].reverse().findIndex((v) => v !== null);
    /** The colour of a point: the group's colours for the special ones, in Excel's order of precedence. */
    const pointColor = (v: number, k: number, base: number): number | null => {
      if (g.high && v === highest) return color('high');
      if (g.low && v === lowest) return color('low');
      if (g.first && k === firstAt) return color('first');
      if (g.last && k === lastAt) return color('last');
      if (g.negative && v < 0) return color('negative');
      return base === -1 ? null : base;
    };
    if (g.kind === 'line') {
      const step = n > 1 ? w / (n - 1) : 0;
      const at = (k: number): [number, number] => [x0 + (n > 1 ? k * step : w / 2), yOf(values[k]!)];
      if (g.axis && lo < 0 && hi > 0) p.rect(x0, yOf(0) - 0.375, w, 0.75, color('axis'));
      let run: [number, number][] = [];
      const flush = () => {
        if (run.length > 1) p.polyline(run, g.lineWeight, color('series'));
        run = [];
      };
      values.forEach((v, k) => (v === null ? flush() : run.push(at(k))));
      flush();
      values.forEach((v, k) => {
        if (v === null) return;
        const special = pointColor(v, k, g.markers ? color('markers') : -1);
        if (special !== null) p.disc(...at(k), Math.max(1.5, g.lineWeight * 1.6), special);
      });
      return;
    }
    // Columns and win/loss: a bar per value across the cell.
    const slot = w / n;
    const bar = Math.max(0.75, slot * 0.8);
    const mid = y0 + h / 2;
    values.forEach((v, k) => {
      if (v === null || (g.kind === 'stacked' && v === 0)) return;
      const x = x0 + k * slot + (slot - bar) / 2;
      const fill = pointColor(v, k, v < 0 ? color('negative') : color('series'))!;
      if (g.kind === 'stacked') {
        // Win/loss: up for a win, down for a loss, all the same height.
        if (v > 0) p.rect(x, y0, bar, h / 2 - 0.5, fill);
        else p.rect(x, mid + 0.5, bar, h / 2 - 0.5, fill);
        return;
      }
      const top = yOf(Math.max(v, 0));
      const bottom = yOf(Math.min(v, 0));
      p.rect(x, top, bar, Math.max(0.75, bottom - top), fill);
    });
    if (g.axis && (g.kind === 'stacked' || (lo < 0 && hi > 0))) p.rect(x0, (g.kind === 'stacked' ? mid : yOf(0)) - 0.375, w, 0.75, color('axis'));
  });
}
