// Shape outlines (docs/slides.md): DrawingML's custom geometry (`a:custGeom`: guides, then paths of moves, lines, arcs and
// curves) and its preset shapes (`a:prstGeom`), which are the same thing written in the standard (`presetData.ts`, packed from
// ECMA-376 by scripts/preset-shapes.ts). Everything is in the shape's own box: (0, 0) to (w, h), in whatever unit w and h are in.

import type { XmlElement } from '@golemdocs/docx';
import type { PathCommand } from '../vector/model.ts';
import { kid, kids, num } from './ooxml.ts';
import { PRESET_DATA } from './presetData.ts';

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

// ---- Path building -----------------------------------------------------------------------------

/** Where an angle (as seen, in radians) is on an ellipse's parameter: the same turn, shifted within its quarter. */
function ellipseParam(angle: number, wr: number, hr: number): number {
  const t = Math.atan2(wr * Math.sin(angle), hr * Math.cos(angle));
  return t + Math.round((angle - t) / (Math.PI * 2)) * Math.PI * 2;
}

/** Builds a subpath list, with DrawingML's arcs, in a path's own space, stretched by (sx, sy) onto the shape's box. */
class Pen {
  readonly commands: PathCommand[] = [];
  private x = 0;
  private y = 0;
  private startX = 0;
  private startY = 0;
  private closed = false;
  constructor(
    private readonly sx = 1,
    private readonly sy = 1,
  ) {}

  move(x: number, y: number): void {
    this.commands.push(['M', x * this.sx, y * this.sy]);
    this.x = this.startX = x;
    this.y = this.startY = y;
    this.closed = false;
  }

  line(x: number, y: number): void {
    this.resume();
    this.commands.push(['L', x * this.sx, y * this.sy]);
    this.x = x;
    this.y = y;
  }

  cubic(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    this.resume();
    const { sx, sy } = this;
    this.commands.push(['C', x1 * sx, y1 * sy, x2 * sx, y2 * sy, x * sx, y * sy]);
    this.x = x;
    this.y = y;
  }

  quad(x1: number, y1: number, x: number, y: number): void {
    this.cubic(this.x + ((x1 - this.x) * 2) / 3, this.y + ((y1 - this.y) * 2) / 3, x + ((x1 - x) * 2) / 3, y + ((y1 - y) * 2) / 3, x, y);
  }

  /**
   * DrawingML's arcTo: along an ellipse of radii (wr, hr) from the pen, which is at angle `start` of it, through `sweep` (both
   * in 60000ths of a degree, clockwise as y grows down). Angles are as seen, not the ellipse's parameter. A radius of 0 (an
   * adjustment dragged to its end) is a straight line.
   */
  arc(wr: number, hr: number, start: number, sweep: number): void {
    if (wr <= 0 && hr <= 0) return;
    const rx = Math.max(wr, 1e-6);
    const ry = Math.max(hr, 1e-6);
    const turn = Math.min(Math.max(toRad(sweep), -Math.PI * 2), Math.PI * 2);
    if (turn === 0) return;
    const t0 = ellipseParam(toRad(start), rx, ry);
    const t1 = Math.abs(turn) >= Math.PI * 2 - 1e-9 ? t0 + turn : ellipseParam(toRad(start) + turn, rx, ry);
    this.ellipseArc(this.x - rx * Math.cos(t0), this.y - ry * Math.sin(t0), rx, ry, t0, t1);
  }

  /** Arc of an ellipse by its parameter, as cubic curves of at most a quarter turn. */
  private ellipseArc(cx: number, cy: number, rx: number, ry: number, t0: number, t1: number): void {
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
  }

  close(): void {
    // The spec's accent callouts close a path they have only moved in: that draws nothing.
    if (this.commands[this.commands.length - 1]?.[0] !== 'M') this.commands.push(['Z']);
    this.x = this.startX;
    this.y = this.startY;
    this.closed = true;
  }

