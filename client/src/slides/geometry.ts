// Shape outlines (docs/slides.md): DrawingML's custom geometry (`a:custGeom`: guides, then paths of moves, lines, arcs and
// curves) evaluated in full, and its preset shapes (`a:prstGeom`) drawn here by hand for the ones decks use; a preset not
// drawn here is its bounding box. Everything is in the shape's own box: (0, 0) to (w, h), in whatever unit w and h are in.

import type { XmlElement } from '@golemdocs/docx';
import type { PathCommand } from '../vector/model.ts';
import { kid, kids, num } from './ooxml.ts';

/** One subpath list of a shape, and how it is painted (a path may be outline only, or filled only). */
export interface GeometryPath {
  commands: PathCommand[];
  fill: boolean;
  stroke: boolean;
  /** `darken`, `lighten`... from the path's `fill` attribute: drawn in a shade of the shape's fill. */
  shade?: 'darken' | 'darkenLess' | 'lighten' | 'lightenLess';
}

/** Where text goes in a shape (`a:rect`), in the shape's box. */
export interface TextRect {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface Geometry {
  paths: GeometryPath[];
  text: TextRect;
  /** A line or connector: stroked only, and its ends may have arrowheads. */
  open: boolean;
}

// ---- The guide language ----------------------------------------------------------------------

const DEG = 60000;
const toRad = (angle: number): number => (angle / DEG) * (Math.PI / 180);
const fromRad = (rad: number): number => (rad * 180 * DEG) / Math.PI;

/** The variables every guide can use: the box, its fractions and the fixed angles. */
export function builtins(w: number, h: number): Map<string, number> {
  const ss = Math.min(w, h);
  const ls = Math.max(w, h);
  const vars = new Map<string, number>([
    ['w', w],
    ['h', h],
    ['l', 0],
    ['t', 0],
    ['r', w],
    ['b', h],
    ['hc', w / 2],
    ['vc', h / 2],
    ['ss', ss],
    ['ls', ls],
    ['cd2', 10800000],
    ['cd4', 5400000],
    ['cd8', 2700000],
    ['3cd4', 16200000],
    ['3cd8', 8100000],
    ['5cd8', 13500000],
    ['7cd8', 18900000],
  ]);
  for (const d of [2, 3, 4, 5, 6, 8, 10, 12, 16, 32]) {
    vars.set(`wd${d}`, w / d);
    vars.set(`hd${d}`, h / d);
    vars.set(`ssd${d}`, ss / d);
  }
  return vars;
}

function evalFormula(formula: string, vars: Map<string, number>): number {
  const parts = formula.trim().split(/\s+/);
  const v = (i: number): number => {
    const token = parts[i];
    if (token === undefined) return 0;
    const n = Number(token);
    return Number.isFinite(n) ? n : (vars.get(token) ?? 0);
  };
  const [a, b, c] = [v(1), v(2), v(3)];
  switch (parts[0]) {
    case '*/':
      return c === 0 ? 0 : (a * b) / c;
    case '+-':
      return a + b - c;
    case '+/':
      return c === 0 ? 0 : (a + b) / c;
    case '?:':
      return a > 0 ? b : c;
    case 'abs':
      return Math.abs(a);
    case 'at2':
      return fromRad(Math.atan2(b, a));
    case 'cat2':
      return a * Math.cos(Math.atan2(c, b));
    case 'cos':
      return a * Math.cos(toRad(b));
    case 'max':
      return Math.max(a, b);
    case 'min':
      return Math.min(a, b);
    case 'mod':
      return Math.sqrt(a * a + b * b + c * c);
    case 'pin':
      return b < a ? a : b > c ? c : b;
    case 'sat2':
      return a * Math.sin(Math.atan2(c, b));
    case 'sin':
      return a * Math.sin(toRad(b));
    case 'sqrt':
      return Math.sqrt(Math.max(0, a));
    case 'tan':
      return a * Math.tan(toRad(b));
    case 'val':
      return a;
    default:
      return 0;
  }
}

/** Evaluates guide lists (`a:avLst` then `a:gdLst`) in order, each seeing the ones before. */
export function evaluateGuides(lists: (XmlElement | undefined)[], vars: Map<string, number>): void {
  for (const list of lists) for (const gd of kids(list, 'a:gd')) if (gd.attrs.name) vars.set(gd.attrs.name, evalFormula(gd.attrs.fmla ?? 'val 0', vars));
}

// ---- Path building -----------------------------------------------------------------------------

/** Builds a subpath list in the shape's box, with DrawingML's arcs. */
class Pen {
  readonly commands: PathCommand[] = [];
  private x = 0;
  private y = 0;

  move(x: number, y: number): this {
    this.commands.push(['M', x, y]);
    this.x = x;
    this.y = y;
    return this;
  }

  line(x: number, y: number): this {
    this.commands.push(['L', x, y]);
    this.x = x;
    this.y = y;
    return this;
  }

  cubic(x1: number, y1: number, x2: number, y2: number, x: number, y: number): this {
    this.commands.push(['C', x1, y1, x2, y2, x, y]);
    this.x = x;
    this.y = y;
    return this;
  }

  quad(x1: number, y1: number, x: number, y: number): this {
    return this.cubic(this.x + ((x1 - this.x) * 2) / 3, this.y + ((y1 - this.y) * 2) / 3, x + ((x1 - x) * 2) / 3, y + ((y1 - y) * 2) / 3, x, y);
  }

