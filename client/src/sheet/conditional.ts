// Conditional formatting (docs/spreadsheets.md, "Formatting"): the rules a sheet's `<conditionalFormatting>` elements hold,
// and working out, cell by cell as tiles are built, which apply and what they change: a differential format (font, fill,
// border, number format) over the cell's own style, a colour from a colour scale, or a data bar. Rules that look at the
// whole range (top 10, above average, duplicates, scales, bars) work out what they need from it once, until cells change.
// Icon sets are read and kept, not drawn yet.

import type { CellIcon, IconShape } from './protocol.ts';
import { child, el, elements, textContent } from '@golemdocs/docx';
import type { XmlElement } from '@golemdocs/docx';
import type { Engine } from './formula/engine.ts';
import { BLANK, FormulaError, compare, toBool } from './formula/values.ts';
import type { Scalar } from './formula/values.ts';
import { colorXml, readColor } from './model/styles.ts';
import type { Color } from './model/styles.ts';
import type { CellRange, Worksheet } from './model/worksheet.ts';
import { parseRange, rangeName } from './refs.ts';
import { mix } from './draw.ts';

/** A threshold of a colour scale or data bar. */
export interface Cfvo {
  type: 'min' | 'max' | 'num' | 'percent' | 'percentile' | 'formula' | 'autoMin' | 'autoMax';
  val?: string;
}

export interface CfRule {
  type: string;
  priority: number;
  dxf?: number;
  stopIfTrue?: boolean;
  operator?: string;
  formulas: string[];
  text?: string;
  rank?: number;
  percent?: boolean;
  bottom?: boolean;
  aboveAverage?: boolean;
  equalAverage?: boolean;
  stdDev?: number;
  scale?: { cfvo: Cfvo[]; colors: Color[] };
  bar?: { cfvo: Cfvo[]; color: Color; showValue: boolean };
  /** An icon set: its name (3TrafficLights1...), thresholds (each passed at or above, unless `gte` is false), reversed. */
  icons?: { set: string; cfvo: Cfvo[]; gte: boolean[]; reverse: boolean; showValue: boolean };
}

export interface ConditionalFormat {
  ranges: CellRange[];
  rules: CfRule[];
  /** The element as read: written back with its ranges and formulas as they now are (everything else as it was). */
  element?: XmlElement;
}

/** The conditional formats of a worksheet's XML (the part around its cells). */
export function readConditional(root: XmlElement): ConditionalFormat[] {
  const out: ConditionalFormat[] = [];
  for (const cf of elements(root)) {
    if (cf.name !== 'conditionalFormatting') continue;
    const ranges = (cf.attrs.sqref ?? '').split(/\s+/).map((r) => parseRange(r)).filter((r): r is CellRange => !!r);
    const rules: CfRule[] = [];
    for (const e of elements(cf)) {
      if (e.name !== 'cfRule') continue;
      const a = e.attrs;
      const rule: CfRule = { type: a.type ?? '', priority: +(a.priority ?? 0), formulas: [...elements(e)].filter((f) => f.name === 'formula').map((f) => textContent(f)) };
      if (a.dxfId !== undefined) rule.dxf = +a.dxfId;
      if (a.stopIfTrue === '1') rule.stopIfTrue = true;
      if (a.operator) rule.operator = a.operator;
      if (a.text !== undefined) rule.text = a.text;
      if (a.rank !== undefined) rule.rank = +a.rank;
      if (a.percent === '1') rule.percent = true;
      if (a.bottom === '1') rule.bottom = true;
      if (a.aboveAverage !== undefined) rule.aboveAverage = a.aboveAverage !== '0';
      if (a.equalAverage === '1') rule.equalAverage = true;
      if (a.stdDev !== undefined) rule.stdDev = +a.stdDev;
      const cfvos = (parent: XmlElement) => [...elements(parent)].filter((c) => c.name === 'cfvo').map((c): Cfvo => ({ type: (c.attrs.type ?? 'min') as Cfvo['type'], val: c.attrs.val }));
      const scale = child(e, 'colorScale');
      if (scale) rule.scale = { cfvo: cfvos(scale), colors: [...elements(scale)].filter((c) => c.name === 'color').map((c) => readColor(c) ?? { rgb: 0 }) };
      const bar = child(e, 'dataBar');
      if (bar) rule.bar = { cfvo: cfvos(bar), color: readColor(child(bar, 'color')) ?? { rgb: 0x638ec6 }, showValue: bar.attrs.showValue !== '0' };
      const icons = child(e, 'iconSet');
      if (icons) {
        const list = [...elements(icons)].filter((c) => c.name === 'cfvo');
        rule.icons = { set: icons.attrs.iconSet ?? '3TrafficLights1', cfvo: cfvos(icons), gte: list.map((c) => c.attrs.gte !== '0'), reverse: icons.attrs.reverse === '1', showValue: icons.attrs.showValue !== '0' };
      }
      rules.push(rule);
    }
    if (ranges.length && rules.length) out.push({ ranges, rules, element: cf });
  }
  return out;
}