  /** Drawing on after a close starts again where the closed outline began. */
  private resume(): void {
    if (this.closed && this.commands[this.commands.length - 1]?.[0] !== 'M') this.commands.push(['M', this.startX * this.sx, this.startY * this.sy]);
    this.closed = false;
  }
}

// ---- Outlines: the same for custom geometry and the presets -----------------------------------------

type Guide = readonly [name: string, formula: string];

interface OutlinePath {
  w: number;
  h: number;
  fill: string | undefined;
  stroke: boolean;
  /** M, L, A, Q, C and Z, each followed by its values (numbers or the names of guides). */
  tokens: string[];
}

interface Outline {
  guides: Guide[];
  text: string[] | null;
  paths: OutlinePath[];
}

/** Draws an outline in a box of w × h; `set` are adjustments that stand in for the ones its guides begin with. */
function drawOutline(outline: Outline, w: number, h: number, set?: ReadonlyMap<string, number>): Geometry {
  const vars = builtins(w, h);
  for (const [name, formula] of outline.guides) vars.set(name, set?.get(name) ?? evalFormula(formula, vars));
  const value = (token: string | undefined): number => {
    if (token === undefined) return 0;
    const n = Number(token);
    return Number.isFinite(n) ? n : (vars.get(token) ?? 0);
  };
  let open = true;
  const paths = outline.paths.map((path): GeometryPath => {
    // A path's own coordinate space is stretched onto the box.
    const pen = new Pen(path.w > 0 ? w / path.w : 1, path.h > 0 ? h / path.h : 1);
    const { tokens } = path;
    let i = 0;
    const next = (): number => value(tokens[i++]);
    while (i < tokens.length) {
      switch (tokens[i++]) {
        case 'M':
          pen.move(next(), next());
          break;
        case 'L':
          pen.line(next(), next());
          break;
        case 'A':
          pen.arc(next(), next(), next(), next());
          break;
        case 'Q':
          pen.quad(next(), next(), next(), next());
          break;
        case 'C':
          pen.cubic(next(), next(), next(), next(), next(), next());
          break;
        case 'Z':
          pen.close();
          open = false;
          break;
      }
    }
    // A single straight line (the line and connector presets) has nothing to fill, whatever it says.
    const fill = path.fill !== 'none' && !(pen.commands.length === 2 && pen.commands[1][0] === 'L');
    if (fill) open = false;
    const shade = path.fill === 'darken' || path.fill === 'darkenLess' || path.fill === 'lighten' || path.fill === 'lightenLess' ? path.fill : undefined;
    return { commands: pen.commands, fill, stroke: path.stroke, shade };
  });
  const [l, t, r, b] = outline.text ?? [];
  return { paths, text: outline.text ? { l: value(l), t: value(t), r: value(r), b: value(b) } : { l: 0, t: 0, r: w, b: h }, open: open && paths.length > 0 };
}

// ---- Custom geometry ----------------------------------------------------------------------------

const LETTERS: Record<string, string> = { 'a:moveTo': 'M', 'a:lnTo': 'L', 'a:quadBezTo': 'Q', 'a:cubicBezTo': 'C' };
const POINTS: Record<string, number> = { M: 1, L: 1, Q: 2, C: 3 };

/** Custom geometry (`a:custGeom`) for a box of w × h. */
export function customGeometry(geom: XmlElement, w: number, h: number): Geometry {
  const guides = ['a:avLst', 'a:gdLst'].flatMap((list) => kids(kid(geom, list), 'a:gd').map((gd): Guide => [gd.attrs.name ?? '', gd.attrs.fmla ?? 'val 0']));
  const paths = kids(kid(geom, 'a:pathLst'), 'a:path').map((path): OutlinePath => {
    const tokens: string[] = [];
    for (const cmd of kids(path)) {
      if (cmd.name === 'a:close') tokens.push('Z');
      else if (cmd.name === 'a:arcTo') tokens.push('A', ...['wR', 'hR', 'stAng', 'swAng'].map((k) => cmd.attrs[k] ?? '0'));
      else {
        const letter = LETTERS[cmd.name];
        const points = kids(cmd, 'a:pt');
        if (letter && points.length >= POINTS[letter]) tokens.push(letter, ...points.slice(0, POINTS[letter]).flatMap((p) => [p.attrs.x ?? '0', p.attrs.y ?? '0']));
      }
    }
    return { w: num(path, 'w') ?? 0, h: num(path, 'h') ?? 0, fill: path.attrs.fill, stroke: path.attrs.stroke !== '0' && path.attrs.stroke !== 'false', tokens };
  });
  const rect = kid(geom, 'a:rect');
  return drawOutline({ guides, text: rect ? ['l', 't', 'r', 'b'].map((k) => rect.attrs[k] ?? '0') : null, paths }, w, h);
}