  /**
   * DrawingML's arcTo: along an ellipse of radii (wr, hr) from the pen, which is at angle `start` of it, through `sweep` (both
   * in 60000ths of a degree, clockwise as y grows down). Angles are as seen, not the ellipse's parameter.
   */
  arc(wr: number, hr: number, start: number, sweep: number): this {
    if (wr <= 0 || hr <= 0) return this;
    const param = (angle: number): number => {
      const a = toRad(angle);
      return Math.atan2(wr * Math.sin(a), hr * Math.cos(a));
    };
    const t0 = param(start);
    const cx = this.x - wr * Math.cos(t0);
    const cy = this.y - hr * Math.sin(t0);
    let t1 = param(start + sweep);
    const sweepRad = toRad(sweep);
    if (Math.abs(sweepRad) >= Math.PI * 2 - 1e-9) t1 = t0 + Math.sign(sweepRad) * Math.PI * 2;
    else {
      while (sweepRad > 0 && t1 < t0) t1 += Math.PI * 2;
      while (sweepRad < 0 && t1 > t0) t1 -= Math.PI * 2;
    }
    this.ellipseArc(cx, cy, wr, hr, t0, t1);
    return this;
  }

  /** Arc of an ellipse by its parameter, as cubic curves of at most a quarter turn. */
  ellipseArc(cx: number, cy: number, rx: number, ry: number, t0: number, t1: number): this {
    const segments = Math.max(1, Math.ceil(Math.abs(t1 - t0) / (Math.PI / 2) - 1e-9));
    const step = (t1 - t0) / segments;
    const k = (4 / 3) * Math.tan(step / 4);
    let a = t0;
    for (let i = 0; i < segments; i++) {
      const b = a + step;
      const [ca, sa, cb, sb] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)];
      this.cubic(cx + rx * (ca - k * sa), cy + ry * (sa + k * ca), cx + rx * (cb + k * sb), cy + ry * (sb - k * cb), cx + rx * cb, cy + ry * sb);
      a = b;
    }
    return this;
  }

  close(): this {
    this.commands.push(['Z']);
    return this;
  }
}

/** Custom geometry (`a:custGeom`, or a preset written out the same way) for a box of w × h. */
export function customGeometry(geom: XmlElement, w: number, h: number): Geometry {
  const vars = builtins(w, h);
  evaluateGuides([kid(geom, 'a:avLst'), kid(geom, 'a:gdLst')], vars);
  const value = (token: string | undefined): number => {
    if (token === undefined) return 0;
    const n = Number(token);
    return Number.isFinite(n) ? n : (vars.get(token) ?? 0);
  };
  const paths: GeometryPath[] = [];
  let open = true;
  for (const path of kids(kid(geom, 'a:pathLst'), 'a:path')) {
    const pw = num(path, 'w') ?? 0;
    const ph = num(path, 'h') ?? 0;
    // A path's own coordinate space is scaled onto the box.
    const sx = pw > 0 ? w / pw : 1;
    const sy = ph > 0 ? h / ph : 1;
    const pen = new Pen();
    const pt = (element: XmlElement | undefined): [number, number] => [value(element?.attrs.x) * sx, value(element?.attrs.y) * sy];
    for (const cmd of kids(path)) {
      switch (cmd.name) {
        case 'a:moveTo':
          pen.move(...pt(kid(cmd, 'a:pt')));
          break;
        case 'a:lnTo':
          pen.line(...pt(kid(cmd, 'a:pt')));
          break;
        case 'a:arcTo':
          pen.arc(value(cmd.attrs.wR) * sx, value(cmd.attrs.hR) * sy, value(cmd.attrs.stAng), value(cmd.attrs.swAng));
          break;
        case 'a:quadBezTo': {
          const [p1, p2] = kids(cmd, 'a:pt').map(pt);
          if (p1 && p2) pen.quad(p1[0], p1[1], p2[0], p2[1]);
          break;
        }
        case 'a:cubicBezTo': {
          const [p1, p2, p3] = kids(cmd, 'a:pt').map(pt);
          if (p1 && p2 && p3) pen.cubic(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
          break;
        }
        case 'a:close':
          pen.close();
          open = false;
          break;
      }
    }
    const fillAttr = path.attrs.fill;
    const fill = fillAttr !== 'none';
    if (fill) open = false;
    paths.push({
      commands: pen.commands,
      fill,
      stroke: path.attrs.stroke !== '0' && path.attrs.stroke !== 'false',
      shade: fillAttr === 'darken' || fillAttr === 'darkenLess' || fillAttr === 'lighten' || fillAttr === 'lightenLess' ? fillAttr : undefined,
    });
  }
  const rect = kid(geom, 'a:rect');
  const text = rect ? { l: value(rect.attrs.l), t: value(rect.attrs.t), r: value(rect.attrs.r), b: value(rect.attrs.b) } : { l: 0, t: 0, r: w, b: h };
  return { paths, text, open: open && paths.length > 0 };
}

// ---- Preset shapes ------------------------------------------------------------------------------

type Adjust = (name: string, fallback: number) => number;

const box = (w: number, h: number): TextRect => ({ l: 0, t: 0, r: w, b: h });
const filled = (pen: Pen, extra: Partial<GeometryPath> = {}): GeometryPath => ({ commands: pen.commands, fill: true, stroke: true, ...extra });
const shape = (paths: GeometryPath[], text: TextRect, open = false): Geometry => ({ paths, text, open });

function polygon(points: [number, number][]): Pen {
  const pen = new Pen();
  points.forEach(([x, y], i) => (i ? pen.line(x, y) : pen.move(x, y)));
  return pen.close();
}

function ellipsePen(cx: number, cy: number, rx: number, ry: number): Pen {
  return new Pen().move(cx + rx, cy).ellipseArc(cx, cy, rx, ry, 0, Math.PI * 2).close();
}

function roundRect(w: number, h: number, r: number): Pen {
  const pen = new Pen();
  if (r <= 0) return polygon([[0, 0], [w, 0], [w, h], [0, h]]);
  return pen
    .move(0, r)
    .arc(r, r, 10800000, 5400000)
    .line(w - r, 0)
    .arc(r, r, 16200000, 5400000)
    .line(w, h - r)
    .arc(r, r, 0, 5400000)
    .line(r, h)
    .arc(r, r, 5400000, 5400000)
    .close();
}

/** A star of n points, the inner points at `ratio` of the outer radius. */
function star(w: number, h: number, n: number, ratio: number, hf = 1, vf = 1): Pen {
  const points: [number, number][] = [];
  const rx = (w / 2) * hf;
  const ry = (h / 2) * vf;
  const cy = (h / 2) * vf;
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const k = i % 2 ? ratio : 1;
    points.push([w / 2 + rx * k * Math.cos(a), cy + ry * k * Math.sin(a)]);
  }
  return polygon(points);
}