/** A format's element as it now is: its ranges and its rules' formulas from the model. */
export function conditionalElement(format: ConditionalFormat): XmlElement {
  const e = format.element ?? el('conditionalFormatting', {}, format.rules.map(ruleElement));
  e.attrs.sqref = format.ranges.map((r) => rangeName(r)).join(' ');
  const rules = [...elements(e)].filter((r) => r.name === 'cfRule');
  rules.forEach((r, i) => {
    const formulas = format.rules[i]?.formulas;
    if (!formulas) return;
    let k = 0;
    for (const f of elements(r)) if (f.name === 'formula' && k < formulas.length) f.children = [formulas[k++]];
  });
  return e;
}

/** A rule made here (not read from a file), as `<cfRule>`. */
function ruleElement(rule: CfRule): XmlElement {
  const flag = (v: boolean | undefined) => (v ? 1 : undefined);
  const cfvo = (v: Cfvo) => el('cfvo', { type: v.type, val: v.val });
  const children: XmlElement[] = rule.formulas.map((f) => el('formula', {}, [f]));
  if (rule.scale) children.push(el('colorScale', {}, [...rule.scale.cfvo.map(cfvo), ...rule.scale.colors.map((c) => colorXml('color', c))]));
  if (rule.bar) children.push(el('dataBar', { showValue: rule.bar.showValue ? undefined : 0 }, [...rule.bar.cfvo.map(cfvo), colorXml('color', rule.bar.color)]));
  if (rule.icons) {
    const icons = rule.icons;
    const attrs = { iconSet: icons.set === '3TrafficLights1' ? undefined : icons.set, showValue: icons.showValue ? undefined : 0, reverse: icons.reverse ? 1 : undefined };
    children.push(el('iconSet', attrs, icons.cfvo.map((v, i) => el('cfvo', { type: v.type, val: v.val, gte: icons.gte[i] === false ? 0 : undefined }))));
  }
  return el(
    'cfRule',
    {
      type: rule.type,
      dxfId: rule.dxf,
      priority: rule.priority,
      stopIfTrue: flag(rule.stopIfTrue),
      operator: rule.operator,
      text: rule.text,
      rank: rule.rank,
      percent: flag(rule.percent),
      bottom: flag(rule.bottom),
      aboveAverage: rule.aboveAverage === false ? 0 : undefined,
      equalAverage: flag(rule.equalAverage),
      stdDev: rule.stdDev,
    },
    children,
  );
}

/** What conditional formats do to one cell: differential formats to lay over its style (first wins), a fill colour, a bar. */
export interface CellOverlay {
  dxfs: number[];
  /** RGB, from a colour scale. */
  fill?: number;
  /** A data bar over part of the cell's width (fractions), in RGB. */
  bar?: { from: number; to: number; color: number };
  icon?: CellIcon;
  hideValue?: boolean;
}

const RED = 0xe0453a;
const AMBER = 0xf2b632;
const GREEN = 0x3c9a4b;
const GRAY = 0x8c8c8c;
const BLACK = 0x3a3a3a;
const PINK = 0xf09c95;
const BLUE = 0x4472c4;
const SILVER = 0xd0d0d0;

