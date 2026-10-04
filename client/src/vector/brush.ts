// Strokes beyond a plain line: a stroke whose width changes along the path (tapered ends, a swell, a
// pen's pressure), a calligraphic nib, a rough dry brush, a pattern repeated along the path, shapes
// scattered along it, and arrowheads. A brush turns a path (its centerline) into the outline of the
// stroke, a filled path, so it looks the same in any SVG viewer. The path keeps what it was made
// from (the centerline and the brush, as attributes), so the brush can be changed or the line
// reshaped later: see `applyBrush` and `regenerate`.

import { flatten } from './hit.ts';
import { fmt } from './matrix.ts';
import type { PathCommand, PathNode } from './model.ts';
import { parsePath, serializePath } from './pathData.ts';
import { parseColor, parseLength } from './style.ts';

export type Arrow = 'none' | 'triangle' | 'open' | 'circle' | 'diamond' | 'bar';

export type BrushKind = 'plain' | 'profile' | 'calligraphic' | 'rough' | 'bristle' | 'pattern' | 'scatter';

export interface Brush {
  /** Which of the stroke list's strokes it came from, for the list to show. */
  preset?: string;
  kind: BrushKind;
  /** The stroke's full width where nothing makes it narrower, in the drawing's units. */
  width: number;
  /** `profile`, `rough` and `bristle`: how wide the stroke is along the path, as points of (position 0 to 1, fraction of the width). */
  profile?: [number, number][];
  /** `calligraphic`: the nib's angle in degrees, and how round it is (0 is a flat nib, 1 a round pen). */
  angle?: number;
  roundness?: number;
  /** `bristle`: how many streaks make the stroke (about one per unit of width if left out), and how many flecks are left past its end (0 to 1). */
  strands?: number;
  speckle?: number;
  /** `rough`, `bristle`, `scatter`: how ragged or random (0 to 1), and the seed that makes the same line come out the same every time. */
  roughness?: number;
  seed?: number;
  /** `pattern`, `scatter`: the shape, in a box from x 0 to 1 along the path and y -0.5 to 0.5 across it. */
  motif?: PathCommand[];
  /** `pattern`: the gap between copies as a fraction of a copy's length. `scatter`: the distance between them, in widths. */
  spacing?: number;
  /** `scatter`: how far copies stray from the path (in widths), vary in size, and turn (in degrees). */
  jitter?: { position?: number; size?: number; rotation?: number };
  /** Ends of lines that have no taper of their own: round (default) or flat. */
  cap?: 'round' | 'butt';
  startArrow?: Arrow;
  endArrow?: Arrow;
  /** The arrowheads' length, in widths. */
  arrowSize?: number;
}

export const BRUSH_ATTR = 'data-golem-brush';
export const CENTERLINE_ATTR = 'data-golem-centerline';

/** A seeded random number generator (mulberry32): the same seed always gives the same numbers. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// Walking along a path

interface Sample {
  x: number;
  y: number;
  /** The unit direction of travel, and the unit normal to the left of it (y down: to the left of the way it goes). */
  tx: number;
  ty: number;
  nx: number;
  ny: number;
  /** Distance along the path. */
  s: number;
}

interface Walk {
  samples: Sample[];
  length: number;
  closed: boolean;
}

/** Points along each subpath of a path, evenly spaced by `step` along its length. */
function walk(commands: readonly PathCommand[], step: number): Walk[] {
  const out: Walk[] = [];
  for (const line of flatten(commands, 24)) {
    const pts = line.points.filter((p, i, all) => i === 0 || Math.hypot(p.x - all[i - 1].x, p.y - all[i - 1].y) > 1e-9);
    if (line.closed && pts.length > 2) pts.push(pts[0]);
    if (pts.length < 2) continue;
    const cumulative = [0];
    for (let i = 1; i < pts.length; i++) cumulative.push(cumulative[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const length = cumulative[cumulative.length - 1];
    const count = Math.max(2, Math.ceil(length / step) + 1);
    const samples: Sample[] = [];
    let seg = 0;
    for (let k = 0; k < count; k++) {
      const s = (length * k) / (count - 1);
      while (seg < pts.length - 2 && cumulative[seg + 1] < s) seg++;
      const span = cumulative[seg + 1] - cumulative[seg] || 1;
      const u = Math.max(0, Math.min(1, (s - cumulative[seg]) / span));
      const a = pts[seg];
      const b = pts[seg + 1];
      samples.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, tx: 0, ty: 0, nx: 0, ny: 0, s });
    }
    // Directions from the neighbours, so that corners are rounded off a little rather than jumping.
    for (let i = 0; i < samples.length; i++) {
      const p = samples[Math.max(0, i - 1)];
      const q = samples[Math.min(samples.length - 1, i + 1)];
      const d = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      samples[i].tx = (q.x - p.x) / d;
      samples[i].ty = (q.y - p.y) / d;
      samples[i].nx = -samples[i].ty;
      samples[i].ny = samples[i].tx;
    }
    out.push({ samples, length, closed: line.closed && pts.length > 2 });
  }
  return out;
}

