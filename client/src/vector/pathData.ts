// SVG path data: reading the `d` attribute into absolute lines and cubic curves (relative commands,
// shorthands, quadratics and elliptical arcs all become those), writing it back, and the geometry
// the editor needs from it: bounds, and the path under a transform.

import { apply, fmt } from './matrix.ts';
import type { Matrix, PathCommand } from './model.ts';

const COMMAND = /[MmLlHhVvCcSsQqTtAaZz]/;
/** Number of arguments each command takes. */
const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/** A cursor over path text: numbers (and arc flags, which may be written without separators). */
class Reader {
  at = 0;
  constructor(readonly text: string) {}

  skipSeparators(): void {
    while (this.at < this.text.length && /[\s,]/.test(this.text[this.at])) this.at++;
  }

  atEnd(): boolean {
    this.skipSeparators();
    return this.at >= this.text.length;
  }

  command(): string | null {
    this.skipSeparators();
    const c = this.text[this.at];
    if (c && COMMAND.test(c)) {
      this.at++;
      return c;
    }
    return null;
  }

  number(): number | null {
    this.skipSeparators();
    const m = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
    m.lastIndex = this.at;
    const found = m.exec(this.text);
    if (!found) return null;
    this.at = m.lastIndex;
    return Number(found[0]);
  }

  flag(): number | null {
    this.skipSeparators();
    const c = this.text[this.at];
    if (c !== '0' && c !== '1') return null;
    this.at++;
    return Number(c);
  }
}

/** Converts a quadratic curve to the cubic that draws the same shape. */
function quadratic(x0: number, y0: number, qx: number, qy: number, x: number, y: number): PathCommand {
  return ['C', x0 + (2 / 3) * (qx - x0), y0 + (2 / 3) * (qy - y0), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y];
}