/** A regular polygon of n sides, a point at the top. */
function regular(w: number, h: number, n: number, hf = 1, vf = 1): Pen {
  const points: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    points.push([w / 2 + (w / 2) * hf * Math.cos(a), (h / 2) * vf + (h / 2) * vf * Math.sin(a)]);
  }
  return polygon(points);
}

/** An arrow pointing right in a box of w × h (the others are turned copies). */
function rightArrow(w: number, h: number, adj: Adjust): Pen {
  const ss = Math.min(w, h);
  const a1 = Math.min(Math.max(adj('adj1', 50000), 0), 100000);
  const maxAdj2 = (100000 * w) / ss;
  const a2 = Math.min(Math.max(adj('adj2', 50000), 0), maxAdj2);
  const dx1 = (ss * a2) / 100000;
  const x1 = w - dx1;
  const dy1 = (h * a1) / 200000;
  return polygon([
    [0, h / 2 - dy1],
    [x1, h / 2 - dy1],
    [x1, 0],
    [w, h / 2],
    [x1, h],
    [x1, h / 2 + dy1],
    [0, h / 2 + dy1],
  ]);
}

function mapPen(pen: Pen, f: (x: number, y: number) => [number, number]): Pen {
  const out = new Pen();
  for (const c of pen.commands) {
    if (c[0] === 'M') out.move(...f(c[1], c[2]));
    else if (c[0] === 'L') out.line(...f(c[1], c[2]));
    else if (c[0] === 'C') {
      const [a, b] = f(c[1], c[2]);
      const [d, e] = f(c[3], c[4]);
      const [g, k] = f(c[5], c[6]);
      out.cubic(a, b, d, e, g, k);
    } else out.close();
  }
  return out;
}

