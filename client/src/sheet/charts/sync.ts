// A chart part brought in line with its chart's model where the two differ (title, legend, kind), changing the XML in
// place so everything else Excel wrote in it stays: the title's font, the series' colours and lines, data labels, axis
// formatting. Run on every save, it compares the part as the reader sees it with the model, so it only changes what an
// edit here changed, and it is right again after an undo whatever was saved in between.

import { el, elements, parseXml } from '@golemdocs/docx';
import type { XmlElement } from '@golemdocs/docx';
import { kid, kids, local, readChart } from './model.ts';
import type { Chart, ChartGroup } from './model.ts';
import { axisXml } from './write.ts';

const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

/** Elements from a snippet of chart XML (its `c:` and `a:` prefixes declared for it). */
function fragment(xml: string): XmlElement[] {
  return [...elements(parseXml(`<c:x xmlns:c="${C}" xmlns:a="${A}">${xml}</c:x>`))];
}

/** Puts `child` into `parent` before the first of `before` (local names) it has, or at the end. */
function insertBefore(parent: XmlElement, child: XmlElement, before: string[]): void {
  const at = parent.children.findIndex((c) => typeof c !== 'string' && before.includes(local(c)));
  if (at < 0) parent.children.push(child);
  else parent.children.splice(at, 0, child);
}

const remove = (parent: XmlElement, child: XmlElement | undefined) => {
  if (child) parent.children = parent.children.filter((c) => c !== child);
};

const valEl = (name: string, value: string | number) => el(`c:${name}`, { val: value });

/** What follows the title in `<c:chart>`, in the schema's order. */
const AFTER_TITLE = ['autoTitleDeleted', 'pivotFmts', 'view3D', 'floor', 'sideWall', 'backWall', 'plotArea', 'legend', 'plotVisOnly', 'dispBlanksAs', 'showDLblsOverMax', 'extLst'];
const AFTER_LEGEND = ['plotVisOnly', 'dispBlanksAs', 'showDLblsOverMax', 'extLst'];

function setTitle(chart: XmlElement, title: string | null): void {
  const titled = kid(chart, 'title');
  const deleted = kid(chart, 'autoTitleDeleted');
  if (title === null) {
    remove(chart, titled);
    if (deleted) deleted.attrs.val = '1';
    else insertBefore(chart, valEl('autoTitleDeleted', 1), AFTER_TITLE.slice(1));
    return;
  }
  if (deleted) deleted.attrs.val = '0';
  if (!titled) {
    chart.children.unshift(...fragment(`<c:title><c:overlay val="0"/></c:title>`));
    return setTitle(chart, title);
  }
  // The title's own text: its first run keeps its look (and the paragraph its own), the rest of the text goes.
  let tx = kid(titled, 'tx');
  let rich = kid(tx, 'rich');
  if (!rich) {
    remove(titled, tx);
    [tx] = fragment('<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr><a:r><a:rPr lang="en-US"/><a:t/></a:r></a:p></c:rich></c:tx>');
    titled.children.unshift(tx);
    rich = kid(tx, 'rich')!;
  }
  const paragraphs = kids(rich, 'p');
  const first = paragraphs[0] ?? fragment('<a:p/>')[0];
  const run = kids(first, 'r')[0];
  const rPr = kid(run, 'rPr');
  const pPr = kid(first, 'pPr');
  const lines = title.split('\n');
  const made = lines.map((line, i) => el(first.name, { ...first.attrs }, [...(pPr && i === 0 ? [pPr] : pPr ? [structuredClone(pPr)] : []), el(run?.name ?? 'a:r', {}, [...(rPr ? [structuredClone(rPr)] : []), el('a:t', {}, [line])])]));
  rich.children = [...rich.children.filter((c) => typeof c === 'string' || local(c) !== 'p'), ...made];
}

function setLegend(chart: XmlElement, position: Chart['legend']): void {
  const legend = kid(chart, 'legend');
  if (position === null) return remove(chart, legend);
  if (!legend) return insertBefore(chart, fragment(`<c:legend><c:legendPos val="${position}"/><c:overlay val="0"/></c:legend>`)[0], AFTER_LEGEND);
  const pos = kid(legend, 'legendPos');
  if (pos) pos.attrs.val = position;
  else legend.children.unshift(valEl('legendPos', position));
}

