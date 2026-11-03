// Writing a sheet's charts (docs/spreadsheets.md, M6). Each chart's anchor goes into its drawing part, and each series'
// references into its chart part, and a title, legend or kind changed here is changed in the XML (`syncChart`), everything
// else in the parts kept as it was. A chart made here (`generate`) has its part written whole from the model (`chartXml`). A new chart gets a chart part and an anchor, and the sheet a
// drawing part if it had none; a chart taken away takes its anchor, part and relationship with it.

import { el, elements, serializeXml, textContent } from '@golemdocs/docx';
import type { OpcPackage, XmlElement } from '@golemdocs/docx';
import type { Worksheet } from '../model/worksheet.ts';
import { EMU_PER_POINT, kid, kids, local } from './model.ts';
import { syncChart } from './sync.ts';
import type { AnchorPoint, Chart, ChartAxis, ChartGroup, ChartKind, ChartSeries, SheetChart } from './model.ts';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CHART_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const DRAWING_TYPE = 'application/vnd.openxmlformats-officedocument.drawing+xml';
const ANCHORS = ['twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor'];

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hex = (rgb: number) => rgb.toString(16).padStart(6, '0').toUpperCase();

/** A data reference with the values cached for it (Excel shows the cache until it reads the cells). */
function ref(kind: 'num' | 'str', f: string | null, points: (string | number | null)[]): string {
  const cache = `<c:${kind}Cache>${kind === 'num' ? '<c:formatCode>General</c:formatCode>' : ''}<c:ptCount val="${points.length}"/>${points
    .map((p, i) => (p === null || p === '' ? '' : `<c:pt idx="${i}"><c:v>${escape(String(p))}</c:v></c:pt>`))
    .join('')}</c:${kind}Cache>`;
  return f ? `<c:${kind}Ref><c:f>${escape(f)}</c:f>${cache}</c:${kind}Ref>` : `<c:${kind}Lit>${cache.slice(`<c:${kind}Cache>`.length, -`</c:${kind}Cache>`.length)}</c:${kind}Lit>`;
}