/** Excel's icon sets, lowest icon first: each a shape and colour, and for the ones that fill up, how full. */
const ICON_SETS: Record<string, [IconShape, number, number?][]> = {
  '3Arrows': [['down', RED], ['right', AMBER], ['up', GREEN]],
  '3ArrowsGray': [['down', GRAY], ['right', GRAY], ['up', GRAY]],
  '3Flags': [['flag', RED], ['flag', AMBER], ['flag', GREEN]],
  '3TrafficLights1': [['circle', RED], ['circle', AMBER], ['circle', GREEN]],
  '3TrafficLights2': [['circle', RED], ['circle', AMBER], ['circle', GREEN]],
  '3Signs': [['triangleDown', RED], ['triangleUp', AMBER], ['circle', GREEN]],
  '3Symbols': [['circle', RED], ['circle', AMBER], ['circle', GREEN]],
  '3Symbols2': [['circle', RED], ['circle', AMBER], ['circle', GREEN]],
  '3Stars': [['star', SILVER], ['star', AMBER, 0.5], ['star', AMBER]],
  '3Triangles': [['triangleDown', RED], ['dash', AMBER], ['triangleUp', GREEN]],
  '4Arrows': [['down', RED], ['downRight', AMBER], ['upRight', AMBER], ['up', GREEN]],
  '4ArrowsGray': [['down', GRAY], ['downRight', GRAY], ['upRight', GRAY], ['up', GRAY]],
  '4RedToBlack': [['circle', BLACK], ['circle', GRAY], ['circle', PINK], ['circle', RED]],
  '4Rating': [['bars', BLUE, 0.25], ['bars', BLUE, 0.5], ['bars', BLUE, 0.75], ['bars', BLUE, 1]],
  '4TrafficLights': [['circle', BLACK], ['circle', RED], ['circle', AMBER], ['circle', GREEN]],
  '5Arrows': [['down', RED], ['downRight', AMBER], ['right', AMBER], ['upRight', AMBER], ['up', GREEN]],
  '5ArrowsGray': [['down', GRAY], ['downRight', GRAY], ['right', GRAY], ['upRight', GRAY], ['up', GRAY]],
  '5Rating': [['bars', BLUE, 0], ['bars', BLUE, 0.25], ['bars', BLUE, 0.5], ['bars', BLUE, 0.75], ['bars', BLUE, 1]],
  '5Quarters': [['quarters', BLACK, 0], ['quarters', BLACK, 0.25], ['quarters', BLACK, 0.5], ['quarters', BLACK, 0.75], ['quarters', BLACK, 1]],
  '5Boxes': [['boxes', BLUE, 0], ['boxes', BLUE, 0.25], ['boxes', BLUE, 0.5], ['boxes', BLUE, 0.75], ['boxes', BLUE, 1]],
};

/** The icon a value gets: past the highest threshold it reaches (the first threshold is the bottom of the first icon). */
export function iconFor(set: string, value: number, limits: number[], gte: boolean[], reverse: boolean): CellIcon {
  const icons = ICON_SETS[set] ?? ICON_SETS['3TrafficLights1'];
  let index = 0;
  for (let i = 1; i < limits.length && i < icons.length; i++) if (gte[i] === false ? value > limits[i] : value >= limits[i]) index = i;
  const [shape, color, level] = icons[reverse ? icons.length - 1 - index : index];
  return { shape, color, level: level ?? 1 };
}

const inRange = (r: CellRange, row: number, col: number) => row >= r.r0 && row <= r.r1 && col >= r.c0 && col <= r.c1;

/** Statistics of a rule's range, worked out once. */
interface Stats {
  numbers: number[];
  sorted: number[];
  mean: number;
  sd: number;
  counts: Map<string, number>;
}

const valueKey = (v: Scalar): string => (typeof v === 'string' ? 's' + v.toLowerCase() : v === BLANK ? '' : typeof v === 'object' ? 'e' + (v as FormulaError).code : typeof v + String(v));

/** Evaluates a sheet's conditional formats for cells. Built per sheet; `forget()` after cells change. */
export class ConditionalPainter {
  private stats = new Map<CfRule, Stats>();
  private limits = new Map<CfRule, number[]>();

  constructor(
    private readonly engine: Engine,
    private readonly sheetIndex: number,
    private readonly sheet: Worksheet,
    /** A colour as RGB (the theme's colours resolved). */
    private readonly rgb: (color: Color) => number,
  ) {}

  forget(): void {
    this.stats.clear();
    this.limits.clear();
  }