function presetPaths(name: string, w: number, h: number, adj: Adjust): Geometry | null {
  const ss = Math.min(w, h);
  const a = (key: string, fallback: number): number => adj(key, fallback);
  switch (name) {
    case 'rect':
    case 'flowChartProcess':
    case 'textBox':
      return shape([filled(polygon([[0, 0], [w, 0], [w, h], [0, h]]))], box(w, h));
    case 'roundRect':
    case 'flowChartAlternateProcess': {
      const r = (ss * Math.min(Math.max(a('adj', name === 'roundRect' ? 16667 : 16667), 0), 50000)) / 100000;
      const inset = r * 0.29289;
      return shape([filled(roundRect(w, h, r))], { l: inset, t: inset, r: w - inset, b: h - inset });
    }
    case 'ellipse':
    case 'flowChartConnector': {
      const idx = (w / 2) * Math.cos(Math.PI / 4);
      const idy = (h / 2) * Math.sin(Math.PI / 4);
      return shape([filled(ellipsePen(w / 2, h / 2, w / 2, h / 2))], { l: w / 2 - idx, t: h / 2 - idy, r: w / 2 + idx, b: h / 2 + idy });
    }
    case 'triangle':
    case 'flowChartExtract': {
      const x = (w * Math.min(Math.max(a('adj', 50000), 0), 100000)) / 100000;
      return shape([filled(polygon([[x, 0], [w, h], [0, h]]))], { l: x / 2, t: h / 2, r: (x + w) / 2, b: h });
    }
    case 'flowChartMerge':
      return shape([filled(polygon([[0, 0], [w, 0], [w / 2, h]]))], { l: w / 4, t: 0, r: (w * 3) / 4, b: h / 2 });
    case 'rtTriangle':
      return shape([filled(polygon([[0, 0], [w, h], [0, h]]))], { l: w / 12, t: (h * 7) / 12, r: (w * 7) / 12, b: (h * 11) / 12 });
    case 'diamond':
    case 'flowChartDecision':
      return shape([filled(polygon([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]))], { l: w / 4, t: h / 4, r: (w * 3) / 4, b: (h * 3) / 4 });
    case 'parallelogram':
    case 'flowChartInputOutput': {
      const x = name === 'parallelogram' ? (ss * Math.min(Math.max(a('adj', 25000), 0), (100000 * w) / ss)) / 100000 : w / 5;
      return shape([filled(polygon([[x, 0], [w, 0], [w - x, h], [0, h]]))], { l: x / 2, t: 0, r: w - x / 2, b: h });
    }
    case 'trapezoid': {
      const x = (ss * Math.min(Math.max(a('adj', 25000), 0), (50000 * w) / ss)) / 100000;
      return shape([filled(polygon([[0, h], [x, 0], [w - x, 0], [w, h]]))], { l: x / 2, t: 0, r: w - x / 2, b: h });
    }
    case 'flowChartManualOperation':
      return shape([filled(polygon([[0, 0], [w, 0], [(w * 4) / 5, h], [w / 5, h]]))], { l: w / 5, t: 0, r: (w * 4) / 5, b: h });
    case 'pentagon':
      return shape([filled(regular(w, h, 5, a('hf', 105146) / 100000, a('vf', 110557) / 100000))], { l: w * 0.2, t: h * 0.3, r: w * 0.8, b: h });
    case 'hexagon':
    case 'flowChartPreparation': {
      const x = name === 'hexagon' ? (ss * Math.min(Math.max(a('adj', 25000), 0), (50000 * w) / ss)) / 100000 : w / 5;
      return shape([filled(polygon([[0, h / 2], [x, 0], [w - x, 0], [w, h / 2], [w - x, h], [x, h]]))], { l: x / 2, t: h / 4, r: w - x / 2, b: (h * 3) / 4 });
    }
    case 'heptagon':
      return shape([filled(regular(w, h, 7, a('hf', 102572) / 100000, a('vf', 105210) / 100000))], { l: w * 0.2, t: h * 0.2, r: w * 0.8, b: h * 0.85 });
    case 'octagon': {
      const x = (ss * Math.min(Math.max(a('adj', 29289), 0), 50000)) / 100000;
      return shape([filled(polygon([[x, 0], [w - x, 0], [w, x], [w, h - x], [w - x, h], [x, h], [0, h - x], [0, x]]))], { l: x / 2, t: x / 2, r: w - x / 2, b: h - x / 2 });
    }
    case 'decagon':
      return shape([filled(regular(w, h, 10, 1, a('vf', 105146) / 100000))], { l: w * 0.15, t: h * 0.15, r: w * 0.85, b: h * 0.85 });
    case 'dodecagon':
      return shape([filled(regular(w, h, 12))], { l: w * 0.15, t: h * 0.15, r: w * 0.85, b: h * 0.85 });
    case 'star4':
      return shape([filled(star(w, h, 4, (a('adj', 12500) / 50000) * 1))], { l: w * 0.35, t: h * 0.35, r: w * 0.65, b: h * 0.65 });
    case 'star5':
      return shape([filled(star(w, h, 5, a('adj', 19098) / 50000, a('hf', 105146) / 100000, a('vf', 110557) / 100000))], { l: w * 0.3, t: h * 0.35, r: w * 0.7, b: h * 0.75 });
    case 'star6':
      return shape([filled(star(w, h, 6, a('adj', 28868) / 50000, a('hf', 115470) / 100000))], { l: w * 0.3, t: h * 0.3, r: w * 0.7, b: h * 0.7 });
    case 'star7':
      return shape([filled(star(w, h, 7, a('adj', 34601) / 50000))], { l: w * 0.3, t: h * 0.3, r: w * 0.7, b: h * 0.7 });
    case 'star8':
      return shape([filled(star(w, h, 8, a('adj', 38250) / 50000))], { l: w * 0.3, t: h * 0.3, r: w * 0.7, b: h * 0.7 });
    case 'star10':
      return shape([filled(star(w, h, 10, a('adj', 42533) / 50000, a('hf', 105146) / 100000))], { l: w * 0.25, t: h * 0.25, r: w * 0.75, b: h * 0.75 });
    case 'star12':
      return shape([filled(star(w, h, 12, a('adj', 37500) / 50000))], { l: w * 0.25, t: h * 0.25, r: w * 0.75, b: h * 0.75 });
    case 'star16':
    case 'star24':
    case 'star32':
      return shape([filled(star(w, h, Number(name.slice(4)), a('adj', 37500) / 50000))], { l: w * 0.2, t: h * 0.2, r: w * 0.8, b: h * 0.8 });
    case 'plus': {
      const x = (ss * Math.min(Math.max(a('adj', 25000), 0), 50000)) / 100000;
      return shape([filled(polygon([[0, x], [x, x], [x, 0], [w - x, 0], [w - x, x], [w, x], [w, h - x], [w - x, h - x], [w - x, h], [x, h], [x, h - x], [0, h - x]]))], { l: 0, t: x, r: w, b: h - x });
    }
    case 'donut': {
      const d = (ss * Math.min(Math.max(a('adj', 25000), 0), 50000)) / 100000;
      const outer = ellipsePen(w / 2, h / 2, w / 2, h / 2);
      const inner = new Pen().move(w / 2 + (w / 2 - d), h / 2).ellipseArc(w / 2, h / 2, w / 2 - d, h / 2 - d, 0, -Math.PI * 2).close();
      return shape([{ commands: [...outer.commands, ...inner.commands], fill: true, stroke: true }], box(w, h));
    }
    case 'frame': {
      const d = (ss * Math.min(Math.max(a('adj1', 12500), 0), 50000)) / 100000;
      const outer = polygon([[0, 0], [w, 0], [w, h], [0, h]]);
      const inner = polygon([[d, d], [d, h - d], [w - d, h - d], [w - d, d]]);
      return shape([{ commands: [...outer.commands, ...inner.commands], fill: true, stroke: true }], { l: d, t: d, r: w - d, b: h - d });
    }
    case 'can':
    case 'flowChartMagneticDisk': {
      const y = name === 'can' ? (ss * Math.min(Math.max(a('adj', 25000), 0), (50000 * h) / ss)) / 100000 : h / 3;
      const ry = y / 2;
      const body = new Pen().move(0, ry).ellipseArc(w / 2, ry, w / 2, ry, Math.PI, 0).line(w, h - ry).ellipseArc(w / 2, h - ry, w / 2, ry, 0, Math.PI).close();
      const top = ellipsePen(w / 2, ry, w / 2, ry);
      return shape([filled(body), { commands: top.commands, fill: true, stroke: true, shade: 'lighten' }], { l: 0, t: y, r: w, b: h - ry });
    }
    case 'cube': {
      const d = (ss * Math.min(Math.max(a('adj', 25000), 0), 100000)) / 100000;
      const front = polygon([[0, d], [w - d, d], [w - d, h], [0, h]]);
      const top = polygon([[0, d], [d, 0], [w, 0], [w - d, d]]);
      const side = polygon([[w - d, d], [w, 0], [w, h - d], [w - d, h]]);
      return shape([filled(front), { commands: top.commands, fill: true, stroke: true, shade: 'lightenLess' }, { commands: side.commands, fill: true, stroke: true, shade: 'darkenLess' }], { l: 0, t: d, r: w - d, b: h });
    }
    case 'chevron': {
      const x = (ss * Math.min(Math.max(a('adj', 50000), 0), (100000 * w) / ss)) / 100000;
      return shape([filled(polygon([[0, 0], [w - x, 0], [w, h / 2], [w - x, h], [0, h], [x, h / 2]]))], { l: x, t: 0, r: w - x, b: h });
    }
    case 'homePlate': {
      const x = (ss * Math.min(Math.max(a('adj', 50000), 0), (100000 * w) / ss)) / 100000;
      return shape([filled(polygon([[0, 0], [w - x, 0], [w, h / 2], [w - x, h], [0, h]]))], { l: 0, t: 0, r: (w + w - x) / 2, b: h });
    }
    case 'rightArrow':
      return shape([filled(rightArrow(w, h, adj))], { l: 0, t: h / 4, r: w, b: (h * 3) / 4 });
    case 'leftArrow':
      return shape([filled(mapPen(rightArrow(w, h, adj), (x, y) => [w - x, y]))], { l: 0, t: h / 4, r: w, b: (h * 3) / 4 });
    case 'downArrow':
      return shape([filled(mapPen(rightArrow(h, w, adj), (x, y) => [y, x]))], { l: w / 4, t: 0, r: (w * 3) / 4, b: h });
    case 'upArrow':
      return shape([filled(mapPen(rightArrow(h, w, adj), (x, y) => [y, h - x]))], { l: w / 4, t: 0, r: (w * 3) / 4, b: h });
    case 'leftRightArrow': {
      const a1 = Math.min(Math.max(a('adj1', 50000), 0), 100000);
      const dx = (ss * Math.min(Math.max(a('adj2', 50000), 0), (50000 * w) / ss)) / 100000;
      const dy = (h * a1) / 200000;
      return shape([filled(polygon([[0, h / 2], [dx, 0], [dx, h / 2 - dy], [w - dx, h / 2 - dy], [w - dx, 0], [w, h / 2], [w - dx, h], [w - dx, h / 2 + dy], [dx, h / 2 + dy], [dx, h]]))], box(w, h));
    }
    case 'upDownArrow': {
      const a1 = Math.min(Math.max(a('adj1', 50000), 0), 100000);
      const dy = (ss * Math.min(Math.max(a('adj2', 50000), 0), (50000 * h) / ss)) / 100000;
      const dx = (w * a1) / 200000;
      return shape([filled(polygon([[w / 2, 0], [w, dy], [w / 2 + dx, dy], [w / 2 + dx, h - dy], [w, h - dy], [w / 2, h], [0, h - dy], [w / 2 - dx, h - dy], [w / 2 - dx, dy], [0, dy]]))], box(w, h));
    }
    case 'notchedRightArrow': {
      const pen = rightArrow(w, h, adj);
      const dy = (h * Math.min(Math.max(a('adj1', 50000), 0), 100000)) / 200000;
      const notch = (dy * Math.min(w, h)) / h;
      const cmds = pen.commands.slice();
      cmds.splice(cmds.length - 1, 0, ['L', notch, h / 2]);
      return shape([{ commands: cmds, fill: true, stroke: true }], box(w, h));
    }
    case 'line':
    case 'straightConnector1':
      return shape([{ commands: new Pen().move(0, 0).line(w, h).commands, fill: false, stroke: true }], box(w, h), true);
    case 'bentConnector2':
      return shape([{ commands: new Pen().move(0, 0).line(w, 0).line(w, h).commands, fill: false, stroke: true }], box(w, h), true);
    case 'bentConnector3': {
      const x = (w * a('adj1', 50000)) / 100000;
      return shape([{ commands: new Pen().move(0, 0).line(x, 0).line(x, h).line(w, h).commands, fill: false, stroke: true }], box(w, h), true);
    }
    case 'bentConnector4':
    case 'bentConnector5': {
      const x = (w * a('adj1', 50000)) / 100000;
      const y = (h * a('adj2', 50000)) / 100000;
      return shape([{ commands: new Pen().move(0, 0).line(x, 0).line(x, y).line(w, y).line(w, h).commands, fill: false, stroke: true }], box(w, h), true);
    }
    case 'curvedConnector2':
      return shape([{ commands: new Pen().move(0, 0).cubic(w / 2, 0, w, h / 2, w, h).commands, fill: false, stroke: true }], box(w, h), true);
    case 'curvedConnector3':
    case 'curvedConnector4':
    case 'curvedConnector5': {
      const x = (w * a('adj1', 50000)) / 100000;
      return shape([{ commands: new Pen().move(0, 0).cubic(x / 2, 0, x, h / 4, x, h / 2).cubic(x, (h * 3) / 4, (x + w) / 2, h, w, h).commands, fill: false, stroke: true }], box(w, h), true);
    }
    case 'arc': {
      const st = a('adj1', 16200000);
      const end = a('adj2', 0);
      let sweep = end - st;
      if (sweep <= 0) sweep += 21600000;
      const t = (angle: number): [number, number] => {
        const r = toRad(angle);
        const p = Math.atan2((w / 2) * Math.sin(r), (h / 2) * Math.cos(r));
        return [w / 2 + (w / 2) * Math.cos(p), h / 2 + (h / 2) * Math.sin(p)];
      };
      const pen = new Pen().move(...t(st)).arc(w / 2, h / 2, st, sweep);
      return shape([{ commands: pen.commands, fill: false, stroke: true }], box(w, h), true);
    }
    case 'pie':
    case 'chord': {
      const st = a('adj1', name === 'pie' ? 0 : 2700000);
      const end = a('adj2', name === 'pie' ? 16200000 : 16200000);
      let sweep = end - st;
      if (sweep <= 0) sweep += 21600000;
      const r = toRad(st);
      const p = Math.atan2((w / 2) * Math.sin(r), (h / 2) * Math.cos(r));
      const pen = new Pen().move(w / 2 + (w / 2) * Math.cos(p), h / 2 + (h / 2) * Math.sin(p)).arc(w / 2, h / 2, st, sweep);
      if (name === 'pie') pen.line(w / 2, h / 2);
      return shape([filled(pen.close())], box(w, h));
    }
    case 'teardrop': {
      const pen = new Pen().move(0, h / 2).arc(w / 2, h / 2, 10800000, 5400000).line(w, 0).line(w, h / 2).arc(w / 2, h / 2, 0, 10800000).close();
      return shape([filled(pen)], box(w, h));
    }
    case 'heart': {
      const outline = new Pen().move(w / 2, h / 4).cubic(w / 2 + w / 6, -h / 3, w * 1.25, h / 4, w / 2, h).cubic(-w / 4, h / 4, w / 2 - w / 6, -h / 3, w / 2, h / 4).close();
      return shape([filled(outline)], { l: w / 6, t: h / 4, r: (w * 5) / 6, b: (h * 3) / 4 });
    }
    case 'lightningBolt': {
      const p: [number, number][] = [[8458, 0], [12148, 7065], [10619, 7825], [15515, 12643], [14093, 13310], [21600, 21600], [10125, 14635], [11687, 13886], [5601, 9690], [7083, 8946], [0, 3594]];
      return shape([filled(polygon(p.map(([x, y]) => [(x * w) / 21600, (y * h) / 21600])))], { l: w * 0.4, t: h * 0.3, r: w * 0.6, b: h * 0.7 });
    }
    case 'moon': {
      const x = (ss * Math.min(Math.max(a('adj', 50000), 0), 87500)) / 100000;
      const pen = new Pen().move(w, h).ellipseArc(w, h / 2, w, h / 2, Math.PI / 2, (Math.PI * 3) / 2).ellipseArc(w, h / 2, w - x, h / 2, -Math.PI / 2, -(Math.PI * 3) / 2).close();
      return shape([filled(pen)], { l: x / 2, t: h / 4, r: x, b: (h * 3) / 4 });
    }
    case 'cloud':
    case 'cloudCallout': {
      // Overlapping circles standing in for Office's cloud outline.
      const blobs: [number, number, number, number][] = [
        [0.3, 0.3, 0.22, 0.25],
        [0.55, 0.22, 0.22, 0.22],
        [0.78, 0.38, 0.2, 0.25],
        [0.7, 0.7, 0.24, 0.24],
        [0.42, 0.72, 0.26, 0.24],
        [0.2, 0.58, 0.2, 0.22],
        [0.5, 0.48, 0.3, 0.3],
      ];
      return shape(blobs.map(([cx, cy, rx, ry]) => ({ commands: ellipsePen(cx * w, cy * h, rx * w, ry * h).commands, fill: true, stroke: false })), { l: w * 0.15, t: h * 0.2, r: w * 0.85, b: h * 0.8 });
    }
    case 'flowChartTerminator': {
      const r = Math.min(w / 2, h / 2);
      return shape([filled(new Pen().move(r, 0).line(w - r, 0).arc(r, h / 2, 16200000, 10800000).line(r, h).arc(r, h / 2, 5400000, 10800000).close())], { l: w / 10, t: h / 6, r: (w * 9) / 10, b: (h * 5) / 6 });
    }
    case 'flowChartDocument': {
      const pen = new Pen().move(0, 0).line(w, 0).line(w, h * 0.8).cubic(w * 0.75, h * 0.65, w * 0.5, h * 0.72, w * 0.35, h * 0.85).cubic(w * 0.2, h * 0.98, w * 0.1, h * 0.95, 0, h * 0.88).close();
      return shape([filled(pen)], { l: 0, t: 0, r: w, b: h * 0.78 });
    }
    case 'flowChartPredefinedProcess': {
      const outer = polygon([[0, 0], [w, 0], [w, h], [0, h]]);
      const lines = new Pen().move(w / 8, 0).line(w / 8, h).move((w * 7) / 8, 0).line((w * 7) / 8, h);
      return shape([filled(outer), { commands: lines.commands, fill: false, stroke: true }], { l: w / 8, t: 0, r: (w * 7) / 8, b: h });
    }
    case 'flowChartManualInput':
      return shape([filled(polygon([[0, h / 5], [w, 0], [w, h], [0, h]]))], { l: 0, t: h / 5, r: w, b: h });
    case 'flowChartOffpageConnector':
      return shape([filled(polygon([[0, 0], [w, 0], [w, h * 0.8], [w / 2, h], [0, h * 0.8]]))], { l: 0, t: 0, r: w, b: h * 0.8 });
    case 'flowChartPunchedCard':
      return shape([filled(polygon([[w / 5, 0], [w, 0], [w, h], [0, h], [0, h / 5]]))], { l: 0, t: h / 5, r: w, b: h });
    case 'snip1Rect': {
      const d = (ss * Math.min(Math.max(a('adj', 16667), 0), 50000)) / 100000;
      return shape([filled(polygon([[0, 0], [w - d, 0], [w, d], [w, h], [0, h]]))], { l: 0, t: d / 2, r: w - d / 2, b: h });
    }
    case 'snip2SameRect': {
      const d = (ss * Math.min(Math.max(a('adj1', 16667), 0), 50000)) / 100000;
      const d2 = (ss * Math.min(Math.max(a('adj2', 0), 0), 50000)) / 100000;
      return shape([filled(polygon([[d, 0], [w - d, 0], [w, d], [w, h - d2], [w - d2, h], [d2, h], [0, h - d2], [0, d]]))], { l: d / 2, t: d / 2, r: w - d / 2, b: h });
    }
    case 'snip2DiagRect':
    case 'snipRoundRect': {
      const d = (ss * Math.min(Math.max(a('adj2', 16667), 0), 50000)) / 100000;
      return shape([filled(polygon([[0, 0], [w - d, 0], [w, d], [w, h], [d, h], [0, h - d]]))], box(w, h));
    }
    case 'round1Rect': {
      const r = (ss * Math.min(Math.max(a('adj', 16667), 0), 50000)) / 100000;
      return shape([filled(new Pen().move(0, 0).line(w - r, 0).arc(r, r, 16200000, 5400000).line(w, h).line(0, h).close())], box(w, h));
    }
    case 'round2SameRect': {
      const r = (ss * Math.min(Math.max(a('adj1', 16667), 0), 50000)) / 100000;
      const r2 = (ss * Math.min(Math.max(a('adj2', 0), 0), 50000)) / 100000;
      const pen = new Pen().move(r, 0).line(w - r, 0).arc(r, r, 16200000, 5400000).line(w, h - r2);
      if (r2) pen.arc(r2, r2, 0, 5400000);
      pen.line(r2, h);
      if (r2) pen.arc(r2, r2, 5400000, 5400000);
      pen.line(0, r).arc(r, r, 10800000, 5400000).close();
      return shape([filled(pen)], box(w, h));
    }
    case 'round2DiagRect': {
      const r = (ss * Math.min(Math.max(a('adj1', 16667), 0), 50000)) / 100000;
      const pen = new Pen().move(r, 0).line(w, 0).line(w, h - r).arc(r, r, 0, 5400000).line(0, h).line(0, r).arc(r, r, 10800000, 5400000).close();
      return shape([filled(pen)], box(w, h));
    }
    case 'plaque': {
      const r = (ss * Math.min(Math.max(a('adj', 16667), 0), 50000)) / 100000;
      const pen = new Pen().move(0, r).arc(r, r, 5400000, -5400000).line(w - r, 0).arc(r, r, 10800000, -5400000).line(w, h - r).arc(r, r, 16200000, -5400000).line(r, h).arc(r, r, 0, -5400000).close();
      return shape([filled(pen)], { l: r * 0.7, t: r * 0.7, r: w - r * 0.7, b: h - r * 0.7 });
    }
    case 'foldedCorner': {
      const d = (ss * Math.min(Math.max(a('adj', 16667), 0), 50000)) / 100000;
      const body = polygon([[0, 0], [w, 0], [w, h - d], [w - d, h], [0, h]]);
      const fold = polygon([[w - d, h], [w - d * 0.8, h - d * 0.8], [w, h - d]]);
      return shape([filled(body), { commands: fold.commands, fill: true, stroke: true, shade: 'darkenLess' }], { l: 0, t: 0, r: w, b: h - d });
    }
    case 'bracketPair':
    case 'bracePair': {
      const r = (ss * Math.min(Math.max(a('adj', name === 'bracketPair' ? 16667 : 8333), 0), 50000)) / 100000;
      const left = new Pen().move(r, h).arc(r, r, 5400000, 5400000).line(0, r).arc(r, r, 10800000, 5400000);
      const right = new Pen().move(w - r, 0).arc(r, r, 16200000, 5400000).line(w, h - r).arc(r, r, 0, 5400000);
      return shape([{ commands: [...left.commands, ...right.commands], fill: false, stroke: true }], { l: r, t: r, r: w - r, b: h - r }, true);
    }
    case 'leftBracket':
    case 'leftBrace': {
      const r = Math.min(w, h / 2);
      return shape([{ commands: new Pen().move(w, h).arc(w, r, 5400000, 5400000).line(0, r).arc(w, r, 10800000, 5400000).commands, fill: false, stroke: true }], box(w, h), true);
    }
    case 'rightBracket':
    case 'rightBrace': {
      const r = Math.min(w, h / 2);
      return shape([{ commands: new Pen().move(0, 0).arc(w, r, 16200000, 5400000).line(w, h - r).arc(w, r, 0, 5400000).commands, fill: false, stroke: true }], box(w, h), true);
    }
    case 'wedgeRectCallout':
    case 'wedgeRoundRectCallout':
    case 'wedgeEllipseCallout': {
      const tx = w / 2 + (w * a('adj1', -20833)) / 100000;
      const ty = h / 2 + (h * a('adj2', 62500)) / 100000;
      let body: Pen;
      if (name === 'wedgeEllipseCallout') body = ellipsePen(w / 2, h / 2, w / 2, h / 2);
      else body = name === 'wedgeRoundRectCallout' ? roundRect(w, h, ss / 6) : polygon([[0, 0], [w, 0], [w, h], [0, h]]);
      // The pointer: a triangle from the side nearest the tip.
      const below = ty > h;
      const bx = Math.min(Math.max(tx, w * 0.2), w * 0.8);
      const tri = below ? polygon([[bx - w / 12, h - 1], [tx, ty], [bx + w / 12, h - 1]]) : ty < 0 ? polygon([[bx - w / 12, 1], [tx, ty], [bx + w / 12, 1]]) : tx < 0 ? polygon([[1, h / 2 - h / 12], [tx, ty], [1, h / 2 + h / 12]]) : polygon([[w - 1, h / 2 - h / 12], [tx, ty], [w - 1, h / 2 + h / 12]]);
      return shape([{ commands: [...body.commands, ...tri.commands], fill: true, stroke: true }], box(w, h));
    }
    case 'noSmoking':
    case 'blockArc':
    case 'smileyFace': {
      const outer = ellipsePen(w / 2, h / 2, w / 2, h / 2);
      return shape([filled(outer)], box(w, h));
    }
    default:
      return null;
  }
}

