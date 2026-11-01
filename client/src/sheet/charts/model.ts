// Charts (docs/spreadsheets.md, M6): what a sheet's charts are, read from its drawing part (where each sits: the cells its
// corners are anchored to) and each chart's part (DrawingML's chartSpace: the kind of chart, its series and their
// references, title, legend and axes). The parts themselves are left as they are and written back unchanged.

import { elements, textContent } from '@golemdocs/docx';
import type { OpcPackage, XmlElement } from '@golemdocs/docx';

/** A corner of a chart: a cell, and an offset into it (points). */
export interface AnchorPoint {
  row: number;
  col: number;
  dx: number;
  dy: number;
}

/** Where a chart sits: two corners, or a corner and a size (points). */
export interface ChartAnchor {
  from: AnchorPoint;
  to?: AnchorPoint;
  size?: { width: number; height: number };
}

export interface ChartSeries {
  name: string;
  /** References (as written, `Sheet1!$B$2:$B$6`) and the values the file cached for them. */
  nameRef: string | null;
  catRef: string | null;
  cats: string[];
  valRef: string | null;
  vals: (number | null)[];
  /** Scatter charts: the x values. */
  xRef: string | null;
  xs: (number | null)[];
  /** The series' own colour (RGB), or null for the chart's default for its place. */
  color: number | null;
  /** Each point's own colour, by index (pies). */
  pointColors: Record<number, number>;
  /** A line or scatter series draws its line (not with `<a:ln><a:noFill/>`), and its markers. */
  line: boolean;
  markers: boolean;
}

export type ChartKind = 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter';

export interface ChartGroup {
  kind: ChartKind;
  /** Bars: up (`col`) or across (`bar`). */
  direction: 'col' | 'bar';
  grouping: 'clustered' | 'stacked' | 'percentStacked' | 'standard';
  series: ChartSeries[];
  /** Each point its own colour (pies, and bars that ask for it). */
  varyColors: boolean;
  /** Bars: the gap between categories, as a percentage of a bar's width. */
  gapWidth: number;
  /** Doughnuts: the hole, as a percentage of the diameter. */
  holeSize: number;
  /** Pies: the angle of the first slice's edge, in degrees clockwise from twelve o'clock. */
  firstSliceAngle: number;
}

export interface ChartAxis {
  min: number | null;
  max: number | null;
  numFmt: string | null;
  gridlines: boolean;
  deleted: boolean;
}

export interface Chart {
  title: string | null;
  legend: 'r' | 'l' | 't' | 'b' | 'tr' | null;
  groups: ChartGroup[];
  valueAxis: ChartAxis;
  categoryAxis: ChartAxis;
}

export interface SheetChart {
  anchor: ChartAnchor;
  chart: Chart;
  /** The chart's part, and the drawing's relationship to it ('' for a chart made here, until it is first written). */
  part: string;
  rId: string;
  /** The drawing part the chart is anchored in ('' until written, for a sheet that had no drawing). */
  drawingPart: string;
  /** Its part is written from the model (a chart made or changed here), not kept as it was read. */
  generate?: boolean;
}

/** A chart with its references rewritten (a sheet renamed, rows inserted...), or the same chart when none changed. */
export function rewriteChart(c: SheetChart, fn: (text: string) => string): SheetChart {
  let changed = false;
  const f = (ref: string | null) => {
    if (ref === null) return null;
    const out = fn(ref);
    if (out !== ref) changed = true;
    return out;
  };
  const groups = c.chart.groups.map((g) => ({ ...g, series: g.series.map((s) => ({ ...s, nameRef: f(s.nameRef), catRef: f(s.catRef), valRef: f(s.valRef), xRef: f(s.xRef) })) }));
  return changed ? { ...c, chart: { ...c.chart, groups } } : c;
}

export const EMU_PER_POINT = 12700;

/** An element's name without its prefix. */
export const local = (e: XmlElement): string => e.name.slice(e.name.indexOf(':') + 1);
export const kids = (e: XmlElement | undefined, name: string): XmlElement[] => (e ? [...elements(e)].filter((c) => local(c) === name) : []);
export const kid = (e: XmlElement | undefined, name: string): XmlElement | undefined => (e ? [...elements(e)].find((c) => local(c) === name) : undefined);
/** A `val` attribute of a child (`<c:barDir val="col"/>`). */
const val = (e: XmlElement | undefined, name: string): string | undefined => kid(e, name)?.attrs.val;
const on = (v: string | undefined, fallback: boolean): boolean => (v === undefined ? fallback : v === '1' || v === 'true');

/** The text of a `<c:tx>` or `<c:title>`: rich text runs, or a reference's cached string. */
function textOf(e: XmlElement | undefined): string | null {
  if (!e) return null;
  const tx = local(e) === 'tx' ? e : kid(e, 'tx');
  if (!tx) return null;
  const rich = kid(tx, 'rich');
  if (rich) {
    const paragraphs = kids(rich, 'p').map((p) => kids(p, 'r').map((r) => textContent(kid(r, 't') ?? r)).join(''));
    return paragraphs.join('\n');
  }
  const ref = kid(tx, 'strRef');
  const cache = kid(ref, 'strCache');
  const pt = kid(cache, 'pt');
  if (pt) return textContent(kid(pt, 'v') ?? pt);
  const v = kid(tx, 'v');
  return v ? textContent(v) : null;
}