/** Each kind's series children, in the schema's order. */
const SERIES: Record<ChartGroup['kind'], string[]> = {
  bar: ['idx', 'order', 'tx', 'spPr', 'invertIfNegative', 'pictureOptions', 'dPt', 'dLbls', 'trendline', 'errBars', 'cat', 'val', 'shape'],
  line: ['idx', 'order', 'tx', 'spPr', 'marker', 'dPt', 'dLbls', 'trendline', 'errBars', 'cat', 'val', 'smooth'],
  area: ['idx', 'order', 'tx', 'spPr', 'pictureOptions', 'dPt', 'dLbls', 'trendline', 'errBars', 'cat', 'val'],
  pie: ['idx', 'order', 'tx', 'spPr', 'explosion', 'dPt', 'dLbls', 'cat', 'val'],
  doughnut: ['idx', 'order', 'tx', 'spPr', 'explosion', 'dPt', 'dLbls', 'cat', 'val'],
  scatter: ['idx', 'order', 'tx', 'spPr', 'marker', 'dPt', 'dLbls', 'trendline', 'errBars', 'xVal', 'yVal', 'smooth'],
};

const GROUP_NAME: Record<ChartGroup['kind'], string> = { bar: 'barChart', line: 'lineChart', area: 'areaChart', pie: 'pieChart', doughnut: 'doughnutChart', scatter: 'scatterChart' };
const pies = (kind: ChartGroup['kind']) => kind === 'pie' || kind === 'doughnut';

/** A series' element for another kind: what that kind allows kept, in its order (categories and values renamed for scatter). */
function convertSeries(ser: XmlElement, from: ChartGroup['kind'], to: ChartGroup['kind']): XmlElement {
  const allowed = SERIES[to];
  const rename: Record<string, string> = to === 'scatter' ? { cat: 'xVal', val: 'yVal' } : { xVal: 'cat', yVal: 'val' };
  const children: XmlElement[] = [];
  for (const c of elements(ser)) {
    let name = local(c);
    if (rename[name]) name = rename[name];
    if (!allowed.includes(name)) continue;
    // A point's look is made for one kind of shape (a slice, a bar, a marker): it goes when the kind changes that.
    if (name === 'dPt' && pies(from) !== pies(to)) continue;
    // A data label's position is the kind's own: it goes, the labels stay.
    const copy = structuredClone(c);
    copy.name = `c:${name}`;
    if (name === 'dLbls') copy.children = copy.children.filter((k) => typeof k === 'string' || (local(k) !== 'dLblPos' && local(k) !== 'dLbl'));
    if (name === 'errBars' && children.some((k) => local(k) === 'errBars') && to !== 'scatter') continue;
    children.push(copy);
  }
  if (to === 'bar' && !children.some((k) => local(k) === 'invertIfNegative')) children.push(valEl('invertIfNegative', 0));
  // A series' colour crosses between a fill (bars, areas, slices) and a line (lines, scatter), as Excel carries it.
  const spPr = children.find((k) => local(k) === 'spPr');
  const lined = (kind: ChartGroup['kind']) => kind === 'line' || kind === 'scatter';
  if (spPr && lined(from) !== lined(to)) {
    const fill = kid(spPr, 'solidFill');
    const ln = kid(spPr, 'ln');
    const lnFill = kid(ln, 'solidFill');
    if (lined(to) && fill) {
      // The fill's colour becomes the line's (a line with no fill of its own, or one drawn in the fill's colour).
      const line = ln ?? el('a:ln', { w: 28575, cap: 'rnd' });
      line.children = [structuredClone(fill), ...line.children.filter((k) => typeof k === 'string' || !['noFill', 'solidFill', 'gradFill', 'pattFill'].includes(local(k)))];
      // In the fill's place: a shape's properties go geometry, fill, line, effects, in that order.
      const at = spPr.children.indexOf(fill);
      spPr.children = spPr.children.filter((k) => k !== fill && k !== ln);
      spPr.children.splice(at, 0, line);
    } else if (!lined(to) && lnFill && !fill) {
      spPr.children.splice(spPr.children.indexOf(ln!), 0, structuredClone(lnFill));
    }
  }
  children.sort((a, b) => allowed.indexOf(local(a)) - allowed.indexOf(local(b)));
  return el(ser.name, { ...ser.attrs }, children);
}

