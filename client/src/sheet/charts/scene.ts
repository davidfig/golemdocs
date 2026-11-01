// A chart laid out for drawing (docs/spreadsheets.md, M6): its series read from the cells they name (the file's cached
// values when a reference can't be read), then its title, legend, axes, gridlines and data drawn as triangles and text
// runs, in points from the chart's top left. Built in the worker; the page draws it over the cells at its anchor (the
// renderer's chart layer). Text is measured here by an estimate (the page has the fonts): it is placed by an anchor and
// an alignment, so only the room left for it can be a little off.

import { displayText } from '../format/display.ts';
import { numberFormat } from '../format/numberFormat.ts';
import type { Engine } from '../formula/engine.ts';
import { RangeRef } from '../formula/values.ts';
import { Kind } from '../model/column.ts';
import type { Workbook } from '../model/workbook.ts';
import { isWorksheet } from '../model/workbook.ts';
import type { Worksheet } from '../model/worksheet.ts';
import type { ChartScene, ChartText } from '../protocol.ts';
import type { Chart, ChartGroup, ChartSeries, SheetChart } from './model.ts';

const TEXT = 0x595959;
const AXIS_LINE = 0xbfbfbf;
const GRID = 0xd9d9d9;
const BORDER = 0xd9d9d9;
const LABEL_SIZE = 9;
const TITLE_SIZE = 14;
const PAD = 7;

/** A series' data as the chart shows it: categories (or x values) and values, from its cells. */
interface Resolved {
  name: string;
  cats: string[];
  vals: (number | null)[];
  xs: (number | null)[];
  color: number;
  series: ChartSeries;
}

/** Where a chart is on its sheet (points), from its anchor and the sheet's row and column sizes. */
export function chartBox(sheet: Worksheet, c: SheetChart): { x: number; y: number; width: number; height: number } {
  const { from, to, size } = c.anchor;
  const x = sheet.colSizes.position(from.col) + from.dx;
  const y = sheet.rowSizes.position(from.row) + from.dy;
  if (to) return { x, y, width: Math.max(1, sheet.colSizes.position(to.col) + to.dx - x), height: Math.max(1, sheet.rowSizes.position(to.row) + to.dy - y) };
  return { x, y, width: size?.width ?? 360, height: size?.height ?? 216 };
}

/** Collects the cells of a reference, in order (down a column, or across a row). */
function cells(engine: Engine, book: Workbook, sheetIndex: number, ref: string | null, limit = 4000): { sheet: Worksheet; at: [number, number][] } | null {
  if (!ref) return null;
  let value;
  try {
    value = engine.formulaReference(ref, sheetIndex, 0, 0);
  } catch {
    return null;
  }
  if (!(value instanceof RangeRef)) return null;
  const sheet = book.sheets[value.sheet];
  if (!sheet || !isWorksheet(sheet)) return null;
  const at: [number, number][] = [];
  for (let r = value.r0; r <= value.r1 && at.length < limit; r++) for (let c = value.c0; c <= value.c1 && at.length < limit; c++) at.push([r, c]);
  return { sheet, at };
}

/** A reference's numbers (null for empty cells and text), or the cached ones. */
function numbersOf(engine: Engine, book: Workbook, sheetIndex: number, ref: string | null, cached: (number | null)[]): (number | null)[] {
  const found = cells(engine, book, sheetIndex, ref);
  if (!found) return cached;
  const index = book.sheets.indexOf(found.sheet);
  return found.at.map(([r, c]) => {
    const v = engine.value(index, r, c);
    return typeof v === 'number' ? v : typeof v === 'boolean' ? null : null;
  });
}

/** A reference's texts as the cells show them, or the cached ones. */
function textsOf(book: Workbook, engine: Engine, sheetIndex: number, ref: string | null, cached: string[]): string[] {
  const found = cells(engine, book, sheetIndex, ref);
  if (!found) return cached;
  return found.at.map(([r, c]) => {
    const column = found.sheet.grid.columns[c];
    const kind = column?.kind(r) ?? Kind.Empty;
    if (kind === Kind.Empty || kind === Kind.Blank) {
      // A formula's result.
      const v = engine.value(book.sheets.indexOf(found.sheet), r, c);
      return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    }
    return displayText(book, kind, column!.value(r), column!.style(r)).text;
  });
}

