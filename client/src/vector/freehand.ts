// Free drawing: the points a pointer went through, turned into a smooth path with few points. The
// points are first thinned (Douglas-Peucker), then curves are fitted through them with Philip
// Schneider's algorithm ("An Algorithm for Automatically Fitting Digitized Curves", Graphics Gems):
// one cubic is tried for the whole stroke, and where it strays too far the stroke is split and the
// parts fitted again. Corners (a sharp turn) are kept as corners.

import type { PathCommand } from './model.ts';

export interface Pt {
  x: number;
  y: number;
}

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s });
const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
const len = (a: Pt): number => Math.hypot(a.x, a.y);
const unit = (a: Pt): Pt => {
  const l = len(a);
  return l ? mul(a, 1 / l) : { x: 0, y: 0 };
};

/** Drops points closer than `distance` to the one before (a slow pointer reports many on top of each other). */
export function dedupe(points: readonly Pt[], distance: number): Pt[] {
  const out: Pt[] = [];
  for (const p of points) if (!out.length || len(sub(p, out[out.length - 1])) >= distance) out.push(p);
  // The last point is where the stroke ended, however close it is.
  const last = points[points.length - 1];
  if (last && out.length && out[out.length - 1] !== last) out.push(last);
  return out;
}

/** Douglas-Peucker: the points that keep the line within `epsilon` of the original. */
export function simplify(points: readonly Pt[], epsilon: number): Pt[] {
  if (points.length < 3) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const d = sub(points[b], points[a]);
    const l = len(d) || 1;
    let far = -1;
    let most = epsilon;
    for (let i = a + 1; i < b; i++) {
      const dist = Math.abs((points[i].x - points[a].x) * d.y - (points[i].y - points[a].y) * d.x) / l;
      if (dist > most) {
        most = dist;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = true;
      stack.push([a, far], [far, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

type Bezier = [Pt, Pt, Pt, Pt];

const bezierAt = (b: Bezier, t: number): Pt => {
  const u = 1 - t;
  return add(add(mul(b[0], u * u * u), mul(b[1], 3 * u * u * t)), add(mul(b[2], 3 * u * t * t), mul(b[3], t * t * t)));
};
const firstDerivative = (b: Bezier, t: number): Pt => {
  const u = 1 - t;
  return add(add(mul(sub(b[1], b[0]), 3 * u * u), mul(sub(b[2], b[1]), 6 * u * t)), mul(sub(b[3], b[2]), 3 * t * t));
};
const secondDerivative = (b: Bezier, t: number): Pt => {
  const u = 1 - t;
  return add(mul(add(sub(b[2], mul(b[1], 2)), b[0]), 6 * u), mul(add(sub(b[3], mul(b[2], 2)), b[1]), 6 * t));
};

function chordLengths(points: readonly Pt[]): number[] {
  const u = [0];
  for (let i = 1; i < points.length; i++) u.push(u[i - 1] + len(sub(points[i], points[i - 1])));
  const total = u[u.length - 1] || 1;
  return u.map((v) => v / total);
}

/** The cubic with the end tangents given that best follows the points at the parameters `u` (least squares). */
function generate(points: readonly Pt[], u: readonly number[], t1: Pt, t2: Pt): Bezier {
  const first = points[0];
  const last = points[points.length - 1];
  const c = [
    [0, 0],
    [0, 0],
  ];
  const x = [0, 0];
  for (let i = 0; i < points.length; i++) {
    const t = u[i];
    const m = 1 - t;
    const b0 = m * m * m;
    const b1 = 3 * t * m * m;
    const b2 = 3 * t * t * m;
    const b3 = t * t * t;
    const a1 = mul(t1, b1);
    const a2 = mul(t2, b2);
    c[0][0] += dot(a1, a1);
    c[0][1] += dot(a1, a2);
    c[1][1] += dot(a2, a2);
    const tmp = sub(points[i], add(add(mul(first, b0 + b1), mul(last, b2 + b3)), { x: 0, y: 0 }));
    x[0] += dot(a1, tmp);
    x[1] += dot(a2, tmp);
  }
  c[1][0] = c[0][1];
  const det = c[0][0] * c[1][1] - c[1][0] * c[0][1];
  const segment = len(sub(last, first));
  let alpha1 = 0;
  let alpha2 = 0;
  if (Math.abs(det) > 1e-12) {
    alpha1 = (x[0] * c[1][1] - x[1] * c[0][1]) / det;
    alpha2 = (c[0][0] * x[1] - c[1][0] * x[0]) / det;
  }
  const epsilon = 1e-6 * segment;
  // A degenerate fit falls back to handles a third of the way along.
  if (alpha1 < epsilon || alpha2 < epsilon) alpha1 = alpha2 = segment / 3;
  return [first, add(first, mul(t1, alpha1)), add(last, mul(t2, alpha2)), last];
}

/** One Newton-Raphson step towards the nearest parameter for each point. */
function reparameterize(b: Bezier, points: readonly Pt[], u: readonly number[]): number[] {
  return points.map((p, i) => {
    const t = u[i];
    const d = sub(bezierAt(b, t), p);
    const d1 = firstDerivative(b, t);
    const d2 = secondDerivative(b, t);
    const numerator = dot(d, d1);
    const denominator = dot(d1, d1) + dot(d, d2);
    return denominator === 0 ? t : Math.max(0, Math.min(1, t - numerator / denominator));
  });
}

function maxError(points: readonly Pt[], b: Bezier, u: readonly number[]): { error: number; at: number } {
  let error = 0;
  let at = Math.floor(points.length / 2);
  for (let i = 1; i < points.length - 1; i++) {
    const e = len(sub(bezierAt(b, u[i]), points[i]));
    if (e >= error) {
      error = e;
      at = i;
    }
  }
  return { error, at };
}

function fit(points: readonly Pt[], t1: Pt, t2: Pt, error: number): Bezier[] {
  if (points.length === 2) {
    const d = len(sub(points[1], points[0])) / 3;
    return [[points[0], add(points[0], mul(t1, d)), add(points[1], mul(t2, d)), points[1]]];
  }
  let u = chordLengths(points);
  let b = generate(points, u, t1, t2);
  let { error: worst, at } = maxError(points, b, u);
  if (worst < error) return [b];
  // Close enough to be worth improving the parameters rather than splitting.
  if (worst < error * error * 16) {
    for (let i = 0; i < 4; i++) {
      u = reparameterize(b, points, u);
      b = generate(points, u, t1, t2);
      ({ error: worst, at } = maxError(points, b, u));
      if (worst < error) return [b];
    }
  }
  const center = unit(sub(points[at - 1], points[at + 1]));
  return [...fit(points.slice(0, at + 1), t1, center, error), ...fit(points.slice(at), mul(center, -1), t2, error)];
}

/** Cubic curves through the points, within `error` of them. */
export function fitCurve(points: readonly Pt[], error: number): PathCommand[] {
  if (points.length < 2) return [];
  const thinned = points.filter((p, i) => i === 0 || len(sub(p, points[i - 1])) > 1e-9);
  if (thinned.length < 2) return [];
  const t1 = unit(sub(thinned[1], thinned[0]));
  const t2 = unit(sub(thinned[thinned.length - 2], thinned[thinned.length - 1]));
  const curves = fit(thinned, t1, t2, error);
  const out: PathCommand[] = [['M', curves[0][0].x, curves[0][0].y]];
  for (const [, c1, c2, p] of curves) out.push(['C', c1.x, c1.y, c2.x, c2.y, p.x, p.y]);
  return out;
}

/**
 * The path for a stroke drawn freehand: `tolerance` is how far the path may be from what was
 * drawn, in the drawing's units. A stroke that ends where it began is closed.
 */
export function freehandPath(points: readonly Pt[], tolerance: number): PathCommand[] {
  const spaced = dedupe(points, tolerance / 2);
  if (spaced.length < 2) return [];
  const length = spaced.reduce((n, p, i) => (i ? n + len(sub(p, spaced[i - 1])) : 0), 0);
  const closes = spaced.length > 8 && len(sub(spaced[0], spaced[spaced.length - 1])) < Math.max(tolerance * 3, length * 0.06);
  const line = closes ? [...spaced.slice(0, -1), spaced[0]] : spaced;
  if (length < tolerance * 2) return [];
  // Gentle wobble is thinned out first, so that the fit follows the intention and not the hand's shake.
  const rough = simplify(line, tolerance / 2);
  if (rough.length < 2) return [];
  // Where the line turns sharply it has a corner: each stretch between corners is fitted on its own.
  const cuts = [0];
  for (let i = 1; i < rough.length - 1; i++) {
    const before = unit(sub(rough[i], rough[i - 1]));
    const after = unit(sub(rough[i + 1], rough[i]));
    if (dot(before, after) < Math.cos((50 * Math.PI) / 180)) cuts.push(line.indexOf(rough[i]));
  }
  cuts.push(line.length - 1);
  const commands: PathCommand[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const part = fitCurve(line.slice(cuts[k], cuts[k + 1] + 1), tolerance);
    commands.push(...(k ? part.slice(1) : part));
  }
  if (closes && commands.length) {
    // The last curve ends on the first point already.
    commands.push(['Z']);
  }
  return commands;
}