// ---- Preset shapes ------------------------------------------------------------------------------

const FILLS: Record<string, string> = { f: 'none', d: 'darkenLess', D: 'darken', l: 'lightenLess', L: 'lighten' };

/** The preset table's lines by name, and the ones read so far (its format: scripts/preset-shapes.ts). */
let presetLines: Map<string, string> | null = null;
const presetOutlines = new Map<string, Outline>();

function lines(): Map<string, string> {
  return (presetLines ??= new Map(PRESET_DATA.split('\n').map((line) => [line.slice(0, line.indexOf('\t')), line])));
}

/** Every preset shape's name. */
export function presetNames(): string[] {
  return [...lines().keys()];
}

function presetOutline(name: string): Outline | null {
  const known = presetOutlines.get(name);
  if (known) return known;
  const line = lines().get(name);
  if (!line) return null;
  const [, adjustments, formulas, text, paths] = line.split('\t');
  const guides = [adjustments, formulas].flatMap((list) =>
    list
      .split(';')
      .filter(Boolean)
      .map((gd): Guide => [gd.slice(0, gd.indexOf('=')), gd.slice(gd.indexOf('=') + 1)]),
  );
  const outline: Outline = {
    guides,
    text: text ? text.split(' ') : null,
    paths: paths.split('|').map((path): OutlinePath => {
      const [head, commands] = path.split(':');
      const [flags, w, h] = head.split(' ');
      return { w: Number(w ?? 0), h: Number(h ?? 0), fill: FILLS[flags.replace('n', '')], stroke: !flags.includes('n'), tokens: commands.split(' ') };
    }),
  };
  presetOutlines.set(name, outline);
  return outline;
}

/** The geometry of a shape's properties (`p:spPr`) for a box of w × h; a box when it has none. */
export function shapeGeometry(spPr: XmlElement | undefined, w: number, h: number): Geometry {
  const cust = kid(spPr, 'a:custGeom');
  if (cust) return customGeometry(cust, w, h);
  const prst = kid(spPr, 'a:prstGeom');
  return presetGeometry(prst?.attrs.prst ?? 'rect', prst, w, h);
}

/** A preset shape with the adjustments its `a:prstGeom` sets; a name the table doesn't have is its box. */
export function presetGeometry(name: string, prst: XmlElement | undefined, w: number, h: number): Geometry {
  const width = Math.max(w, 0);
  const height = Math.max(h, 0);
  const vars = builtins(width, height);
  const set = new Map<string, number>();
  const outline = presetOutline(name) ?? presetOutline('rect')!;
  for (const gd of kids(kid(prst, 'a:avLst'), 'a:gd')) if (gd.attrs.name && gd.attrs.fmla) set.set(gd.attrs.name, evalFormula(gd.attrs.fmla, vars));
  // A shape's only adjustment is `adj` in some files' shapes and `adj1` in others.
  if (set.size === 1) {
    const [given] = set.keys();
    const own = given === 'adj' ? 'adj1' : 'adj';
    if (!outline.guides.some(([g]) => g === given)) set.set(own, set.get(given)!);
  }
  // Only adjustments are replaced: a file can't stand in for a shape's own guides.
  for (const key of [...set.keys()]) if (!/^(adj\d*|[hv]f)$/.test(key)) set.delete(key);
  return drawOutline(outline, width, height, set);
}