/** The default colours of a chart's series (or a pie's points): the theme's six accents, then darker and lighter turns. */
export function defaultColor(accents: number[], i: number): number {
  const base = accents[i % 6] ?? 0x4472c4;
  const turn = Math.floor(i / 6);
  if (!turn) return base;
  const k = turn % 2 ? 0.6 : 1.4;
  const ch = (shift: number) => Math.max(0, Math.min(255, Math.round(((base >> shift) & 255) * k)));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Draws into flat lists of triangles (x, y per vertex, a colour per vertex) and text runs. */
class Painter {
  points: number[] = [];
  colors: number[] = [];
  texts: ChartText[] = [];

  triangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, color: number): void {
    this.points.push(ax, ay, bx, by, cx, cy);
    this.colors.push(color, color, color);
  }

  rect(x: number, y: number, w: number, h: number, color: number): void {
    if (w <= 0 || h <= 0) return;
    this.triangle(x, y, x + w, y, x, y + h, color);
    this.triangle(x + w, y, x + w, y + h, x, y + h, color);
  }

  /** A straight line `width` thick. */
  line(x0: number, y0: number, x1: number, y1: number, width: number, color: number): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = Math.hypot(dx, dy);
    if (!length) return;
    const nx = (-dy / length) * (width / 2);
    const ny = (dx / length) * (width / 2);
    this.triangle(x0 + nx, y0 + ny, x1 + nx, y1 + ny, x0 - nx, y0 - ny, color);
    this.triangle(x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny, color);
  }

  /** A run of lines with round joins. */
  polyline(points: [number, number][], width: number, color: number): void {
    for (let i = 1; i < points.length; i++) this.line(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1], width, color);
    for (let i = 1; i < points.length - 1; i++) this.disc(points[i][0], points[i][1], width / 2, color);
  }

  disc(cx: number, cy: number, r: number, color: number): void {
    this.sector(cx, cy, 0, r, 0, Math.PI * 2, color);
  }

  /** A ring's sector between two angles (radians clockwise from twelve o'clock); inner 0 makes a pie slice. */
  sector(cx: number, cy: number, inner: number, outer: number, a0: number, a1: number, color: number): void {
    const steps = Math.max(2, Math.ceil(((a1 - a0) / (Math.PI * 2)) * Math.max(24, outer * 0.8)));
    const at = (a: number, r: number): [number, number] => [cx + Math.sin(a) * r, cy - Math.cos(a) * r];
    for (let i = 0; i < steps; i++) {
      const s = a0 + ((a1 - a0) * i) / steps;
      const e = a0 + ((a1 - a0) * (i + 1)) / steps;
      const [ox0, oy0] = at(s, outer);
      const [ox1, oy1] = at(e, outer);
      if (inner <= 0) {
        this.triangle(cx, cy, ox0, oy0, ox1, oy1, color);
      } else {
        const [ix0, iy0] = at(s, inner);
        const [ix1, iy1] = at(e, inner);
        this.triangle(ix0, iy0, ox0, oy0, ox1, oy1, color);
        this.triangle(ix0, iy0, ox1, oy1, ix1, iy1, color);
      }
    }
  }

  frame(x: number, y: number, w: number, h: number, width: number, color: number): void {
    this.rect(x, y, w, width, color);
    this.rect(x, y + h - width, w, width, color);
    this.rect(x, y, width, h, color);
    this.rect(x + w - width, y, width, h, color);
  }

  text(text: string, x: number, y: number, size: number, color: number, align: ChartText['align'], bold = false): void {
    if (text) this.texts.push({ text, x, y, size, color, align, bold });
  }
}

/** An estimate of a text's width (points): the page measures it exactly when it draws. */
const textWidth = (text: string, size: number): number => text.length * size * 0.52;

/** Round steps (1, 2, 5 times a power of ten) from min to max, about `count` of them. */
export function niceScale(min: number, max: number, count: number): { min: number; max: number; step: number } {
  if (!(max > min)) {
    max = min + (min === 0 ? 1 : Math.abs(min));
  }
  const rough = (max - min) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(rough));
  // The smallest round step that doesn't make many more steps than asked for.
  const step = [0.5, 1, 2, 5, 10].map((m) => m * power).find((s) => (max - min) / s <= Math.max(1, count) * 1.4) ?? power * 10;
  return { min: Math.floor(min / step + 1e-9) * step, max: Math.ceil(max / step - 1e-9) * step, step };
}