/** A data source: its reference (`<c:f>`) and cached points (`<c:numCache>`, `<c:strCache>`, or literal `<c:numLit>`). */
function source(e: XmlElement | undefined): { ref: string | null; points: string[] } {
  if (!e) return { ref: null, points: [] };
  const holder = kid(e, 'numRef') ?? kid(e, 'strRef') ?? kid(e, 'multiLvlStrRef') ?? e;
  const f = kid(holder, 'f');
  const cache = kid(holder, 'numCache') ?? kid(holder, 'strCache') ?? kid(holder, 'multiLvlStrCache') ?? kid(e, 'numLit') ?? kid(e, 'strLit');
  const count = +(val(cache, 'ptCount') ?? 0);
  const points: string[] = Array(count).fill('');
  // A multi-level cache holds levels of points; the first level is the innermost category.
  const levelHolder = kid(cache, 'lvl') ?? cache;
  for (const pt of kids(levelHolder, 'pt')) points[+(pt.attrs.idx ?? 0)] = textContent(kid(pt, 'v') ?? pt);
  return { ref: f ? textContent(f) : null, points };
}

const numbers = (points: string[]): (number | null)[] => points.map((p) => (p === '' || !Number.isFinite(+p) ? null : +p));

/** A solid fill's colour (`<a:solidFill>` with an RGB or a theme colour), resolved with the theme's colours. */
function fillColor(spPr: XmlElement | undefined, theme: number[]): number | null {
  const fill = kid(spPr, 'solidFill') ?? kid(kid(spPr, 'ln'), 'solidFill');
  return colorOf(fill, theme);
}

function colorOf(fill: XmlElement | undefined, theme: number[]): number | null {
  const srgb = kid(fill, 'srgbClr');
  if (srgb?.attrs.val) return parseInt(srgb.attrs.val, 16);
  const scheme = kid(fill, 'schemeClr')?.attrs.val;
  const index = scheme ? ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].indexOf(scheme === 'tx1' ? 'dk1' : scheme === 'bg1' ? 'lt1' : scheme === 'tx2' ? 'dk2' : scheme === 'bg2' ? 'lt2' : scheme) : -1;
  return index >= 0 ? (theme[index] ?? null) : null;
}

/** Reads a chart part's chartSpace. `theme` holds the theme's twelve colours in their file order (dk1, lt1, dk2, lt2, accents...). */
export function readChart(root: XmlElement, theme: number[]): Chart | null {
  const chart = kid(root, 'chart');
  const plot = kid(chart, 'plotArea');
  if (!chart || !plot) return null;
  const groups: ChartGroup[] = [];
  const kinds: Record<string, ChartKind> = { barChart: 'bar', bar3DChart: 'bar', lineChart: 'line', line3DChart: 'line', areaChart: 'area', area3DChart: 'area', pieChart: 'pie', pie3DChart: 'pie', doughnutChart: 'doughnut', scatterChart: 'scatter' };
  for (const g of elements(plot)) {
    const kind = kinds[local(g)];
    if (!kind) continue;
    const scatterStyle = val(g, 'scatterStyle');
    const series = kids(g, 'ser').map((s, i): ChartSeries => {
      const cat = source(kid(s, 'cat') ?? kid(s, 'xVal'));
      const values = source(kid(s, 'val') ?? kid(s, 'yVal'));
      const name = kid(s, 'tx');
      const nameRef = kid(kid(name, 'strRef'), 'f');
      const spPr = kid(s, 'spPr');
      const ln = kid(spPr, 'ln');
      const pointColors: Record<number, number> = {};
      for (const dPt of kids(s, 'dPt')) {
        const c = fillColor(kid(dPt, 'spPr'), theme);
        if (c !== null) pointColors[+(val(dPt, 'idx') ?? 0)] = c;
      }
      const markerSymbol = val(kid(s, 'marker'), 'symbol');
      return {
        name: textOf(name) ?? `Series${i + 1}`,
        nameRef: nameRef ? textContent(nameRef) : null,
        catRef: kind === 'scatter' ? null : cat.ref,
        cats: kind === 'scatter' ? [] : cat.points,
        valRef: values.ref,
        vals: numbers(values.points),
        xRef: kind === 'scatter' ? cat.ref : null,
        xs: kind === 'scatter' ? numbers(cat.points) : [],
        color: fillColor(spPr, theme),
        pointColors,
        line: !kid(ln, 'noFill') && scatterStyle !== 'marker',
        markers: kind === 'scatter' ? markerSymbol !== 'none' : kind === 'line' && markerSymbol !== undefined && markerSymbol !== 'none',
      };
    });
    groups.push({
      kind,
      direction: val(g, 'barDir') === 'bar' ? 'bar' : 'col',
      grouping: (val(g, 'grouping') as ChartGroup['grouping'] | undefined) ?? (kind === 'bar' ? 'clustered' : 'standard'),
      series,
      varyColors: on(val(g, 'varyColors'), kind === 'pie' || kind === 'doughnut'),
      gapWidth: +(val(g, 'gapWidth') ?? 150),
      holeSize: +(val(g, 'holeSize') ?? 50),
      firstSliceAngle: +(val(g, 'firstSliceAng') ?? 0),
    });
  }
  if (!groups.length) return null;
  const axis = (names: string[]): ChartAxis => {
    const a = names.map((n) => kid(plot, n)).find((x) => x);
    return a ? axisOf(a) : { min: null, max: null, numFmt: null, gridlines: false, deleted: true };
  };
  // A scatter chart has two value axes: the first is x (the category axis's place), the second y.
  const valAxes = kids(plot, 'valAx');
  const scatter = groups[0].kind === 'scatter';
  const titled = kid(chart, 'title');
  let title = titled ? textOf(titled) : null;
  // A chart of one series with no title of its own, and its title not deleted, shows the series' name (as Excel does).
  if (titled && title === null) title = groups[0].series.length === 1 ? groups[0].series[0].name : 'Chart Title';
  if (!titled && !on(val(chart, 'autoTitleDeleted'), false) && groups.length === 1 && groups[0].series.length === 1 && (groups[0].kind === 'pie' || groups[0].kind === 'doughnut')) title = groups[0].series[0].name;
  const legend = kid(chart, 'legend');
  return {
    title,
    legend: legend ? ((val(legend, 'legendPos') as Chart['legend']) ?? 'r') : null,
    groups,
    valueAxis: scatter && valAxes[1] ? axisOf(valAxes[1]) : axis(['valAx']),
    categoryAxis: scatter && valAxes[0] ? axisOf(valAxes[0]) : axis(['catAx', 'dateAx']),
  };

  function axisOf(a: XmlElement): ChartAxis {
    const scaling = kid(a, 'scaling');
    const min = val(scaling, 'min');
    const max = val(scaling, 'max');
    const fmt = kid(a, 'numFmt');
    return { min: min === undefined ? null : +min, max: max === undefined ? null : +max, numFmt: fmt && fmt.attrs.sourceLinked !== '1' ? (fmt.attrs.formatCode ?? null) : null, gridlines: !!kid(a, 'majorGridlines'), deleted: on(val(a, 'delete'), false) };
  }
}

