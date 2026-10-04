// The nudge tool: a round brush that pushes the lines of a drawing along as it is dragged. Points
// under the brush move with it, the most at its middle and none at its edge, so a line bends
// around the push instead of being moved whole. A segment near the brush is first cut into short
// pieces, so that a long line, which has few points, has enough of them to bend.

import { outline } from './geometry.ts';
import { editableCommands, setEditableCommands } from './brush.ts';
import { apply, invert, meanScale, multiply } from './matrix.ts';
import type { Matrix, PathCommand, PathNode, Scene, SceneNode } from './model.ts';
import { IDENTITY } from './model.ts';
import { isHidden, isLocked } from './edit.ts';
import type { NodePath } from './edit.ts';

interface Pt {
  x: number;
  y: number;
}

/** The longest a piece of a segment under the brush may be, as a part of the brush's radius. */
const PIECE = 0.3;
/** The most pieces one segment is cut into at once. */
const MAX_PIECES = 48;

/** How much of the push reaches a point `distance` from the brush's middle, of a brush `radius` wide: 1 at the middle, easing to 0 at the edge. */
export function falloff(distance: number, radius: number): number {
  if (radius <= 0 || distance >= radius) return 0;
  const u = 1 - (distance / radius) ** 2;
  return u * u;
}

const mid = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** A cubic cut at `t` into two (de Casteljau). */
function splitCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): [PathCommand, PathCommand] {
  const a = mid(p0, p1, t);
  const b = mid(p1, p2, t);
  const c = mid(p2, p3, t);
  const d = mid(a, b, t);
  const e = mid(b, c, t);
  const f = mid(d, e, t);
  return [['C', a.x, a.y, d.x, d.y, f.x, f.y], ['C', e.x, e.y, c.x, c.y, p3.x, p3.y]];
}

/** Whether the box of the points comes within `radius` of the middle of the brush. */
function near(points: readonly Pt[], center: Pt, radius: number): boolean {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const dx = Math.max(x0 - center.x, 0, center.x - x1);
  const dy = Math.max(y0 - center.y, 0, center.y - y1);
  return Math.hypot(dx, dy) < radius;
}

/** Cuts the segments that come near the brush into short pieces, drawing the same line. */
export function subdivideNear(commands: readonly PathCommand[], center: Pt, radius: number): PathCommand[] {
  const out: PathCommand[] = [];
  let start: Pt = { x: 0, y: 0 };
  let first: Pt = start;
  for (const c of commands) {
    if (c[0] === 'M') {
      start = first = { x: c[1], y: c[2] };
      out.push(c);
    } else if (c[0] === 'Z') {
      // A close draws a line back to the start of the subpath: cut that too, by making it explicit.
      const gap = Math.hypot(start.x - first.x, start.y - first.y);
      if (gap > 1e-9 && near([start, first], center, radius)) {
        for (const piece of pieces(['L', first.x, first.y], start, center, radius)) out.push(piece);
      }
      out.push(c);
      start = first;
    } else {
      const to = c[0] === 'L' ? { x: c[1], y: c[2] } : { x: c[5], y: c[6] };
      for (const piece of pieces(c, start, center, radius)) out.push(piece);
      start = to;
    }
  }
  return out;
}

/** One line or curve, cut into equal pieces if it is near the brush and long. */
function pieces(c: Extract<PathCommand, { 0: 'L' | 'C' }>, start: Pt, center: Pt, radius: number): PathCommand[] {
  if (c[0] === 'L') {
    const end = { x: c[1], y: c[2] };
    if (!near([start, end], center, radius)) return [c];
    const n = Math.min(MAX_PIECES, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / (radius * PIECE)));
    const out: PathCommand[] = [];
    for (let i = 1; i <= n; i++) {
      const p = mid(start, end, i / n);
      out.push(['L', p.x, p.y]);
    }
    return out;
  }
  const p1 = { x: c[1], y: c[2] };
  const p2 = { x: c[3], y: c[4] };
  const end = { x: c[5], y: c[6] };
  if (!near([start, p1, p2, end], center, radius)) return [c];
  // The control polygon is never shorter than the curve.
  const length = Math.hypot(p1.x - start.x, p1.y - start.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y) + Math.hypot(end.x - p2.x, end.y - p2.y);
  const n = Math.min(MAX_PIECES, Math.ceil(length / (radius * PIECE)));
  const out: PathCommand[] = [];
  let a = start;
  let b = p1;
  let d = p2;
  for (let i = 0; i < n - 1; i++) {
    // Cut the first of what is left at 1/(left), so that all the pieces are the same part of the curve.
    const [head, tail] = splitCubic(a, b, d, end, 1 / (n - i));
    out.push(head);
    const t = tail as readonly ['C', number, number, number, number, number, number];
    a = { x: head[5] as number, y: head[6] as number };
    b = { x: t[1], y: t[2] };
    d = { x: t[3], y: t[4] };
  }
  out.push(['C', b.x, b.y, d.x, d.y, end.x, end.y]);
  return out;
}