/** A chart, laid out in a box of `width` by `height` points. */
export function layoutChart(chart: Chart, series: Resolved[][], width: number, height: number, accents: number[]): { points: Float32Array; colors: Uint32Array; texts: ChartText[] } {
  const p = new Painter();
  // The chart area: white, with a thin border.
  p.rect(0, 0, width, height, 0xffffff);
  p.frame(0, 0, width, height, 0.75, BORDER);
  let top = PAD;
  let bottom = height - PAD;
  let left = PAD;
  let right = width - PAD;
  if (chart.title) {
    p.text(chart.title, width / 2, top + TITLE_SIZE * 0.6, TITLE_SIZE, TEXT, 'center');
    top += TITLE_SIZE * 1.5;
  }
  // The legend: the series, or a pie's categories.
  const first = chart.groups[0];
  const pie = first.kind === 'pie' || first.kind === 'doughnut';
  const entries: { label: string; color: number }[] = pie
    ? (series[0]?.[0]?.cats ?? []).map((label, i) => ({ label: label || String(i + 1), color: series[0][0].series.pointColors[i] ?? defaultColor(accents, i) }))
    : series.flat().map((s) => ({ label: s.name, color: s.color }));
  if (chart.legend && entries.length) {
    const swatch = 7;
    if (chart.legend === 'r' || chart.legend === 'l' || chart.legend === 'tr') {
      const w = Math.min(width / 3, Math.max(...entries.map((e) => textWidth(e.label, LABEL_SIZE))) + swatch + 10);
      const lineHeight = LABEL_SIZE * 1.6;
      const x = chart.legend === 'l' ? left : right - w;
      let y = (top + bottom) / 2 - (entries.length * lineHeight) / 2 + lineHeight / 2;
      for (const e of entries) {
        p.rect(x, y - swatch / 2, swatch, swatch, e.color);
        p.text(e.label, x + swatch + 4, y, LABEL_SIZE, TEXT, 'left');
        y += lineHeight;
      }
      if (chart.legend === 'l') left += w + 4;
      else right -= w + 4;
    } else {
      const widths = entries.map((e) => swatch + 4 + textWidth(e.label, LABEL_SIZE) + 10);
      const total = widths.reduce((a, b) => a + b, 0);
      let x = Math.max(left, (left + right) / 2 - total / 2);
      const y = chart.legend === 't' ? top + LABEL_SIZE * 0.6 : bottom - LABEL_SIZE * 0.6;
      entries.forEach((e, i) => {
        p.rect(x, y - swatch / 2, swatch, swatch, e.color);
        p.text(e.label, x + swatch + 4, y, LABEL_SIZE, TEXT, 'left');
        x += widths[i];
      });
      if (chart.legend === 't') top += LABEL_SIZE * 1.8;
      else bottom -= LABEL_SIZE * 1.8;
    }
  }
  if (right - left < 10 || bottom - top < 10) return finish(p);
  if (pie) pies(p, chart, series, { left, top, right, bottom }, accents);
  else axes(p, chart, series, { left, top, right, bottom }, accents);
  return finish(p);
}

function finish(p: Painter): { points: Float32Array; colors: Uint32Array; texts: ChartText[] } {
  return { points: Float32Array.from(p.points), colors: Uint32Array.from(p.colors), texts: p.texts };
}

/** Pies and doughnuts: the first series of the first group, slice by slice from the first slice's angle, clockwise. */
function pies(p: Painter, chart: Chart, series: Resolved[][], box: { left: number; top: number; right: number; bottom: number }, accents: number[]): void {
  const group = chart.groups[0];
  const s = series[0]?.[0];
  if (!s) return;
  const values = s.vals.map((v) => (v !== null && v > 0 ? v : 0));
  const total = values.reduce((a, b) => a + b, 0);
  if (!total) return;
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  const r = Math.max(4, Math.min(box.right - box.left, box.bottom - box.top) / 2 - 4);
  const inner = group.kind === 'doughnut' ? (r * group.holeSize) / 100 : 0;
  let angle = (group.firstSliceAngle * Math.PI) / 180;
  values.forEach((v, i) => {
    const sweep = (v / total) * Math.PI * 2;
    if (sweep > 0) {
      const color = s.series.pointColors[i] ?? (group.varyColors ? defaultColor(accents, i) : s.color);
      p.sector(cx, cy, inner, r, angle, angle + sweep, color);
      // A thin white edge between slices.
      if (values.length > 1) p.line(cx + Math.sin(angle) * inner, cy - Math.cos(angle) * inner, cx + Math.sin(angle) * r, cy - Math.cos(angle) * r, 1, 0xffffff);
    }
    angle += sweep;
  });
}