/** The sample nearest a distance along a walk (they are evenly spaced). */
function at(w: Walk, s: number): Sample {
  const { samples, length } = w;
  const i = Math.max(0, Math.min(samples.length - 1, Math.round((s / (length || 1)) * (samples.length - 1))));
  return samples[i];
}

/** The path with its last `distance` cut off (and the start, with `fromStart`). */
function trim(w: Walk, fromStart: number, fromEnd: number): Walk {
  const keep = w.samples.filter((p) => p.s >= fromStart && p.s <= w.length - fromEnd);
  return keep.length >= 2 ? { ...w, samples: keep, length: w.length } : w;
}

// ---------------------------------------------------------------------------------------------
// Outlines

type Pt = [number, number];

/** A smooth curve through points, as cubic segments (Catmull-Rom). The first point is where the pen already is. */
function curveThrough(points: readonly Pt[]): PathCommand[] {
  const out: PathCommand[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    out.push(['C', p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]]);
  }
  return out;
}

/** About this many points per side of a stroke: more would make a heavy file for no visible gain. */
const MAX_SIDE_POINTS = 90;

function decimate(points: Pt[], max = MAX_SIDE_POINTS): Pt[] {
  if (points.length <= max) return points;
  const out: Pt[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]);
  return out;
}

/** A half circle's worth of points around `center`, from the left side to the right (or back), bulging along `dir`. */
function capPoints(cx: number, cy: number, dx: number, dy: number, nx: number, ny: number, radius: number, from: 1 | -1): Pt[] {
  const out: Pt[] = [];
  const steps = 8;
  for (let i = 1; i < steps; i++) {
    const a = (Math.PI * i) / steps;
    // From the side `from` of the normal, around the front.
    out.push([cx + from * nx * radius * Math.cos(a) + dx * radius * Math.sin(a), cy + from * ny * radius * Math.cos(a) + dy * radius * Math.sin(a)]);
  }
  return out;
}