/** The geometry of a shape's properties (`p:spPr`) for a box of w × h; a box when it has none. */
export function shapeGeometry(spPr: XmlElement | undefined, w: number, h: number): Geometry {
  const cust = kid(spPr, 'a:custGeom');
  if (cust) return customGeometry(cust, w, h);
  const prst = kid(spPr, 'a:prstGeom');
  return presetGeometry(prst?.attrs.prst ?? 'rect', prst, w, h);
}

export function presetGeometry(name: string, prst: XmlElement | undefined, w: number, h: number): Geometry {
  const values = new Map<string, number>();
  const vars = builtins(w, h);
  for (const gd of kids(kid(prst, 'a:avLst'), 'a:gd')) {
    const parts = (gd.attrs.fmla ?? '').trim().split(/\s+/);
    if (gd.attrs.name && parts[0] === 'val') values.set(gd.attrs.name, Number(parts[1]) || vars.get(parts[1]) || 0);
  }
  const adj: Adjust = (key, fallback) => values.get(key) ?? (key === 'adj' ? values.get('adj1') : key === 'adj1' ? values.get('adj') : undefined) ?? fallback;
  return presetPaths(name, Math.max(w, 0), Math.max(h, 0), adj) ?? presetPaths('rect', w, h, adj)!;
}