  /** The formats that apply to a cell, by priority (null when none do). */
  overlay(row: number, col: number): CellOverlay | null {
    const formats = this.sheet.conditional.filter((f) => f.ranges.some((r) => inRange(r, row, col)));
    if (!formats.length) return null;
    const rules = formats.flatMap((f) => f.rules.map((rule) => ({ rule, format: f }))).sort((a, b) => a.rule.priority - b.rule.priority);
    const value = this.engine.value(this.sheetIndex, row, col);
    const out: CellOverlay = { dxfs: [] };
    for (const { rule, format } of rules) {
      const hit = this.apply(rule, format, row, col, value, out);
      if (hit && rule.stopIfTrue) break;
    }
    return out.dxfs.length || out.fill !== undefined || out.bar || out.icon ? out : null;
  }

  private apply(rule: CfRule, format: ConditionalFormat, row: number, col: number, value: Scalar, out: CellOverlay): boolean {
    if (rule.scale) {
      if (typeof value !== 'number' || out.fill !== undefined) return false;
      const limits = this.thresholds(rule, rule.scale.cfvo, format);
      out.fill = scaleColor(value, limits, rule.scale.colors.map(this.rgb));
      return true;
    }
    if (rule.bar) {
      if (typeof value !== 'number' || out.bar) return false;
      const [lo, hi] = this.thresholds(rule, rule.bar.cfvo, format);
      const t = hi > lo ? Math.min(1, Math.max(0, (value - lo) / (hi - lo))) : 1;
      // Excel's bars run from a tenth of the cell to nine tenths of it.
      out.bar = { from: 0, to: 0.1 + 0.8 * t, color: this.rgb(rule.bar.color) };
      if (!rule.bar.showValue) out.hideValue = true;
      return true;
    }
    if (rule.icons) {
      if (typeof value !== 'number' || out.icon) return false;
      out.icon = iconFor(rule.icons.set, value, this.thresholds(rule, rule.icons.cfvo, format), rule.icons.gte, rule.icons.reverse);
      if (!rule.icons.showValue) out.hideValue = true;
      return true;
    }
    if (rule.dxf === undefined) return false;
    if (!this.matches(rule, format, row, col, value)) return false;
    out.dxfs.push(rule.dxf);
    return true;
  }

  private matches(rule: CfRule, format: ConditionalFormat, row: number, col: number, value: Scalar): boolean {
    const top = format.ranges[0];
    const formula = (i: number): Scalar => (rule.formulas[i] === undefined ? BLANK : this.engine.formulaValue(rule.formulas[i], this.sheetIndex, row, col, top.r0, top.c0));
    switch (rule.type) {
      case 'cellIs': {
        if (value === BLANK && rule.operator !== 'equal' && rule.operator !== 'notEqual') return false;
        const a = formula(0);
        const c = (x: Scalar) => (value instanceof FormulaError || x instanceof FormulaError ? NaN : compare(value === BLANK ? 0 : value, x === BLANK ? 0 : x));
        switch (rule.operator) {
          case 'between':
          case 'notBetween': {
            const b = formula(1);
            const inside = (c(a) >= 0 && c(b) <= 0) || (c(a) <= 0 && c(b) >= 0);
            return rule.operator === 'between' ? inside : !inside;
          }
          case 'equal':
            return c(a) === 0;
          case 'notEqual':
            return c(a) !== 0;
          case 'greaterThan':
            return c(a) > 0;
          case 'lessThan':
            return c(a) < 0;
          case 'greaterThanOrEqual':
            return c(a) >= 0;
          case 'lessThanOrEqual':
            return c(a) <= 0;
          default:
            return false;
        }
      }
      case 'top10': {
        if (typeof value !== 'number') return false;
        const s = this.statsOf(rule, format);
        const n = s.sorted.length;
        const k = Math.max(1, rule.percent ? Math.floor((n * (rule.rank ?? 10)) / 100) : (rule.rank ?? 10));
        if (!n) return false;
        return rule.bottom ? value <= s.sorted[Math.min(k, n) - 1] : value >= s.sorted[Math.max(0, n - k)];
      }
      case 'aboveAverage': {
        if (typeof value !== 'number') return false;
        const s = this.statsOf(rule, format);
        const limit = s.mean + (rule.stdDev ?? 0) * s.sd * (rule.aboveAverage === false ? -1 : 1);
        if (rule.aboveAverage === false) return rule.equalAverage ? value <= limit : value < limit;
        return rule.equalAverage ? value >= limit : value > limit;
      }
      case 'duplicateValues':
      case 'uniqueValues': {
        if (value === BLANK) return false;
        const count = this.statsOf(rule, format).counts.get(valueKey(value)) ?? 0;
        return rule.type === 'duplicateValues' ? count > 1 : count === 1;
      }
      case 'containsBlanks':
        return value === BLANK || (typeof value === 'string' && !value.trim());
      case 'notContainsBlanks':
        return !(value === BLANK || (typeof value === 'string' && !value.trim()));
      case 'containsErrors':
        return value instanceof FormulaError;
      case 'notContainsErrors':
        return !(value instanceof FormulaError);
      default: {
        // expression, containsText and the like, timePeriod: the rule's formula says (Excel writes one for each).
        if (!rule.formulas.length) return false;
        const r = formula(0);
        if (r instanceof FormulaError) return false;
        const b = toBool(r === BLANK ? false : r);
        return b === true;
      }
    }
  }

