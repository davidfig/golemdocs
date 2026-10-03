// Boolean operations on shapes: unite, intersect, subtract and exclude. The shapes are cut into
// polygons (curves into short straight pieces) and combined by the polygon-clipping package; the
// result is one path made of straight lines. Loaded when first used, with the package.

import polygonClipping from 'polygon-clipping';
import type { Geom, MultiPolygon, Pair, Polygon } from 'polygon-clipping';
import { outline } from './geometry.ts';
import { flatten } from './hit.ts';
import { apply } from './matrix.ts';
import { IDENTITY } from './model.ts';
import type { Matrix, PathCommand, PathNode, Scene, SceneNode } from './model.ts';
import { nodeAt } from './edit.ts';
import type { NodePath } from './edit.ts';

export type BooleanOp = 'unite' | 'intersect' | 'subtract' | 'exclude';

/** A shape as a multipolygon: its outline's subpaths combined by the even-odd rule (a ring inside a ring is a hole). */
function toMultiPolygon(commands: readonly PathCommand[], matrix: Matrix): MultiPolygon {
  const rings: Polygon[] = [];
  for (const line of flatten(commands, 24)) {
    if (line.points.length < 3) continue;
    const ring: Pair[] = line.points.map((p) => apply(matrix, p.x, p.y) as Pair);
    ring.push(ring[0]);
    rings.push([ring]);
  }
  if (!rings.length) return [];
  return rings.length === 1 ? [rings[0]] : polygonClipping.xor(...(rings as [Geom, ...Geom[]]));
}

/** Drops points that lie on the line between their neighbours (curves cut into pieces leave many), by Douglas-Peucker. */
function simplify(points: Pair[], epsilon: number): Pair[] {
  if (points.length < 4) return points;
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1;
    let distance = epsilon;
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((points[i][0] - ax) * dy - (points[i][1] - ay) * dx) / length;
      if (d > distance) {
        distance = d;
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

/** A multipolygon as path commands: each ring a closed subpath. */
export function multiPolygonToPath(shape: MultiPolygon, epsilon = 0.02): PathCommand[] {
  const out: PathCommand[] = [];
  for (const polygon of shape) {
    for (const ring of polygon) {
      // The ring repeats its first point at the end.
      const points = simplify(ring.slice(0, -1), epsilon);
      if (points.length < 3) continue;
      points.forEach((p, i) => out.push([i === 0 ? 'M' : 'L', p[0], p[1]]));
      out.push(['Z']);
    }
  }
  return out;
}

/** Combines the outlines of shapes (each with the matrix that takes it to common coordinates), in drawing order: the back one first. */
export function combine(shapes: readonly { commands: readonly PathCommand[]; matrix: Matrix }[], op: BooleanOp): PathCommand[] {
  const geoms = shapes.map((s) => toMultiPolygon(s.commands, s.matrix));
  if (geoms.length < 2) return multiPolygonToPath(geoms[0] ?? []);
  const [first, ...rest] = geoms as [MultiPolygon, ...MultiPolygon[]];
  switch (op) {
    case 'unite':
      return multiPolygonToPath(polygonClipping.union(first, ...rest));
    case 'intersect':
      return multiPolygonToPath(polygonClipping.intersection(first, ...rest));
    case 'subtract':
      // What is in front is cut out of the one at the back.
      return multiPolygonToPath(polygonClipping.difference(first, ...rest));
    case 'exclude':
      return multiPolygonToPath(polygonClipping.xor(first, ...rest));
  }
}

const SHAPES = new Set<SceneNode['kind']>(['path', 'rect', 'ellipse']);

/**
 * Replaces shapes that share a parent with the result of a boolean operation on them, where the
 * topmost of them was; returns its path, or null when the operation can't be done (fewer than two
 * shapes, shapes in different groups, or nothing left of them).
 */
export function booleanNodes(scene: Scene, paths: readonly NodePath[], op: BooleanOp): NodePath | null {
  const sorted = [...paths].sort((a, b) => a[a.length - 1] - b[b.length - 1]);
  if (sorted.length < 2) return null;
  const parent = sorted[0].slice(0, -1);
  if (sorted.some((p) => p.length !== sorted[0].length || !p.slice(0, -1).every((v, i) => v === parent[i]))) return null;
  const nodes = sorted.map((p) => nodeAt(scene, p));
  if (nodes.some((n) => !n || !SHAPES.has(n.kind))) return null;
  const commands = combine(
    nodes.map((n) => ({ commands: outline(n!)!, matrix: n!.transform ?? IDENTITY })),
    op,
  );
  if (!commands.length) return null;
  const list = parent.length ? (nodeAt(scene, parent) as { children: SceneNode[] }).children : scene.children;
  // Unite, intersect and exclude look like the front shape; subtract keeps the look of the one it is cut from.
  const source = (op === 'subtract' ? nodes[0] : nodes[nodes.length - 1])!;
  const result: PathNode = { kind: 'path', commands, style: { ...source.style }, attrs: {} };
  const top = Math.max(...sorted.map((p) => p[p.length - 1]));
  const indices = new Set(sorted.map((p) => p[p.length - 1]));
  const remaining = list.filter((_, i) => !indices.has(i));
  // Where the topmost was, less what was taken out below it.
  const at = top - [...indices].filter((i) => i < top).length;
  remaining.splice(at, 0, result);
  list.splice(0, list.length, ...remaining);
  return [...parent, at];
}