/** The plot area's groups merged into one of the model's kind; axes made again only when the new kind needs others. */
function setKind(plot: XmlElement, model: ChartGroup, was: ChartGroup['kind']): void {
  const groups = [...elements(plot)].filter((g) => Object.values(GROUP_NAME).includes(local(g)) || /Chart$/.test(local(g)));
  if (!groups.length) return;
  const series = groups.flatMap((g) => kids(g, 'ser')).map((s) => convertSeries(s, was, model.kind));
  const labels = kid(groups[0], 'dLbls');
  if (labels) labels.children = labels.children.filter((k) => typeof k === 'string' || local(k) !== 'dLblPos');
  const ids = kids(groups[0], 'axId').map((a) => a.attrs.val ?? '');
  // Axes: none for pies; a category and a value axis, or two value axes for scatter. Kept when they are already right.
  const axes = [...elements(plot)].filter((a) => ['catAx', 'valAx', 'dateAx', 'serAx'].includes(local(a)));
  const wanted = pies(model.kind) ? '' : model.kind === 'scatter' ? 'valAx,valAx' : 'catAx,valAx';
  const have = axes.map((a) => local(a)).sort().join(',');
  let axisIds = ids;
  if (have !== (wanted ? wanted.split(',').sort().join(',') : '')) {
    for (const a of axes) remove(plot, a);
    if (wanted) {
      const made = fragment(axisXml(model.kind, model.direction, { min: null, max: null, numFmt: null, gridlines: true, deleted: false }, { min: null, max: null, numFmt: null, gridlines: false, deleted: false }));
      plot.children.push(...made);
      axisIds = made.map((a) => kid(a, 'axId')?.attrs.val ?? '');
    } else axisIds = [];
  }
  const stacked = model.grouping === 'stacked' || model.grouping === 'percentStacked';
  const kindChildren: Record<ChartGroup['kind'], XmlElement[][]> = {
    bar: [[valEl('barDir', model.direction), valEl('grouping', model.grouping === 'standard' ? 'clustered' : model.grouping), valEl('varyColors', model.varyColors ? 1 : 0)], [valEl('gapWidth', model.gapWidth), ...(stacked ? [valEl('overlap', 100)] : [])]],
    line: [[valEl('grouping', model.grouping === 'clustered' ? 'standard' : model.grouping), valEl('varyColors', model.varyColors ? 1 : 0)], [valEl('marker', 1)]],
    area: [[valEl('grouping', model.grouping === 'clustered' ? 'standard' : model.grouping), valEl('varyColors', model.varyColors ? 1 : 0)], []],
    pie: [[valEl('varyColors', model.varyColors ? 1 : 0)], [valEl('firstSliceAng', model.firstSliceAngle)]],
    doughnut: [[valEl('varyColors', model.varyColors ? 1 : 0)], [valEl('firstSliceAng', model.firstSliceAngle), valEl('holeSize', model.holeSize)]],
    scatter: [[valEl('scatterStyle', 'lineMarker'), valEl('varyColors', model.varyColors ? 1 : 0)], []],
  };
  const [head, tail] = kindChildren[model.kind];
  const group = el(`c:${GROUP_NAME[model.kind]}`, {}, [...head, ...series, ...(labels ? [labels] : []), ...tail, ...axisIds.map((id) => valEl('axId', id))]);
  const at = plot.children.indexOf(groups[0]);
  plot.children = plot.children.filter((c) => typeof c === 'string' || !groups.includes(c));
  plot.children.splice(Math.min(at, plot.children.length), 0, group);
}

/** Brings a chart part (its chartSpace) in line with the model; true when it changed anything. */
export function syncChart(root: XmlElement, model: Chart, theme: number[]): boolean {
  const now = readChart(root, theme);
  const chart = kid(root, 'chart');
  const plot = kid(chart, 'plotArea');
  if (!now || !chart || !plot) return false;
  let changed = false;
  const g = model.groups[0];
  const was = now.groups[0];
  if (now.groups.length !== model.groups.length || was.kind !== g.kind || was.direction !== g.direction || was.grouping !== g.grouping) {
    setKind(plot, g, was.kind);
    changed = true;
  }
  if ((now.title ?? null) !== (model.title ?? null)) {
    setTitle(chart, model.title);
    changed = true;
  }
  if (now.legend !== model.legend) {
    setLegend(chart, model.legend);
    changed = true;
  }
  return changed;
}
