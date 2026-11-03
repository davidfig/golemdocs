// Sparklines (docs/spreadsheets.md, M6): small charts drawn in a cell, kept in the sheet's `<extLst>` as Excel 2010's
// `x14:sparklineGroups`. Each group has a kind (line, column, win/loss), colours and options, and its sparklines, each a
// cell and the range its values come from. Read into the model and written back from it (so they follow inserted and
// deleted rows and columns); everything else about a group is kept as it was read.

import { el, elements, textContent } from '@golemdocs/docx';
import type { XmlElement } from '@golemdocs/docx';
import { readColor } from './model/styles.ts';
import type { Color } from './model/styles.ts';
import { cellName, parseCell } from './refs.ts';

export const SPARKLINE_EXT = '{05C60535-1F16-4fd2-B633-F4F36F0B64E0}';

export interface Sparkline {
  /** The cell it is drawn in. */
  row: number;
  col: number;
  /** The values' reference (`Sheet1!A1:E1`). */
  ref: string;
}

export interface SparklineGroup {
  kind: 'line' | 'column' | 'stacked';
  /** Line width (points), for lines. */
  lineWeight: number;
  markers: boolean;
  high: boolean;
  low: boolean;
  first: boolean;
  last: boolean;
  negative: boolean;
  axis: boolean;
  /** How the vertical scale is set: each sparkline its own, the group's together, or fixed. */
  minAxis: 'individual' | 'group' | 'custom';
  maxAxis: 'individual' | 'group' | 'custom';
  manualMin: number | null;
  manualMax: number | null;
  colors: Partial<Record<'series' | 'negative' | 'axis' | 'markers' | 'first' | 'last' | 'high' | 'low', Color>>;
  sparklines: Sparkline[];
  /** The group as read, but for its sparklines (written back with the model's). */
  element: XmlElement;
}

const local = (e: XmlElement) => e.name.slice(e.name.indexOf(':') + 1);
const on = (v: string | undefined) => v === '1' || v === 'true';

/** The sheet's sparkline groups, from its `<extLst>`. */
export function readSparklines(root: XmlElement): SparklineGroup[] {
  const ext = [...elements(root)].find((e) => local(e) === 'extLst');
  const holder = ext && [...elements(ext)].find((e) => e.attrs.uri === SPARKLINE_EXT);
  const groups = holder && [...elements(holder)].find((e) => local(e) === 'sparklineGroups');
  if (!groups) return [];
  const out: SparklineGroup[] = [];
  for (const g of elements(groups)) {
    if (local(g) !== 'sparklineGroup') continue;
    const a = g.attrs;
    const colors: SparklineGroup['colors'] = {};
    for (const c of elements(g)) {
      const name = local(c).replace(/^color/, '');
      const key = (name[0]?.toLowerCase() + name.slice(1)) as keyof SparklineGroup['colors'];
      if (local(c).startsWith('color')) {
        const color = readColor(c);
        if (color) colors[key] = color;
      }
    }
    const list = [...elements(g)].find((e) => local(e) === 'sparklines');
    const sparklines: Sparkline[] = [];
    for (const s of list ? elements(list) : []) {
      const f = [...elements(s)].find((e) => local(e) === 'f');
      const sqref = [...elements(s)].find((e) => local(e) === 'sqref');
      const at = sqref && parseCell(textContent(sqref));
      if (f && at) sparklines.push({ row: at.row, col: at.col, ref: textContent(f) });
    }
    out.push({
      kind: a.type === 'column' ? 'column' : a.type === 'stacked' ? 'stacked' : 'line',
      lineWeight: a.lineWeight ? +a.lineWeight : 0.75,
      markers: on(a.markers),
      high: on(a.high),
      low: on(a.low),
      first: on(a.first),
      last: on(a.last),
      negative: on(a.negative),
      axis: on(a.displayXAxis),
      minAxis: (a.minAxisType as SparklineGroup['minAxis']) ?? 'individual',
      maxAxis: (a.maxAxisType as SparklineGroup['maxAxis']) ?? 'individual',
      manualMin: a.manualMin !== undefined ? +a.manualMin : null,
      manualMax: a.manualMax !== undefined ? +a.manualMax : null,
      colors,
      sparklines,
      element: { ...g, children: g.children.filter((c) => typeof c === 'string' || local(c) !== 'sparklines') },
    });
  }
  return out;
}