/** Bar, column, line, area and scatter charts: the plot inside its axes. */
function axes(p: Painter, chart: Chart, series: Resolved[][], box: { left: number; top: number; right: number; bottom: number }, accents: number[]): void {
  const groups = chart.groups.map((g, i) => ({ g, s: series[i] ?? [] }));
  const across = groups[0].g.kind === 'bar' && groups[0].g.direction === 'bar';
  const scatter = groups[0].g.kind === 'scatter';
  const categories = Math.max(1, ...groups.flatMap(({ s }) => s.map((x) => Math.max(x.vals.length, x.cats.length))));
  const catLabels = groups.flatMap(({ s }) => s).find((s) => s.cats.length)?.cats ?? [];
  // The values' range: stacked groups sum, percentage groups run to 100%.
  let lo = Infinity;
  let hi = -Infinity;
  let percent = false;
  for (const { g, s } of groups) {
    if (g.grouping === 'percentStacked') {
      percent = true;
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 1);
      continue;
    }
    if (g.grouping === 'stacked' && (g.kind === 'bar' || g.kind === 'area' || g.kind === 'line')) {
      for (let i = 0; i < categories; i++) {
        let up = 0;
        let down = 0;
        for (const x of s) {
          const v = x.vals[i] ?? 0;
          if (v >= 0) up += v;
          else down += v;
        }
        lo = Math.min(lo, down);
        hi = Math.max(hi, up);
      }
      continue;
    }
    for (const x of s) for (const v of x.vals) if (v !== null) ((lo = Math.min(lo, v)), (hi = Math.max(hi, v)));
  }
  if (!Number.isFinite(lo)) ((lo = 0), (hi = 1));
  // Excel's value axis starts at zero unless the values are far from it.
  if (lo > 0 && (hi - lo) / hi > 1 / 6) lo = 0;
  if (hi < 0 && (lo - hi) / lo > 1 / 6) hi = 0;
  const valueSpan = across ? box.right - box.left : box.bottom - box.top;
  const vAxis = chart.valueAxis;
  const scale = niceScale(vAxis.min ?? lo, vAxis.max ?? hi, Math.max(2, Math.floor(valueSpan / (across ? 60 : 30))));
  if (vAxis.min !== null) scale.min = vAxis.min;
  if (vAxis.max !== null) scale.max = vAxis.max;
  const fmt = numberFormat(vAxis.numFmt ?? (percent ? '0%' : 'General'));
  const tickText = (v: number) => fmt.format(Math.abs(v) < scale.step * 1e-9 ? 0 : v, false).text;
  // Scatter: the x axis is a value axis too.
  let xs = { min: 0, max: 1, step: 1 };
  if (scatter) {
    const all = groups.flatMap(({ s }) => s.flatMap((x) => (x.xs.length ? x.xs : x.vals.map((_, i) => i + 1)))).filter((v): v is number => v !== null);
    const xmin = all.length ? Math.min(...all) : 0;
    const xmax = all.length ? Math.max(...all) : 1;
    xs = niceScale(chart.categoryAxis.min ?? (xmin > 0 && (xmax - xmin) / xmax > 1 / 6 ? 0 : xmin), chart.categoryAxis.max ?? xmax, Math.max(2, Math.floor((box.right - box.left) / 60)));
  }
  const xFmt = numberFormat(chart.categoryAxis.numFmt ?? 'General');
  // Room for the labels: value labels beside the plot, category labels under it.
  const ticks: number[] = [];
  for (let v = scale.min, n = 0; v <= scale.max + scale.step * 1e-6 && n < 200; v += scale.step, n++) ticks.push(v);
  const valueLabelWidth = Math.max(...ticks.map((v) => textWidth(tickText(v), LABEL_SIZE)));
  const catLabelWidth = Math.max(0, ...catLabels.map((c) => textWidth(c, LABEL_SIZE)));
  let { left, right, top, bottom } = box;
  top += LABEL_SIZE / 2;
  if (across) {
    if (!chart.categoryAxis.deleted) left += Math.min((right - left) / 3, catLabelWidth + 6);
    if (!vAxis.deleted) bottom -= LABEL_SIZE * 1.6;
    right -= valueLabelWidth / 2;
  } else {
    if (!vAxis.deleted) left += valueLabelWidth + 6;
    if (!chart.categoryAxis.deleted) bottom -= LABEL_SIZE * 1.6;
    right -= 4;
  }
  if (right - left < 4 || bottom - top < 4) return;
  const valueAt = (v: number) => (across ? left + ((v - scale.min) / (scale.max - scale.min)) * (right - left) : bottom - ((v - scale.min) / (scale.max - scale.min)) * (bottom - top));
  const xAt = (v: number) => left + ((v - xs.min) / (xs.max - xs.min)) * (right - left);
  // Gridlines and value labels.
  for (const v of ticks) {
    const at = valueAt(v);
    if (vAxis.gridlines || !across) {
      if (across) p.rect(at - 0.375, top, 0.75, bottom - top, GRID);
      else p.rect(left, at - 0.375, right - left, 0.75, GRID);
    }
    if (!vAxis.deleted) {
      if (across) p.text(tickText(v), at, bottom + LABEL_SIZE, LABEL_SIZE, TEXT, 'center');
      else p.text(tickText(v), left - 5, at, LABEL_SIZE, TEXT, 'right');
    }
  }
  // Categories along the other axis.
  const band = across ? (bottom - top) / categories : (right - left) / categories;
  const bandAt = (i: number) => (across ? bottom - band * (i + 0.5) : left + band * (i + 0.5));
  if (scatter) {
    for (let v = xs.min, n = 0; v <= xs.max + xs.step * 1e-6 && n < 200; v += xs.step, n++) {
      if (!chart.categoryAxis.deleted) p.text(xFmt.format(v, false).text, xAt(v), bottom + LABEL_SIZE, LABEL_SIZE, TEXT, 'center');
      if (chart.categoryAxis.gridlines) p.rect(xAt(v) - 0.375, top, 0.75, bottom - top, GRID);
    }
  } else if (!chart.categoryAxis.deleted) {
    // Labels that would overlap are thinned out.
    const room = across ? LABEL_SIZE * 1.4 : Math.max(...catLabels.map((c) => textWidth(c, LABEL_SIZE)), 8) + 4;
    const every = Math.max(1, Math.ceil(room / band));
    for (let i = 0; i < categories; i += every) {
      const label = catLabels[i] ?? String(i + 1);
      if (across) p.text(label, left - 5, bandAt(i), LABEL_SIZE, TEXT, 'right');
      else p.text(label, bandAt(i), bottom + LABEL_SIZE, LABEL_SIZE, TEXT, 'center');
    }
  }
  // The axis line at zero (or the axis's end).
  const zero = valueAt(Math.min(Math.max(0, scale.min), scale.max));
  if (across) p.rect(zero - 0.375, top, 0.75, bottom - top, AXIS_LINE);
  else p.rect(left, zero - 0.375, right - left, 0.75, AXIS_LINE);

  for (const { g, s } of groups) {
    if (g.kind === 'bar') bars(p, g, s, categories, band, bandAt, valueAt, across, accents);
    else if (g.kind === 'area') areas(p, g, s, categories, bandAt, valueAt, zero);
    else if (g.kind === 'line') lines(p, g, s, categories, bandAt, valueAt);
    else if (g.kind === 'scatter') scatterPoints(p, s, xAt, valueAt);
  }
}

