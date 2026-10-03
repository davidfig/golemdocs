// Editing the points of a path: what the node tool does. A path is a list of commands (see
// pathData.ts); command `i` ends at an anchor, and a curve's two control points are the handles of
// the anchors at its ends (its first belongs to the anchor before it, its second to its own).
// Every function returns a new list.

import type { PathCommand } from './model.ts';

export interface Pt {
  x: number;
  y: number;
}

/** The anchor a command ends at; null for a close. */
export function anchorOf(c: PathCommand): Pt | null {
  switch (c[0]) {
    case 'M':
    case 'L':
      return { x: c[1], y: c[2] };
    case 'C':
      return { x: c[5], y: c[6] };
    default:
      return null;
  }
}

/** The command before `i` that has an anchor, within the subpath (the anchor a curve starts from). */
function previousAnchor(commands: readonly PathCommand[], i: number): number | null {
  const prev = i - 1;
  return prev >= 0 && commands[prev][0] !== 'Z' ? prev : null;
}

const shift = (c: PathCommand, dx: number, dy: number, parts: 'all' | 'c1' | 'c2'): PathCommand => {
  switch (c[0]) {
    case 'M':
    case 'L':
      return parts === 'all' ? [c[0], c[1] + dx, c[2] + dy] : c;
    case 'C':
      return [
        'C',
        parts === 'c2' ? c[1] : c[1] + dx,
        parts === 'c2' ? c[2] : c[2] + dy,
        parts === 'c1' ? c[3] : c[3] + dx,
        parts === 'c1' ? c[4] : c[4] + dy,
        parts === 'all' ? c[5] + dx : c[5],
        parts === 'all' ? c[6] + dy : c[6],
      ];
    default:
      return c;
  }
};

/** Moves the anchor command `i` ends at, with the handles that go with it. */
export function moveAnchor(commands: readonly PathCommand[], i: number, dx: number, dy: number): PathCommand[] {
  const out = [...commands];
  const c = out[i];
  if (!c || c[0] === 'Z') return out;
  if (c[0] === 'C') out[i] = ['C', c[1], c[2], c[3] + dx, c[4] + dy, c[5] + dx, c[6] + dy];
  else out[i] = shift(c, dx, dy, 'all');
  // The next curve's first handle belongs to this anchor.
  const next = out[i + 1];
  if (next?.[0] === 'C') out[i + 1] = shift(next, dx, dy, 'c1');
  // The first anchor of a closed subpath is also where the close comes back to.
  if (c[0] === 'M') {
    for (let k = i + 1; k < out.length && out[k][0] !== 'M'; k++) {
      const z = out[k];
      if (z[0] === 'C' && k + 1 < out.length && out[k + 1][0] === 'Z' && Math.abs(z[5] - c[1]) < 1e-9 && Math.abs(z[6] - c[2]) < 1e-9) out[k] = ['C', z[1], z[2], z[3] + dx, z[4] + dy, z[5] + dx, z[6] + dy];
      else if (z[0] === 'L' && k + 1 < out.length && out[k + 1][0] === 'Z' && Math.abs(z[1] - c[1]) < 1e-9 && Math.abs(z[2] - c[2]) < 1e-9) out[k] = ['L', z[1] + dx, z[2] + dy];
    }
  }
  return out;
}

/**
 * Moves one handle of a curve: `which` is its first or its second control point. With `smooth`, the
 * handle on the other side of the same anchor turns to stay in a straight line with it (keeping
 * its own length).
 */