/** The preset names this file draws (the rest are drawn as their box). */
export const DRAWN_PRESETS = [
  'rect', 'roundRect', 'ellipse', 'triangle', 'rtTriangle', 'diamond', 'parallelogram', 'trapezoid', 'pentagon', 'hexagon', 'heptagon', 'octagon', 'decagon', 'dodecagon',
  'star4', 'star5', 'star6', 'star7', 'star8', 'star10', 'star12', 'star16', 'star24', 'star32', 'plus', 'donut', 'frame', 'can', 'cube', 'chevron', 'homePlate',
  'rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'leftRightArrow', 'upDownArrow', 'notchedRightArrow', 'line', 'straightConnector1', 'bentConnector2', 'bentConnector3',
  'bentConnector4', 'bentConnector5', 'curvedConnector2', 'curvedConnector3', 'curvedConnector4', 'curvedConnector5', 'arc', 'pie', 'chord', 'teardrop', 'heart',
  'lightningBolt', 'moon', 'cloud', 'cloudCallout', 'snip1Rect', 'snip2SameRect', 'snip2DiagRect', 'snipRoundRect', 'round1Rect', 'round2SameRect', 'round2DiagRect',
  'plaque', 'foldedCorner', 'bracketPair', 'bracePair', 'leftBracket', 'leftBrace', 'rightBracket', 'rightBrace', 'wedgeRectCallout', 'wedgeRoundRectCallout',
  'wedgeEllipseCallout', 'flowChartProcess', 'flowChartAlternateProcess', 'flowChartDecision', 'flowChartInputOutput', 'flowChartPredefinedProcess', 'flowChartDocument',
  'flowChartTerminator', 'flowChartPreparation', 'flowChartManualInput', 'flowChartManualOperation', 'flowChartConnector', 'flowChartOffpageConnector', 'flowChartPunchedCard',
  'flowChartExtract', 'flowChartMerge', 'flowChartMagneticDisk',
] as const;