/** A corner (`<xdr:from>`, `<xdr:to>`). */
function point(e: XmlElement | undefined): AnchorPoint | null {
  if (!e) return null;
  const n = (name: string) => +textContent(kid(e, name) ?? e) || 0;
  return { col: n('col'), row: n('row'), dx: n('colOff') / EMU_PER_POINT, dy: n('rowOff') / EMU_PER_POINT };
}

/** The charts of a sheet: its drawing part's anchors that hold a chart, each with its chart part read. */
export async function readCharts(pkg: OpcPackage, sheetPart: string, root: XmlElement, theme: number[]): Promise<SheetChart[]> {
  const drawingId = kid(root, 'drawing')?.attrs['r:id'];
  if (!drawingId) return [];
  const rels = await pkg.relationships(sheetPart);
  const rel = rels.byId(drawingId);
  if (!rel) return [];
  const drawingPart = rels.partName(rel);
  if (!pkg.has(drawingPart)) return [];
  const drawing = await pkg.xml(drawingPart);
  const drawingRels = await pkg.relationships(drawingPart);
  const out: SheetChart[] = [];
  for (const a of elements(drawing)) {
    const kind = local(a);
    if (kind !== 'twoCellAnchor' && kind !== 'oneCellAnchor' && kind !== 'absoluteAnchor') continue;
    const frame = kid(a, 'graphicFrame');
    const data = kid(kid(frame, 'graphic'), 'graphicData');
    const chartId = kid(data, 'chart')?.attrs['r:id'];
    const chartRel = chartId ? drawingRels.byId(chartId) : undefined;
    if (!chartRel) continue;
    const part = drawingRels.partName(chartRel);
    if (!pkg.has(part)) continue;
    const chart = readChart(await pkg.xml(part), theme);
    if (!chart) continue;
    const ext = kid(a, 'ext');
    const size = ext ? { width: +(ext.attrs.cx ?? 0) / EMU_PER_POINT, height: +(ext.attrs.cy ?? 0) / EMU_PER_POINT } : undefined;
    let from = point(kid(a, 'from'));
    if (!from && kind === 'absoluteAnchor') from = { row: 0, col: 0, dx: +(kid(a, 'pos')?.attrs.x ?? 0) / EMU_PER_POINT, dy: +(kid(a, 'pos')?.attrs.y ?? 0) / EMU_PER_POINT };
    if (!from) continue;
    const anchor: ChartAnchor = { from, to: point(kid(a, 'to')) ?? undefined, size };
    out.push({ anchor, chart, part, rId: chartId!, drawingPart });
  }
  return out;
}