export function moveHandle(commands: readonly PathCommand[], i: number, which: 'c1' | 'c2', dx: number, dy: number, smooth: boolean): PathCommand[] {
  const out = [...commands];
  const c = out[i];
  if (c?.[0] !== 'C') return out;
  out[i] = shift(c, dx, dy, which);
  if (!smooth) return out;
  // The anchor the handle belongs to, and the handle opposite it.
  const anchorIndex = which === 'c2' ? i : previousAnchor(commands, i);
  if (anchorIndex === null) return out;
  const anchor = anchorOf(commands[anchorIndex]);
  const moved = which === 'c1' ? { x: c[1] + dx, y: c[2] + dy } : { x: c[3] + dx, y: c[4] + dy };
  const opposite = which === 'c2' ? (out[i + 1]?.[0] === 'C' ? { index: i + 1, key: 'c1' as const } : null) : commands[anchorIndex][0] === 'C' ? { index: anchorIndex, key: 'c2' as const } : null;
  if (!anchor || !opposite) return out;
  const o = out[opposite.index] as readonly ['C', number, number, number, number, number, number];
  const handle = opposite.key === 'c1' ? { x: o[1], y: o[2] } : { x: o[3], y: o[4] };
  const length = Math.hypot(handle.x - anchor.x, handle.y - anchor.y);
  const direction = Math.hypot(moved.x - anchor.x, moved.y - anchor.y);
  if (!length || !direction) return out;
  const x = anchor.x - ((moved.x - anchor.x) / direction) * length;
  const y = anchor.y - ((moved.y - anchor.y) / direction) * length;
  out[opposite.index] = opposite.key === 'c1' ? ['C', x, y, o[3], o[4], o[5], o[6]] : ['C', o[1], o[2], x, y, o[5], o[6]];
  return out;
}