/** Stacked values: each series' base and top at a category (fractions of the category's total for percentage stacks). */
function stacks(g: ChartGroup, s: Resolved[], categories: number): { base: number; top: number }[][] {
  const out = s.map(() => [] as { base: number; top: number }[]);
  for (let i = 0; i < categories; i++) {
    const total = g.grouping === 'percentStacked' ? s.reduce((a, x) => a + Math.abs(x.vals[i] ?? 0), 0) || 1 : 1;
    let up = 0;
    let down = 0;
    s.forEach((x, k) => {
      const v = (x.vals[i] ?? 0) / total;
      if (v >= 0) {
        out[k][i] = { base: up, top: up + v };
        up += v;
      } else {
        out[k][i] = { base: down, top: down + v };
        down += v;
      }
    });
  }
  return out;
}

function bars(p: Painter, g: ChartGroup, s: Resolved[], categories: number, band: number, bandAt: (i: number) => number, valueAt: (v: number) => number, across: boolean, accents: number[]): void {
  const stacked = g.grouping === 'stacked' || g.grouping === 'percentStacked';
  const slots = stacked ? 1 : Math.max(1, s.length);
  const barWidth = band / (slots + g.gapWidth / 100);
  const stack = stacked ? stacks(g, s, categories) : null;
  s.forEach((x, k) => {
    for (let i = 0; i < categories; i++) {
      const v = x.vals[i];
      if (v === null || v === undefined) continue;
      const [a, b] = stack ? [stack[k][i].base, stack[k][i].top] : [0, v];
      const offset = stacked ? -barWidth / 2 : -(slots * barWidth) / 2 + k * barWidth;
      const color = x.series.pointColors[i] ?? (g.varyColors && s.length === 1 ? defaultColor(accents, i) : x.color);
      const p0 = valueAt(a);
      const p1 = valueAt(b);
      // Bars across run up the band from the bottom; columns run left to right.
      if (across) p.rect(Math.min(p0, p1), bandAt(i) - offset - barWidth, Math.abs(p1 - p0), barWidth, color);
      else p.rect(bandAt(i) + offset, Math.min(p0, p1), barWidth, Math.abs(p1 - p0), color);
    }
  });
}