/** An elliptical arc as cubic curves, by the endpoint parameterisation of the SVG specification (appendix F.6). */
export function arcToCubics(x1: number, y1: number, rxIn: number, ryIn: number, rotation: number, large: boolean, sweep: boolean, x2: number, y2: number): PathCommand[] {
  if (x1 === x2 && y1 === y2) return [];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (!rx || !ry) return [['L', x2, y2]];
  const phi = (rotation * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  // Radii too small to reach the end point are scaled up until they just do.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (factor * rx * y1p) / ry;
  const cyp = (-factor * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;
  // At most a quarter turn per curve.
  const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / count;
  const t = (4 / 3) * Math.tan(step / 4);
  const out: PathCommand[] = [];
  const point = (a: number): [number, number] => [cx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin, cy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos];
  const tangent = (a: number): [number, number] => [-rx * Math.sin(a) * cos - ry * Math.cos(a) * sin, -rx * Math.sin(a) * sin + ry * Math.cos(a) * cos];
  for (let i = 0; i < count; i++) {
    const a0 = theta + i * step;
    const a1 = a0 + step;
    const [p0x, p0y] = point(a0);
    const [d0x, d0y] = tangent(a0);
    const [p1x, p1y] = i === count - 1 ? [x2, y2] : point(a1);
    const [d1x, d1y] = tangent(a1);
    out.push(['C', p0x + t * d0x, p0y + t * d0y, p1x - t * d1x, p1y - t * d1y, p1x, p1y]);
  }
  return out;
}

/** Reads a `d` attribute. Reading stops at the first error, keeping what came before it, as SVG says to. */
export function parsePath(d: string): PathCommand[] {
  const out: PathCommand[] = [];
  const r = new Reader(d);
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  // The control point the next smooth curve reflects, and what kind of curve left it.
  let lastC: [number, number] | null = null;
  let lastQ: [number, number] | null = null;
  let cmd: string | null = null;
  let first = true;
  while (!r.atEnd()) {
    const next = r.command();
    if (next) {
      cmd = next;
      // A path starts with a moveto.
      if (first && cmd !== 'M' && cmd !== 'm') break;
    } else if (!cmd || cmd === 'z' || cmd === 'Z') break;
    first = false;
    const lower: string = cmd!.toLowerCase();
    const relative: boolean = cmd === lower;
    if (lower === 'z') {
      out.push(['Z']);
      cx = startX;
      cy = startY;
      lastC = lastQ = null;
      continue;
    }
    const args: number[] = [];
    let bad = false;
    for (let i = 0; i < ARITY[lower]; i++) {
      // The two flags of an arc are single digits.
      const v = lower === 'a' && (i === 3 || i === 4) ? r.flag() : r.number();
      if (v === null) {
        bad = true;
        break;
      }
      args.push(v);
    }
    if (bad) break;
    const ox = relative ? cx : 0;
    const oy = relative ? cy : 0;
    switch (lower) {
      case 'm':
        cx = args[0] + ox;
        cy = args[1] + oy;
        startX = cx;
        startY = cy;
        out.push(['M', cx, cy]);
        // Further pairs after a moveto are linetos.
        cmd = relative ? 'l' : 'L';
        lastC = lastQ = null;
        break;
      case 'l':
        cx = args[0] + ox;
        cy = args[1] + oy;
        out.push(['L', cx, cy]);
        lastC = lastQ = null;
        break;
      case 'h':
        cx = args[0] + ox;
        out.push(['L', cx, cy]);
        lastC = lastQ = null;
        break;
      case 'v':
        cy = args[0] + oy;
        out.push(['L', cx, cy]);
        lastC = lastQ = null;
        break;
      case 'c': {
        const c: PathCommand = ['C', args[0] + ox, args[1] + oy, args[2] + ox, args[3] + oy, args[4] + ox, args[5] + oy];
        out.push(c);
        lastC = [c[3], c[4]];
        lastQ = null;
        cx = c[5];
        cy = c[6];
        break;
      }
      case 's': {
        const reflected: [number, number] = lastC ? [2 * cx - lastC[0], 2 * cy - lastC[1]] : [cx, cy];
        const c: PathCommand = ['C', reflected[0], reflected[1], args[0] + ox, args[1] + oy, args[2] + ox, args[3] + oy];
        out.push(c);
        lastC = [c[3], c[4]];
        lastQ = null;
        cx = c[5];
        cy = c[6];
        break;
      }
      case 'q': {
        const qx = args[0] + ox;
        const qy = args[1] + oy;
        const c = quadratic(cx, cy, qx, qy, args[2] + ox, args[3] + oy);
        out.push(c);
        lastQ = [qx, qy];
        lastC = null;
        cx = args[2] + ox;
        cy = args[3] + oy;
        break;
      }
      case 't': {
        const reflectedQ: [number, number] = lastQ ? [2 * cx - lastQ[0], 2 * cy - lastQ[1]] : [cx, cy];
        const c = quadratic(cx, cy, reflectedQ[0], reflectedQ[1], args[0] + ox, args[1] + oy);
        out.push(c);
        lastQ = reflectedQ;
        lastC = null;
        cx = args[0] + ox;
        cy = args[1] + oy;
        break;
      }
      case 'a': {
        const x = args[5] + ox;
        const y = args[6] + oy;
        out.push(...arcToCubics(cx, cy, args[0], args[1], args[2], args[3] !== 0, args[4] !== 0, x, y));
        cx = x;
        cy = y;
        lastC = lastQ = null;
        break;
      }
    }
  }
  return out;
}

/** The `d` attribute for commands. */
export function serializePath(commands: readonly PathCommand[]): string {
  return commands.map((c) => (c.length === 1 ? 'Z' : `${c[0]}${c.slice(1).map((v) => fmt(v as number)).join(' ')}`)).join('');
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The extremes of one cubic coordinate between its end points (where the derivative is zero), as parameters in (0, 1). */
function extrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      roots.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}

const cubicAt = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

/** The box a path fills, in its own coordinates, optionally after a transform. Null for an empty path. */
export function pathBounds(commands: readonly PathCommand[], matrix?: Matrix): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number): void => {
    const [tx, ty] = matrix ? apply(matrix, x, y) : [x, y];
    minX = Math.min(minX, tx);
    maxX = Math.max(maxX, tx);
    minY = Math.min(minY, ty);
    maxY = Math.max(maxY, ty);
  };
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  for (const c of commands) {
    switch (c[0]) {
      case 'M':
        sx = cx = c[1];
        sy = cy = c[2];
        add(cx, cy);
        break;
      case 'L':
        cx = c[1];
        cy = c[2];
        add(cx, cy);
        break;
      case 'C': {
        add(c[5], c[6]);
        // With a transform the extremes are found in the transformed curve.
        const pts = matrix ? [apply(matrix, cx, cy), apply(matrix, c[1], c[2]), apply(matrix, c[3], c[4]), apply(matrix, c[5], c[6])] : [[cx, cy], [c[1], c[2]], [c[3], c[4]], [c[5], c[6]]];
        for (const axis of [0, 1]) {
          for (const t of extrema(pts[0][axis], pts[1][axis], pts[2][axis], pts[3][axis])) {
            const x = cubicAt(pts[0][0], pts[1][0], pts[2][0], pts[3][0], t);
            const y = cubicAt(pts[0][1], pts[1][1], pts[2][1], pts[3][1], t);
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
        cx = c[5];
        cy = c[6];
        break;
      }
      case 'Z':
        cx = sx;
        cy = sy;
        break;
    }
  }
  return minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The path with every point moved through `matrix`. */
export function transformPath(commands: readonly PathCommand[], matrix: Matrix): PathCommand[] {
  return commands.map((c): PathCommand => {
    switch (c[0]) {
      case 'M':
      case 'L': {
        const [x, y] = apply(matrix, c[1], c[2]);
        return [c[0], x, y];
      }
      case 'C': {
        const [x1, y1] = apply(matrix, c[1], c[2]);
        const [x2, y2] = apply(matrix, c[3], c[4]);
        const [x, y] = apply(matrix, c[5], c[6]);
        return ['C', x1, y1, x2, y2, x, y];
      }
      default:
        return ['Z'];
    }
  });
}

const KAPPA = 0.5522847498307936;

/** An ellipse as four curves. */
export function ellipsePath(cx: number, cy: number, rx: number, ry: number): PathCommand[] {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    ['M', cx + rx, cy],
    ['C', cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
    ['C', cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
    ['C', cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
    ['C', cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
    ['Z'],
  ];
}

/** A rectangle, with rounded corners when `rx` or `ry` is set (they are limited to half the sides). */
export function rectPath(x: number, y: number, width: number, height: number, rxIn = 0, ryIn = rxIn): PathCommand[] {
  const rx = Math.min(Math.abs(rxIn), width / 2);
  const ry = Math.min(Math.abs(ryIn), height / 2);
  if (!rx || !ry) return [['M', x, y], ['L', x + width, y], ['L', x + width, y + height], ['L', x, y + height], ['Z']];
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  const r = x + width;
  const b = y + height;
  return [
    ['M', x + rx, y],
    ['L', r - rx, y],
    ['C', r - rx + kx, y, r, y + ry - ky, r, y + ry],
    ['L', r, b - ry],
    ['C', r, b - ry + ky, r - rx + kx, b, r - rx, b],
    ['L', x + rx, b],
    ['C', x + rx - kx, b, x, b - ry + ky, x, b - ry],
    ['L', x, y + ry],
    ['C', x, y + ry - ky, x + rx - kx, y, x + rx, y],
    ['Z'],
  ];
}