/** Whether the two handles at an anchor are in one straight line (so dragging one should turn the other). */
export function isSmooth(commands: readonly PathCommand[], i: number): boolean {
  const c = commands[i];
  const next = commands[i + 1];
  if (c?.[0] !== 'C' || next?.[0] !== 'C') return false;
  const ax = c[5];
  const ay = c[6];
  const ux = c[3] - ax;
  const uy = c[4] - ay;
  const vx = next[1] - ax;
  const vy = next[2] - ay;
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (!lu || !lv) return false;
  // Opposite directions: the cross product is nothing and the dot product is negative.
  return Math.abs(ux * vy - uy * vx) / (lu * lv) < 0.02 && ux * vx + uy * vy < 0;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Cuts the segment command `i` draws into two at parameter `t`, keeping its shape; the new anchor is the end of the first. */
export function splitSegment(commands: readonly PathCommand[], i: number, t: number): PathCommand[] {
  const c = commands[i];
  const from = previousAnchor(commands, i);
  const start = from === null ? null : anchorOf(commands[from]);
  if (!c || !start || (c[0] !== 'L' && c[0] !== 'C')) return [...commands];
  const out = [...commands];
  if (c[0] === 'L') {
    out.splice(i, 1, ['L', lerp(start.x, c[1], t), lerp(start.y, c[2], t)], ['L', c[1], c[2]]);
    return out;
  }
  // De Casteljau.
  const p01 = { x: lerp(start.x, c[1], t), y: lerp(start.y, c[2], t) };
  const p12 = { x: lerp(c[1], c[3], t), y: lerp(c[2], c[4], t) };
  const p23 = { x: lerp(c[3], c[5], t), y: lerp(c[4], c[6], t) };
  const a = { x: lerp(p01.x, p12.x, t), y: lerp(p01.y, p12.y, t) };
  const b = { x: lerp(p12.x, p23.x, t), y: lerp(p12.y, p23.y, t) };
  const m = { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
  out.splice(i, 1, ['C', p01.x, p01.y, a.x, a.y, m.x, m.y], ['C', b.x, b.y, p23.x, p23.y, c[5], c[6]]);
  return out;
}

/** Takes the anchor command `i` ends at out of the path, joining its neighbours (curves are kept as one curve through the old end points). */
export function removeAnchor(commands: readonly PathCommand[], i: number): PathCommand[] {
  const c = commands[i];
  if (!c || c[0] === 'Z') return [...commands];
  const out = [...commands];
  if (c[0] === 'M') {
    // The next segment's end becomes where the subpath starts.
    const next = out[i + 1];
    const point = next && next[0] !== 'Z' && next[0] !== 'M' ? anchorOf(next) : null;
    if (!point) {
      out.splice(i, 1);
      return out;
    }
    out.splice(i, 2, ['M', point.x, point.y]);
    return out;
  }
  const next = out[i + 1];
  if (next && (next[0] === 'L' || next[0] === 'C')) {
    // The segment from the previous anchor now runs to the next anchor, with the handles that were at the ends.
    if (c[0] === 'C' && next[0] === 'C') out.splice(i, 2, ['C', c[1], c[2], next[3], next[4], next[5], next[6]]);
    else out.splice(i, 2, next);
  } else out.splice(i, 1);
  return out;
}

export interface NearestSegment {
  /** The command that draws the segment. */
  index: number;
  t: number;
  distance: number;
  point: Pt;
}

/** The point on a path nearest to `p`, as the segment and parameter it is at. */
export function nearestSegment(commands: readonly PathCommand[], p: Pt): NearestSegment | null {
  let best: NearestSegment | null = null;
  let start: Pt | null = null;
  let first: Pt | null = null;
  commands.forEach((c, i) => {
    if (c[0] === 'M') {
      start = first = { x: c[1], y: c[2] };
      return;
    }
    if (c[0] === 'Z') {
      if (start && first && (start.x !== first.x || start.y !== first.y)) consider(i, start, null, first, p);
      start = first;
      return;
    }
    if (!start) return;
    const end = anchorOf(c)!;
    consider(i, start, c[0] === 'C' ? c : null, end, p);
    start = end;
  });
  function consider(index: number, a: Pt, curve: readonly ['C', number, number, number, number, number, number] | null, b: Pt, q: Pt): void {
    const steps = curve ? 32 : 1;
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps;
      const t1 = (k + 1) / steps;
      const at = (t: number): Pt =>
        curve
          ? {
              x: (1 - t) ** 3 * a.x + 3 * (1 - t) ** 2 * t * curve[1] + 3 * (1 - t) * t * t * curve[3] + t ** 3 * b.x,
              y: (1 - t) ** 3 * a.y + 3 * (1 - t) ** 2 * t * curve[2] + 3 * (1 - t) * t * t * curve[4] + t ** 3 * b.y,
            }
          : { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
      const p0 = at(t0);
      const p1 = at(t1);
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const length = dx * dx + dy * dy;
      const u = length ? Math.max(0, Math.min(1, ((q.x - p0.x) * dx + (q.y - p0.y) * dy) / length)) : 0;
      const point = { x: p0.x + dx * u, y: p0.y + dy * u };
      const distance = Math.hypot(q.x - point.x, q.y - point.y);
      if (!best || distance < best.distance) best = { index, t: lerp(t0, t1, u), distance, point };
    }
  }
  return best;
}

/** A corner point of a path being drawn, with the handles pen-dragging gave it. */
export interface PenPoint extends Pt {
  /** The handle on the side the path came from, and on the side it goes on. */
  inHandle?: Pt;
  outHandle?: Pt;
}

/** The commands for points drawn with the pen: straight lines between corners, curves where either end has a handle. */
export function penPath(points: readonly PenPoint[], closed: boolean): PathCommand[] {
  if (!points.length) return [];
  const out: PathCommand[] = [['M', points[0].x, points[0].y]];
  const segment = (a: PenPoint, b: PenPoint): PathCommand => {
    if (!a.outHandle && !b.inHandle) return ['L', b.x, b.y];
    const c1 = a.outHandle ?? a;
    const c2 = b.inHandle ?? b;
    return ['C', c1.x, c1.y, c2.x, c2.y, b.x, b.y];
  };
  for (let i = 1; i < points.length; i++) out.push(segment(points[i - 1], points[i]));
  if (closed) {
    const last = points[points.length - 1];
    const first = points[0];
    if (last.outHandle || first.inHandle) out.push(segment(last, first));
    out.push(['Z']);
  }
  return out;
}