  private statsOf(rule: CfRule, format: ConditionalFormat): Stats {
    let s = this.stats.get(rule);
    if (s) return s;
    const numbers: number[] = [];
    const counts = new Map<string, number>();
    for (const r of format.ranges) {
      for (let row = r.r0; row <= Math.min(r.r1, this.sheet.grid.rows - 1); row++) {
        for (let col = r.c0; col <= Math.min(r.c1, this.sheet.grid.cols - 1); col++) {
          const v = this.engine.value(this.sheetIndex, row, col);
          if (typeof v === 'number') numbers.push(v);
          if (v !== BLANK) counts.set(valueKey(v), (counts.get(valueKey(v)) ?? 0) + 1);
        }
      }
    }
    const sorted = numbers.slice().sort((a, b) => a - b);
    const mean = numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : 0;
    const sd = numbers.length > 1 ? Math.sqrt(numbers.reduce((a, b) => a + (b - mean) ** 2, 0) / (numbers.length - 1)) : 0;
    this.stats.set(rule, (s = { numbers, sorted, mean, sd, counts }));
    return s;
  }

  /** A scale's or bar's thresholds as numbers. */
  private thresholds(rule: CfRule, cfvo: Cfvo[], format: ConditionalFormat): number[] {
    let limits = this.limits.get(rule);
    if (limits) return limits;
    const s = this.statsOf(rule, format);
    const lo = s.sorted[0] ?? 0;
    const hi = s.sorted[s.sorted.length - 1] ?? 0;
    const top = format.ranges[0];
    limits = cfvo.map((v) => {
      const val = v.val === undefined ? 0 : /^[-+.\d]/.test(v.val) ? +v.val : +String(this.engine.formulaValue(v.val, this.sheetIndex, top.r0, top.c0, top.r0, top.c0));
      switch (v.type) {
        case 'min':
        case 'autoMin':
          return lo;
        case 'max':
        case 'autoMax':
          return hi;
        case 'percent':
          return lo + ((hi - lo) * val) / 100;
        case 'percentile': {
          const n = s.sorted.length;
          if (!n) return 0;
          const h = (val / 100) * (n - 1);
          const i = Math.floor(h);
          return i + 1 >= n ? s.sorted[n - 1] : s.sorted[i] + (h - i) * (s.sorted[i + 1] - s.sorted[i]);
        }
        default:
          return val;
      }
    });
    this.limits.set(rule, limits);
    return limits;
  }
}

/** A value's colour on a 2- or 3-colour scale, mixed between the colours of the thresholds around it. */
function scaleColor(value: number, limits: number[], colors: number[]): number {
  if (colors.length < 2) return colors[0] ?? 0;
  if (value <= limits[0]) return colors[0];
  for (let i = 1; i < limits.length && i < colors.length; i++) {
    if (value <= limits[i]) {
      const span = limits[i] - limits[i - 1];
      return mix(colors[i - 1], colors[i], span ? (value - limits[i - 1]) / span : 1);
    }
  }
  return colors[colors.length - 1];
}