/**
 * Pushes the points of a path that are under the brush by `delta`. The brush is at `center` with
 * the given `radius`, all in the path's own coordinates. A curve's handles go with the anchor
 * they belong to, so a corner stays a corner and a smooth join stays smooth. Returns the new
 * commands, or null when the brush touches none of the path.
 */
export function nudgePath(commands: readonly PathCommand[], center: Pt, delta: Pt, radius: number): PathCommand[] | null {
  if (radius <= 0 || (!delta.x && !delta.y)) return null;
  const cut = subdivideNear(commands, center, radius);
  const weight = (x: number, y: number): number => falloff(Math.hypot(x - center.x, y - center.y), radius);
  let touched = false;
  // The weight of the anchor each command starts from, which owns the first handle of a curve.
  let from = 0;
  const out = cut.map((c): PathCommand => {
    switch (c[0]) {
      case 'M':
      case 'L': {
        const w = weight(c[1], c[2]);
        from = w;
        if (!w) return c;
        touched = true;
        return [c[0], c[1] + delta.x * w, c[2] + delta.y * w];
      }
      case 'C': {
        const w = weight(c[5], c[6]);
        const first = from;
        from = w;
        if (!w && !first) return c;
        touched = true;
        return ['C', c[1] + delta.x * first, c[2] + delta.y * first, c[3] + delta.x * w, c[4] + delta.y * w, c[5] + delta.x * w, c[6] + delta.y * w];
      }
      default:
        return c;
    }
  });
  return touched ? out : null;
}

/** A path node standing for a rectangle or an ellipse, which have to become paths to be bent. */
function asPath(node: SceneNode): PathNode | null {
  const commands = outline(node);
  if (!commands || node.kind === 'path') return null;
  return { kind: 'path', commands: [...commands], style: node.style, attrs: node.attrs, ...(node.id !== undefined && { id: node.id }), ...(node.transform && { transform: node.transform }) };
}

/**
 * Pushes every line of the drawing under the brush, changing the scene in place: `center` and
 * `delta` are in the drawing's coordinates. Hidden and locked nodes (and what is inside them) are
 * left alone. With a non-empty `only` (the selection), just those nodes, and what is inside
 * them, are pushed. Returns whether anything moved.
 */
export function nudgeScene(scene: Scene, center: Pt, delta: Pt, radius: number, only: readonly NodePath[] = []): boolean {
  let moved = false;
  const chosen = new Set(only.map((p) => p.join(',')));
  const visit = (list: SceneNode[], parent: Matrix, path: readonly number[], inside: boolean): void => {
    list.forEach((child, i) => {
      if (isHidden(child) || isLocked(child)) return;
      const here = [...path, i];
      const allowed = inside || !chosen.size || chosen.has(here.join(','));
      const world = child.transform ? multiply(parent, child.transform) : parent;
      if (child.kind === 'group') return visit(child.children, world, here, allowed);
      if (!allowed) return;
      if (child.kind !== 'path' && child.kind !== 'rect' && child.kind !== 'ellipse') return;
      const inverse = invert(world);
      if (!inverse) return;
      // The brush as the node sees it: its middle, the push (a direction, so no offset), and its size.
      const local = apply(inverse, center.x, center.y);
      const push = { x: inverse[0] * delta.x + inverse[2] * delta.y, y: inverse[1] * delta.x + inverse[3] * delta.y };
      const r = radius / (meanScale(world) || 1);
      const node = child.kind === 'path' ? child : asPath(child)!;
      const commands = nudgePath(child.kind === 'path' ? editableCommands(child) : outline(child)!, { x: local[0], y: local[1] }, push, r);
      if (!commands) return;
      setEditableCommands(node, commands);
      list[i] = node;
      moved = true;
    });
  };
  visit(scene.children, IDENTITY, [], false);
  return moved;
}