const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const XM = 'http://schemas.microsoft.com/office/excel/2006/main';

/** A new group (Insert › Sparklines) in Excel's default look: dark blue, red for negatives and markers. */
export function newSparklineGroup(kind: SparklineGroup['kind'], sparklines: Sparkline[]): SparklineGroup {
  const rgb = (name: string, value: string) => el(`x14:color${name}`, { rgb: value });
  const element = el('x14:sparklineGroup', { ...(kind !== 'line' && { type: kind }), displayEmptyCellsAs: 'gap', ...(kind === 'stacked' && { negative: 1 }) }, [
    rgb('Series', 'FF376092'),
    rgb('Negative', 'FFD00000'),
    rgb('Axis', 'FF000000'),
    rgb('Markers', 'FFD00000'),
    rgb('First', 'FFD00000'),
    rgb('Last', 'FFD00000'),
    rgb('High', 'FFD00000'),
    rgb('Low', 'FFD00000'),
  ]);
  return {
    kind,
    lineWeight: 0.75,
    markers: false,
    high: false,
    low: false,
    first: false,
    last: false,
    negative: kind === 'stacked',
    axis: false,
    minAxis: 'individual',
    maxAxis: 'individual',
    manualMin: null,
    manualMax: null,
    colors: { series: { rgb: 0x376092 }, negative: { rgb: 0xd00000 }, axis: { rgb: 0 }, markers: { rgb: 0xd00000 }, first: { rgb: 0xd00000 }, last: { rgb: 0xd00000 }, high: { rgb: 0xd00000 }, low: { rgb: 0xd00000 } },
    sparklines,
    element,
  };
}

/** Writes the model's sparklines into the sheet's `<extLst>` (each group's other parts as they were read), making the
 * extension for a sheet's first ones. */
export function writeSparklines(root: XmlElement, groups: SparklineGroup[]): void {
  let ext = [...elements(root)].find((e) => local(e) === 'extLst');
  let holder = ext && [...elements(ext)].find((e) => e.attrs.uri === SPARKLINE_EXT);
  let container = holder && [...elements(holder)].find((e) => local(e) === 'sparklineGroups');
  if (!container) {
    if (!groups.some((g) => g.sparklines.length)) return;
    // The extLst is the last thing in a worksheet.
    if (!ext) root.children.push((ext = el('extLst')));
    ext.children.push((holder = el('ext', { uri: SPARKLINE_EXT, 'xmlns:x14': X14 }, [(container = el('x14:sparklineGroups', { 'xmlns:xm': XM }))])));
  }
  if (!ext || !holder) return;
  const kept = groups.filter((g) => g.sparklines.length);
  if (!kept.length) {
    // No sparklines left: the extension goes (and the extLst, when it held nothing else).
    ext.children = ext.children.filter((c) => c !== holder);
    if (![...elements(ext)].length) root.children = root.children.filter((c) => c !== ext);
    return;
  }
  const prefix = container.name.slice(0, container.name.indexOf(':') + 1) || 'x14:';
  container.children = kept.map((g) =>
    el(g.element.name, { ...g.element.attrs }, [
      ...g.element.children,
      el(`${prefix}sparklines`, {}, g.sparklines.map((s) => el(`${prefix}sparkline`, {}, [el('xm:f', {}, [s.ref]), el('xm:sqref', {}, [cellName(s.row, s.col)])]))),
    ]),
  );
}