function lines(p: Painter, g: ChartGroup, s: Resolved[], categories: number, bandAt: (i: number) => number, valueAt: (v: number) => number): void {
  const stack = g.grouping === 'standard' ? null : stacks(g, s, categories);
  s.forEach((x, k) => {
    // Gaps (empty cells) break the line.
    let run: [number, number][] = [];
    const flush = () => {
      if (x.series.line && run.length > 1) p.polyline(run, 2.25, x.color);
      run = [];
    };
    for (let i = 0; i < categories; i++) {
      const v = x.vals[i];
      if (v === null || v === undefined) {
        flush();
        continue;
      }
      const pt: [number, number] = [bandAt(i), valueAt(stack ? stack[k][i].top : v)];
      run.push(pt);
      if (x.series.markers) p.disc(pt[0], pt[1], 2.5, x.color);
    }
    flush();
  });
}

function areas(p: Painter, g: ChartGroup, s: Resolved[], categories: number, bandAt: (i: number) => number, valueAt: (v: number) => number, zero: number): void {
  const stack = g.grouping === 'standard' ? null : stacks(g, s, categories);
  s.forEach((x, k) => {
    for (let i = 1; i < categories; i++) {
      const at = (j: number) => ({ top: valueAt(stack ? stack[k][j].top : (x.vals[j] ?? 0)), base: stack ? valueAt(stack[k][j].base) : zero });
      const a = at(i - 1);
      const b = at(i);
      const x0 = bandAt(i - 1);
      const x1 = bandAt(i);
      p.triangle(x0, a.top, x1, b.top, x0, a.base, x.color);
      p.triangle(x1, b.top, x1, b.base, x0, a.base, x.color);
    }
  });
}

function scatterPoints(p: Painter, s: Resolved[], xAt: (v: number) => number, valueAt: (v: number) => number): void {
  for (const x of s) {
    const pts: [number, number][] = [];
    x.vals.forEach((v, i) => {
      const xv = x.xs.length ? x.xs[i] : i + 1;
      if (v === null || xv === null || xv === undefined) return;
      pts.push([xAt(xv), valueAt(v)]);
    });
    if (x.series.line && pts.length > 1) p.polyline(pts, 2.25, x.color);
    if (x.series.markers) for (const [px, py] of pts) p.disc(px, py, 2.75, x.color);
  }
}

/** A sheet's chart, its data read from the cells now, laid out at its place. */
export function chartScene(book: Workbook, engine: Engine, sheetIndex: number, sheet: Worksheet, c: SheetChart, id: string): ChartScene {
  const box = chartBox(sheet, c);
  const accents = book.theme.colors.slice(4, 10);
  let n = 0;
  const series = c.chart.groups.map((g) =>
    g.series.map((s): Resolved => {
      const color = s.color ?? defaultColor(accents, n++);
      const nameCell = textsOf(book, engine, sheetIndex, s.nameRef, [s.name]);
      return {
        name: nameCell[0] || s.name,
        cats: textsOf(book, engine, sheetIndex, s.catRef, s.cats),
        vals: numbersOf(engine, book, sheetIndex, s.valRef, s.vals),
        xs: g.kind === 'scatter' ? numbersOf(engine, book, sheetIndex, s.xRef, s.xs) : [],
        color,
        series: s,
      };
    }),
  );
  const laid = layoutChart(c.chart, series, box.width, box.height, accents);
  return { id, ...box, ...laid };
}