function seriesXml(s: ChartSeries, i: number, g: ChartGroup): string {
  const name = s.nameRef ? `<c:tx>${ref('str', s.nameRef, [s.name])}</c:tx>` : `<c:tx><c:v>${escape(s.name)}</c:v></c:tx>`;
  const fill = s.color === null ? '' : g.kind === 'line' || g.kind === 'scatter' ? `<a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${hex(s.color)}"/></a:solidFill><a:round/></a:ln>` : `<a:solidFill><a:srgbClr val="${hex(s.color)}"/></a:solidFill>`;
  const noLine = (g.kind === 'line' || g.kind === 'scatter') && !s.line ? '<a:ln><a:noFill/></a:ln>' : '';
  const spPr = fill || noLine ? `<c:spPr>${noLine || fill}</c:spPr>` : '';
  const marker = g.kind === 'line' || g.kind === 'scatter' ? `<c:marker><c:symbol val="${s.markers ? 'circle' : 'none'}"/>${s.markers ? '<c:size val="5"/>' : ''}</c:marker>` : '';
  const points = Object.entries(s.pointColors)
    .map(([idx, color]) => `<c:dPt><c:idx val="${idx}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${hex(color)}"/></a:solidFill></c:spPr></c:dPt>`)
    .join('');
  const cats = g.kind === 'scatter' ? `<c:xVal>${ref('num', s.xRef, s.xs)}</c:xVal>` : s.catRef || s.cats.length ? `<c:cat>${ref('str', s.catRef, s.cats)}</c:cat>` : '';
  const vals = `<c:${g.kind === 'scatter' ? 'yVal' : 'val'}>${ref('num', s.valRef, s.vals)}</c:${g.kind === 'scatter' ? 'yVal' : 'val'}>`;
  const smooth = g.kind === 'line' || g.kind === 'scatter' ? '<c:smooth val="0"/>' : '';
  return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${name}${spPr}${g.kind === 'bar' ? '<c:invertIfNegative val="0"/>' : ''}${marker}${points}${cats}${vals}${smooth}</c:ser>`;
}

const AX_CAT = 500000001;
const AX_VAL = 500000002;

function groupXml(g: ChartGroup): string {
  const series = g.series.map((s, i) => seriesXml(s, i, g)).join('');
  const ids = `<c:axId val="${AX_CAT}"/><c:axId val="${AX_VAL}"/>`;
  const vary = `<c:varyColors val="${g.varyColors ? 1 : 0}"/>`;
  switch (g.kind) {
    case 'bar': {
      const stacked = g.grouping === 'stacked' || g.grouping === 'percentStacked';
      return `<c:barChart><c:barDir val="${g.direction}"/><c:grouping val="${g.grouping === 'standard' ? 'clustered' : g.grouping}"/>${vary}${series}<c:gapWidth val="${g.gapWidth}"/>${stacked ? '<c:overlap val="100"/>' : ''}${ids}</c:barChart>`;
    }
    case 'line':
      return `<c:lineChart><c:grouping val="${g.grouping === 'clustered' ? 'standard' : g.grouping}"/>${vary}${series}<c:marker val="1"/>${ids}</c:lineChart>`;
    case 'area':
      return `<c:areaChart><c:grouping val="${g.grouping === 'clustered' ? 'standard' : g.grouping}"/>${vary}${series}${ids}</c:areaChart>`;
    case 'scatter':
      return `<c:scatterChart><c:scatterStyle val="lineMarker"/>${vary}${series}${ids}</c:scatterChart>`;
    case 'pie':
      return `<c:pieChart>${vary}${series}<c:firstSliceAng val="${g.firstSliceAngle}"/></c:pieChart>`;
    case 'doughnut':
      return `<c:doughnutChart>${vary}${series}<c:firstSliceAng val="${g.firstSliceAngle}"/><c:holeSize val="${g.holeSize}"/></c:doughnutChart>`;
  }
}

/** A chart's axes: a category and a value axis (two value axes for scatter, none for pies). */
export function axisXml(kind: ChartKind, direction: 'col' | 'bar', v: ChartAxis, c: ChartAxis): string {
  if (kind === 'pie' || kind === 'doughnut') return '';
  const across = kind === 'bar' && direction === 'bar';
  const scaling = (a: ChartAxis) => `<c:scaling><c:orientation val="minMax"/>${a.max !== null ? `<c:max val="${a.max}"/>` : ''}${a.min !== null ? `<c:min val="${a.min}"/>` : ''}</c:scaling>`;
  const fmt = (a: ChartAxis) => `<c:numFmt formatCode="${escape(a.numFmt ?? 'General')}" sourceLinked="${a.numFmt ? 0 : 1}"/>`;
  const common = (a: ChartAxis, cross: number, pos: string) =>
    `${scaling(a)}<c:delete val="${a.deleted ? 1 : 0}"/><c:axPos val="${pos}"/>${a.gridlines ? '<c:majorGridlines/>' : ''}${fmt(a)}<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${cross}"/><c:crosses val="autoZero"/>`;
  const category =
    kind === 'scatter'
      ? `<c:valAx><c:axId val="${AX_CAT}"/>${common(c, AX_VAL, 'b')}<c:crossBetween val="midCat"/></c:valAx>`
      : `<c:catAx><c:axId val="${AX_CAT}"/>${common(c, AX_VAL, across ? 'l' : 'b')}<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
  const value = `<c:valAx><c:axId val="${AX_VAL}"/>${common(v, AX_CAT, across ? 'b' : 'l')}<c:crossBetween val="${kind === 'area' ? 'midCat' : 'between'}"/></c:valAx>`;
  return category + value;
}

/** A chart's whole chartSpace, from the model. */
export function chartXml(chart: Chart): string {
  const title = chart.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="0"/></a:pPr><a:r><a:rPr lang="en-US" sz="1400" b="0"/><a:t>${escape(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : '<c:autoTitleDeleted val="1"/>';
  const legend = chart.legend ? `<c:legend><c:legendPos val="${chart.legend}"/><c:overlay val="0"/></c:legend>` : '';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}">` +
    `<c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${chart.groups.map(groupXml).join('')}${axisXml(chart.groups[0].kind, chart.groups[0].direction, chart.valueAxis, chart.categoryAxis)}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
    '<c:spPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:chartSpace>'
  );
}

/** An anchor's corner element. */
const corner = (name: 'from' | 'to', p: AnchorPoint): XmlElement =>
  el(`xdr:${name}`, {}, [
    el('xdr:col', {}, [String(p.col)]),
    el('xdr:colOff', {}, [String(Math.round(p.dx * EMU_PER_POINT))]),
    el('xdr:row', {}, [String(p.row)]),
    el('xdr:rowOff', {}, [String(Math.round(p.dy * EMU_PER_POINT))]),
  ]);

/** A new chart's anchor in the drawing. */
function anchorElement(c: SheetChart, id: number): XmlElement {
  const to = c.anchor.to ?? c.anchor.from;
  // Its namespaces are declared on it: a drawing Excel wrote declares `r:` only where it uses it.
  return el('xdr:twoCellAnchor', { 'xmlns:a': 'http://schemas.openxmlformats.org/drawingml/2006/main', 'xmlns:r': REL }, [
    corner('from', c.anchor.from),
    corner('to', to),
    el('xdr:graphicFrame', { macro: '' }, [
      el('xdr:nvGraphicFramePr', {}, [el('xdr:cNvPr', { id, name: `Chart ${id}` }), el('xdr:cNvGraphicFramePr')]),
      el('xdr:xfrm', {}, [el('a:off', { x: 0, y: 0 }), el('a:ext', { cx: 0, cy: 0 })]),
      el('a:graphic', {}, [el('a:graphicData', { uri: 'http://schemas.openxmlformats.org/drawingml/2006/chart' }, [el('c:chart', { 'xmlns:c': 'http://schemas.openxmlformats.org/drawingml/2006/chart', 'r:id': c.rId })])]),
    ]),
    el('xdr:clientData'),
  ]);
}

/** The chart an anchor holds (its relationship id), if it holds one. */
const chartIdOf = (a: XmlElement): string | undefined => kid(kid(kid(kid(a, 'graphicFrame'), 'graphic'), 'graphicData'), 'chart')?.attrs['r:id'];

/** Writes a sheet's charts into its parts (see the top of the file). Sets the sheet's `<drawing>` for a new drawing part. */
export async function writeCharts(pkg: OpcPackage, sheetPart: string, sheet: Worksheet, theme: number[]): Promise<void> {
  const sheetRels = await pkg.relationships(sheetPart);
  let drawingPart = sheet.charts.find((c) => c.drawingPart)?.drawingPart ?? '';
  if (!drawingPart) {
    const existing = sheetRels.list.find((r) => r.type === `${REL}/drawing`);
    if (existing) drawingPart = sheetRels.partName(existing);
  }
  if (!drawingPart) {
    if (!sheet.charts.length) return;
    drawingPart = pkg.uniqueName('xl/drawings/drawing', 'xml');
    sheet.drawingRId = sheetRels.add(`${REL}/drawing`, drawingPart);
  }
  const drawing = pkg.has(drawingPart)
    ? await pkg.xml(drawingPart)
    : el('xdr:wsDr', { 'xmlns:xdr': 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing', 'xmlns:a': 'http://schemas.openxmlformats.org/drawingml/2006/main', 'xmlns:r': REL });
  const drawingRels = await pkg.relationships(drawingPart);
  // Charts taken away: their anchors, parts and relationships go. Anchors that are not charts (pictures, shapes) stay.
  const kept = new Set(sheet.charts.map((c) => c.rId).filter(Boolean));
  drawing.children = drawing.children.filter((a) => {
    if (typeof a === 'string' || !ANCHORS.includes(local(a))) return true;
    const id = chartIdOf(a);
    if (!id || kept.has(id)) return true;
    const rel = drawingRels.byId(id);
    if (rel) {
      pkg.delete(drawingRels.partName(rel));
      drawingRels.remove(id);
    }
    return false;
  });
  const ids = [...elements(drawing)].flatMap((a) => [...elements(kid(kid(a, 'graphicFrame'), 'nvGraphicFramePr') ?? a)]).map((e) => +(e.attrs.id ?? 0));
  let nextId = Math.max(1, ...ids) + 1;
  sheet.charts = sheet.charts.map((c) => {
    if (c.rId) return { ...c, drawingPart };
    const part = pkg.uniqueName('xl/charts/chart', 'xml');
    // Written now, so the next new chart's name is not this one's.
    pkg.set(part, chartXml(c.chart), CHART_TYPE);
    const made = { ...c, part, rId: drawingRels.add(`${REL}/chart`, part), drawingPart, generate: true };
    drawing.children.push(anchorElement(made, nextId++));
    return made;
  });
  const anchors = new Map([...elements(drawing)].filter((a) => ANCHORS.includes(local(a))).flatMap((a) => (chartIdOf(a) ? [[chartIdOf(a)!, a] as const] : [])));
  for (const c of sheet.charts) {
    const anchor = anchors.get(c.rId);
    const put = (e: XmlElement | undefined, p: AnchorPoint | undefined) => {
      if (!e || !p) return;
      const set = (name: string, value: number) => {
        const k = kid(e, name);
        if (k) k.children = [String(Math.round(value))];
      };
      set('col', p.col);
      set('row', p.row);
      set('colOff', p.dx * EMU_PER_POINT);
      set('rowOff', p.dy * EMU_PER_POINT);
    };
    put(kid(anchor, 'from'), c.anchor.from);
    put(kid(anchor, 'to'), c.anchor.to);
    // A chart anchored by a corner and a size: its size, from its corners as they now are.
    const ext = anchor && !kid(anchor, 'to') ? kid(anchor, 'ext') : undefined;
    if (ext && c.anchor.to) {
      const at = (p: AnchorPoint) => ({ x: sheet.colSizes.position(p.col) + p.dx, y: sheet.rowSizes.position(p.row) + p.dy });
      const a = at(c.anchor.from);
      const b = at(c.anchor.to);
      ext.attrs.cx = String(Math.round(Math.max(1, b.x - a.x) * EMU_PER_POINT));
      ext.attrs.cy = String(Math.round(Math.max(1, b.y - a.y) * EMU_PER_POINT));
    }
    if (c.generate) {
      pkg.set(c.part, chartXml(c.chart), CHART_TYPE);
      continue;
    }
    if (!pkg.has(c.part)) continue;
    // Each series' references, by its place in the chart (the groups' series in order, as read).
    const xml = await pkg.xml(c.part);
    const plot = kid(kid(xml, 'chart'), 'plotArea');
    const groups = [...elements(plot ?? xml)].filter((g) => kids(g, 'ser').length);
    groups.forEach((g, gi) =>
      kids(g, 'ser').forEach((ser, si) => {
        const s = c.chart.groups[gi]?.series[si];
        if (!s) return;
        const setRef = (holder: XmlElement | undefined, to: string | null) => {
          const ref = kid(holder, 'numRef') ?? kid(holder, 'strRef') ?? kid(holder, 'multiLvlStrRef');
          const f = kid(ref, 'f');
          if (!f || to === null || textContent(f) === to) return;
          f.children = [to];
          // The cached values were the old cells': Excel reads the new ones.
          ref!.children = ref!.children.filter((k) => typeof k === 'string' || !/Cache$/.test(local(k)));
        };
        setRef(kid(ser, 'tx'), s.nameRef);
        setRef(kid(ser, 'cat') ?? kid(ser, 'xVal'), s.catRef ?? s.xRef);
        setRef(kid(ser, 'val') ?? kid(ser, 'yVal'), s.valRef);
      }),
    );
    // A title, legend or kind changed here: changed in the XML, the rest of it kept.
    syncChart(xml, c.chart, theme);
    pkg.set(c.part, serializeXml(xml), CHART_TYPE);
  }
  pkg.set(drawingPart, serializeXml(drawing), DRAWING_TYPE);
}