/** The outline of a stroke whose width at each sample is `widths[i]`, as a filled path. */
function strokeOutline(w: Walk, widths: readonly number[], cap: 'round' | 'butt', jitter?: () => number, amount = 0, maxPoints = MAX_SIDE_POINTS): PathCommand[] {
  const { samples } = w;
  const left: Pt[] = [];
  const right: Pt[] = [];
  samples.forEach((p, i) => {
    const half = Math.max(0, widths[i]) / 2;
    const jl = jitter ? jitter() * amount : 0;
    const jr = jitter ? jitter() * amount : 0;
    left.push([p.x + p.nx * (half + jl), p.y + p.ny * (half + jl)]);
    right.push([p.x - p.nx * (half + jr), p.y - p.ny * (half + jr)]);
  });
  const out: PathCommand[] = [];
  const trace = (points: Pt[]): void => {
    out.push(['M', points[0][0], points[0][1]], ...curveThrough(points), ['Z']);
  };
  if (w.closed) {
    // A ring: the outer edge and the inner edge, going opposite ways, so the middle is left empty.
    trace(decimate(left));
    trace(decimate([...right].reverse()));
    return out;
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const startCap = cap === 'round' ? capPoints(first.x, first.y, -first.tx, -first.ty, first.nx, first.ny, widths[0] / 2, -1) : [];
  const endCap = cap === 'round' ? capPoints(last.x, last.y, last.tx, last.ty, last.nx, last.ny, widths[widths.length - 1] / 2, 1) : [];
  const l = decimate(left, maxPoints);
  const r = decimate([...right].reverse(), maxPoints);
  out.push(['M', l[0][0], l[0][1]], ...curveThrough(l));
  for (const [x, y] of endCap) out.push(['L', x, y]);
  out.push(['L', r[0][0], r[0][1]], ...curveThrough(r));
  for (const [x, y] of startCap) out.push(['L', x, y]);
  out.push(['Z']);
  return out;
}

/** The width at a position along the path (0 to 1) for a profile: straight between its points, eased. */
export function profileAt(profile: readonly [number, number][], t: number): number {
  if (!profile.length) return 1;
  if (t <= profile[0][0]) return profile[0][1];
  for (let i = 1; i < profile.length; i++) {
    if (t <= profile[i][0]) {
      const [t0, f0] = profile[i - 1];
      const [t1, f1] = profile[i];
      const u = (t - t0) / (t1 - t0 || 1);
      const eased = u * u * (3 - 2 * u);
      return f0 + (f1 - f0) * eased;
    }
  }
  return profile[profile.length - 1][1];
}

/**
 * A width profile from how hard a pen was pressed at each point of a freehand stroke (0 to 1, as a
 * pointer event's `pressure`): positions by distance along the stroke, smoothed a little and cut down
 * to at most `max` points. Null when there is nothing to go on (one point, or no length).
 */
export function pressureProfile(points: readonly { x: number; y: number }[], pressures: readonly number[], max = 48): [number, number][] | null {
  const n = Math.min(points.length, pressures.length);
  if (n < 2) return null;
  const along = [0];
  for (let i = 1; i < n; i++) along.push(along[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  const length = along[n - 1];
  if (length <= 0) return null;
  // A pen's reading jitters from one event to the next: averaged with its neighbours.
  const smooth = Array.from({ length: n }, (_, i) => (pressures[Math.max(0, i - 1)] + pressures[i] * 2 + pressures[Math.min(n - 1, i + 1)]) / 4);
  const count = Math.min(max, n);
  const out: [number, number][] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const s = (length * k) / (count - 1);
    while (seg < n - 2 && along[seg + 1] < s) seg++;
    const u = Math.max(0, Math.min(1, (s - along[seg]) / (along[seg + 1] - along[seg] || 1)));
    const p = smooth[seg] + (smooth[seg + 1] - smooth[seg]) * u;
    // Never quite nothing, so a light touch still leaves a line.
    out.push([Math.round((s / length) * 1000) / 1000, Math.round(Math.max(0.05, Math.min(1, p)) * 1000) / 1000]);
  }
  return out;
}

/** Whether a stroke's pen pressures change enough to show: a pen whose pressure is turned off reports the same every time. */
export function pressureVaries(pressures: readonly number[] | undefined): boolean {
  if (!pressures?.length) return false;
  return Math.max(...pressures) - Math.min(...pressures) > 0.05;
}

/** Smooth random numbers along a path: value noise with a point every `cell` units. */
function noise(seed: number, cell: number): (s: number) => number {
  const values = new Map<number, number>();
  const at = (i: number): number => {
    let v = values.get(i);
    if (v === undefined) {
      v = random(seed * 7919 + i * 104729)();
      values.set(i, v);
    }
    return v;
  };
  return (s) => {
    const x = s / cell;
    const i = Math.floor(x);
    const u = x - i;
    const e = u * u * (3 - 2 * u);
    return at(i) * (1 - e) + at(i + 1) * e;
  };
}

// ---------------------------------------------------------------------------------------------
// Shapes made along the path: arrowheads, patterns, scatter

/** An arrowhead with its tip at (x, y), pointing along (dx, dy), `size` long. */
function arrowhead(kind: Arrow, x: number, y: number, dx: number, dy: number, size: number, width: number): PathCommand[] {
  const nx = -dy;
  const ny = dx;
  const p = (along: number, across: number): Pt => [x + dx * along + nx * across, y + dy * along + ny * across];
  const poly = (points: Pt[]): PathCommand[] => [['M', points[0][0], points[0][1]], ...points.slice(1).map((q): PathCommand => ['L', q[0], q[1]]), ['Z']];
  const half = size * 0.45;
  switch (kind) {
    case 'triangle':
      return poly([p(0, 0), p(-size, half), p(-size, -half)]);
    case 'open': {
      // A chevron, as a thin outline.
      const t = Math.max(width * 0.9, size * 0.12);
      return poly([p(0, 0), p(-size, half), p(-size - t * 0.2, half - t * 1.1), p(-t * 1.7, 0), p(-size - t * 0.2, -half + t * 1.1), p(-size, -half)]);
    }
    case 'diamond':
      return poly([p(0, 0), p(-size / 2, half), p(-size, 0), p(-size / 2, -half)]);
    case 'bar': {
      const t = Math.max(width, size * 0.2);
      return poly([p(0, half), p(-t, half), p(-t, -half), p(0, -half)]);
    }
    case 'circle': {
      const r = size / 2;
      const points: Pt[] = [];
      for (let i = 0; i < 16; i++) {
        const a = (Math.PI * 2 * i) / 16;
        points.push(p(-r + Math.cos(a) * r, Math.sin(a) * r));
      }
      return poly(points);
    }
    default:
      return [];
  }
}

/** How far into the stroke an arrowhead reaches: the line stops there, so it doesn't poke through. */
const arrowReach = (kind: Arrow | undefined, size: number): number => (!kind || kind === 'none' ? 0 : kind === 'bar' ? 0 : kind === 'circle' ? size : size * 0.85);

/** Copies of a motif bent along the path. */
function patternAlong(w: Walk, motif: readonly PathCommand[], width: number, gap: number): PathCommand[] {
  const lines = flatten(motif, 10);
  const out: PathCommand[] = [];
  const natural = width * 2;
  const count = Math.max(1, Math.round(w.length / (natural * (1 + gap))));
  const pitch = w.length / count;
  const length = pitch / (1 + gap);
  for (let k = 0; k < count; k++) {
    const s0 = k * pitch + (pitch - length) / 2;
    for (const line of lines) {
      line.points.forEach((pt, i) => {
        const s = Math.max(0, Math.min(w.length, s0 + pt.x * length));
        const p = at(w, s);
        out.push([i === 0 ? 'M' : 'L', p.x + p.nx * pt.y * width, p.y + p.ny * pt.y * width]);
      });
      if (line.closed) out.push(['Z']);
    }
  }
  return out;
}

/** Copies of a motif strewn along the path, each a little different. */
function scatterAlong(w: Walk, brush: Brush, motif: readonly PathCommand[]): PathCommand[] {
  const rand = random(brush.seed ?? 1);
  const lines = flatten(motif, 10);
  const out: PathCommand[] = [];
  const spacing = Math.max(0.2, brush.spacing ?? 1.2) * brush.width;
  const jitter = brush.jitter ?? {};
  for (let s = spacing / 2; s < w.length; s += spacing) {
    const p = at(w, s);
    const stray = (rand() * 2 - 1) * (jitter.position ?? 0.6) * brush.width;
    const size = brush.width * (1 + (rand() * 2 - 1) * (jitter.size ?? 0.3));
    const turn = Math.atan2(p.ty, p.tx) + ((rand() * 2 - 1) * (jitter.rotation ?? 180) * Math.PI) / 180;
    const cx = p.x + p.nx * stray;
    const cy = p.y + p.ny * stray;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    for (const line of lines) {
      line.points.forEach((pt, i) => {
        const u = (pt.x - 0.5) * size;
        const v = pt.y * size;
        out.push([i === 0 ? 'M' : 'L', cx + u * cos - v * sin, cy + u * sin + v * cos]);
      });
      if (line.closed) out.push(['Z']);
    }
  }
  return out;
}

/** A dry brush or a stick of charcoal: many thin streaks side by side that stop short of one another, break, and fray at the ends. */
function bristleAlong(w: Walk, brush: Brush): PathCommand[] {
  const rand = random(brush.seed ?? 1);
  const width = brush.width;
  const count = Math.max(3, Math.min(16, Math.round(brush.strands ?? width)));
  const rough = Math.max(0, Math.min(1, brush.roughness ?? 0.5));
  const profile = brush.profile ?? [[0, 1], [1, 1]];
  const strand = (width / count) * 1.6;
  const out: PathCommand[] = [];
  for (let k = 0; k < count; k++) {
    const lane = k / (count - 1) - 0.5;
    const across = lane + ((rand() - 0.5) * 0.5) / count;
    const outer = 0.4 + Math.abs(lane) * 1.2;
    const start = rand() * rough * 0.1 * outer;
    const end = 1 - rand() * rough * 0.4 * outer;
    const runs: [number, number][] = [[start, end]];
    if (rand() < rough * 0.6 && end - start > 0.3) {
      const gap = start + (end - start) * (0.2 + rand() * 0.6);
      const half = 0.02 + rand() * 0.05;
      runs.splice(0, 1, [start, gap - half], [gap + half, end]);
    }
    for (const [a, b] of runs) {
      const part = w.samples.filter((p) => p.s >= a * w.length && p.s <= b * w.length);
      if (part.length < 2) continue;
      const reach = (b - a) * w.length * 0.25 || 1;
      const widths: number[] = [];
      const moved = part.map((p): Sample => {
        const f = profileAt(profile, p.s / w.length);
        const ease = Math.min(1, (p.s - a * w.length) / reach, (b * w.length - p.s) / reach);
        widths.push(strand * f * Math.max(0, ease));
        const offset = across * width * f;
        return { ...p, x: p.x + p.nx * offset, y: p.y + p.ny * offset };
      });
      out.push(...strokeOutline({ samples: moved, length: w.length, closed: false }, widths, 'butt', rand, strand * 0.12 * rough, 16));
    }
  }
  // Flecks the brush shed beyond the end of the stroke.
  const last = w.samples[w.samples.length - 1];
  for (let k = 0, flecks = Math.round((brush.speckle ?? 0) * 8); k < flecks; k++) {
    const along = last.s - w.length * 0.12 * rand() + w.length * 0.08 * rand() * rand();
    const p = at(w, Math.min(along, w.length));
    const beyond = Math.max(0, along - w.length);
    const cx = p.x + p.tx * beyond + p.nx * (rand() - 0.5) * width * 0.5;
    const cy = p.y + p.ty * beyond + p.ny * (rand() - 0.5) * width * 0.5;
    const r = width * (0.03 + rand() * 0.06);
    for (let i = 0; i < 7; i++) {
      const a = (Math.PI * 2 * i) / 7;
      const rr = r * (0.7 + rand() * 0.6);
      out.push([i === 0 ? 'M' : 'L', cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    out.push(['Z']);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The brush

/** The outline of `centerline` stroked with `brush`. */
export function brushOutline(centerline: readonly PathCommand[], brush: Brush): PathCommand[] {
  const width = Math.max(brush.width, 0.01);
  const step = Math.max(Math.min(width / 4, 4), 0.35);
  const out: PathCommand[] = [];
  const rough = brush.kind === 'rough' ? random(brush.seed ?? 1) : null;
  for (const whole of walk(centerline, step)) {
    let w = whole;
    const size = (brush.arrowSize ?? 3) * width;
    const arrowAtStart = !w.closed && brush.startArrow && brush.startArrow !== 'none';
    const arrowAtEnd = !w.closed && brush.endArrow && brush.endArrow !== 'none';
    const reachStart = arrowAtStart ? arrowReach(brush.startArrow, size) : 0;
    const reachEnd = arrowAtEnd ? arrowReach(brush.endArrow, size) : 0;
    if (reachStart || reachEnd) w = trim(w, reachStart, reachEnd);
    if (brush.kind === 'pattern' || brush.kind === 'scatter') {
      const motif = brush.motif ?? [];
      if (motif.length) out.push(...(brush.kind === 'pattern' ? patternAlong(w, motif, width, brush.spacing ?? 0.2) : scatterAlong(w, brush, motif)));
    } else if (brush.kind === 'bristle') {
      if (w.samples.length >= 2) out.push(...bristleAlong(w, brush));
    } else {
      const n = w.samples.length;
      const widths: number[] = [];
      let cap: 'round' | 'butt' = brush.cap ?? 'round';
      for (let i = 0; i < n; i++) {
        const t = w.samples[i].s / (whole.length || 1);
        let f = 1;
        if (brush.kind === 'profile' || brush.kind === 'rough') f = profileAt(brush.profile ?? [], t);
        else if (brush.kind === 'calligraphic') {
          // A flat nib: as wide as it is across the direction it travels.
          const phi = Math.atan2(w.samples[i].ty, w.samples[i].tx) - ((brush.angle ?? 45) * Math.PI) / 180;
          const round = Math.max(0, Math.min(1, brush.roundness ?? 0.1));
          f = Math.sqrt(Math.sin(phi) ** 2 + (round * Math.cos(phi)) ** 2);
          cap = 'butt';
        }
        widths.push(width * f);
      }
      if (brush.kind === 'rough') {
        const grain = noise(brush.seed ?? 1, width * 1.5);
        const amount = Math.max(0, Math.min(1, brush.roughness ?? 0.5));
        for (let i = 0; i < n; i++) widths[i] *= 1 + (grain(w.samples[i].s) * 2 - 1) * amount * 0.7;
      }
      if (n >= 2) out.push(...strokeOutline(w, widths, cap, rough ?? undefined, rough ? (brush.roughness ?? 0.5) * width * 0.12 : 0));
    }
    if (arrowAtStart) {
      const p = whole.samples[0];
      out.push(...arrowhead(brush.startArrow!, p.x, p.y, -p.tx, -p.ty, size, width));
    }
    if (arrowAtEnd) {
      const p = whole.samples[whole.samples.length - 1];
      out.push(...arrowhead(brush.endArrow!, p.x, p.y, p.tx, p.ty, size, width));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Brushes on path nodes

/** The brush a path was made with, or null for an ordinary path. */
export function brushOf(node: { attrs: Record<string, string> }): Brush | null {
  const text = node.attrs[BRUSH_ATTR];
  if (!text) return null;
  try {
    const brush = JSON.parse(text) as Brush;
    return typeof brush.width === 'number' && typeof brush.kind === 'string' ? brush : null;
  } catch {
    return null;
  }
}

/** The commands to edit when the points of a path are edited: a brush path's own line, not its outline. */
export function editableCommands(node: PathNode): PathCommand[] {
  const line = node.attrs[CENTERLINE_ATTR];
  return brushOf(node) && line ? parsePath(line) : node.commands;
}

/** Sets the commands that were being edited (see `editableCommands`), drawing the brush again where there is one. */
export function setEditableCommands(node: PathNode, commands: PathCommand[]): void {
  const brush = brushOf(node);
  delete node.source;
  if (!brush) {
    node.commands = commands;
    return;
  }
  node.attrs[CENTERLINE_ATTR] = serializePath(commands);
  node.commands = brushOutline(commands, brush);
}

/** Draws a brush path's outline again from its line and its brush (after either changed). */
export function regenerate(node: PathNode): void {
  const brush = brushOf(node);
  const line = node.attrs[CENTERLINE_ATTR];
  if (!brush || !line) return;
  delete node.source;
  node.commands = brushOutline(parsePath(line), brush);
}

/** The colour a stroked path shows: its stroke, else its fill, else black. */
function colorOfNode(node: PathNode): string {
  const stroke = node.style.stroke;
  if (stroke && stroke !== 'none' && parseColor(stroke)) return stroke;
  const fill = node.style.fill;
  return fill && fill !== 'none' ? fill : '#000000';
}

/**
 * Gives a path a brush (null takes it away). The path becomes the brush's outline, filled with the
 * colour the stroke had; taking the brush away makes it a plain stroked line again, as before.
 */
export function applyBrush(node: PathNode, brush: Brush | null): void {
  const existing = brushOf(node);
  const line = existing ? editableCommands(node) : node.commands;
  const color = existing ? (node.style.fill ?? '#000000') : colorOfNode(node);
  delete node.source;
  if (!brush) {
    if (!existing) return;
    node.commands = line;
    delete node.attrs[BRUSH_ATTR];
    delete node.attrs[CENTERLINE_ATTR];
    node.style.fill = 'none';
    node.style.stroke = color;
    node.style['stroke-width'] = fmt(existing.width);
    delete node.style['stroke-dasharray'];
    return;
  }
  node.attrs[CENTERLINE_ATTR] = serializePath(line);
  node.attrs[BRUSH_ATTR] = JSON.stringify(brush);
  node.commands = brushOutline(line, brush);
  node.style.fill = color;
  node.style.stroke = 'none';
  delete node.style['stroke-width'];
  delete node.style['stroke-dasharray'];
  delete node.style['stroke-linecap'];
  delete node.style['stroke-linejoin'];
}

/** The width a stroked path has now: its brush's, or its stroke width. */
export function strokeWidthOf(node: PathNode): number {
  return brushOf(node)?.width ?? parseLength(node.style['stroke-width']) ?? 1;
}
