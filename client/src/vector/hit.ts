// Finding what is under a point, or inside a box, in a scene: what a click or a drag selects.

import { apply, invert, meanScale } from './matrix.ts';
import type { PathCommand, Scene, SceneNode, Style } from './model.ts';
import { outline, textBounds } from './geometry.ts';
import { isLocked, worldBounds } from './edit.ts';
import type { NodePath } from './edit.ts';
import { inherited, parseLength } from './style.ts';

export interface Pt {
  x: number;
  y: number;
}

/** A path as polylines: each curve cut into short straight pieces. `closed` says whether the last point joins the first. */
export interface Polyline {
  points: Pt[];
  closed: boolean;
}

export function flatten(commands: readonly PathCommand[], steps = 16): Polyline[] {
  const out: Polyline[] = [];
  let current: Polyline | null = null;
  let x = 0;
  let y = 0;
  for (const c of commands) {
    if (c[0] === 'M') {
      current = { points: [{ x: c[1], y: c[2] }], closed: false };
      out.push(current);
      x = c[1];
      y = c[2];
    } else if (c[0] === 'Z') {
      if (current) {
        current.closed = true;
        x = current.points[0].x;
        y = current.points[0].y;
      }
    } else {
      if (!current) {
        current = { points: [{ x, y }], closed: false };
        out.push(current);
      }
      if (c[0] === 'L') {
        current.points.push({ x: c[1], y: c[2] });
        x = c[1];
        y = c[2];
      } else {
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const u = 1 - t;
          current.points.push({
            x: u * u * u * x + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5],
            y: u * u * u * y + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6],
          });
        }
        x = c[5];
        y = c[6];
      }
    }
  }
  return out;
}

/** The distance from a point to the segment between two points. */
export function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Winding number of a polyline around a point (open polylines are taken as closed, as a fill does). */
function winding(p: Pt, line: Polyline): number {
  let w = 0;
  const pts = line.points;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (a.y <= p.y) {
      if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) w++;
    } else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) w--;
  }
  return w;
}

/** Whether a point is inside the filled area of polylines. */
export function insideFill(p: Pt, lines: readonly Polyline[], evenOdd: boolean): boolean {
  const total = lines.reduce((n, line) => n + winding(p, line), 0);
  return evenOdd ? total % 2 !== 0 : total !== 0;
}

/** The distance from a point to the nearest line of the polylines. */
export function distanceToLines(p: Pt, lines: readonly Polyline[]): number {
  let best = Infinity;
  for (const line of lines) {
    const pts = line.points;
    if (pts.length === 1) best = Math.min(best, Math.hypot(p.x - pts[0].x, p.y - pts[0].y));
    for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, distanceToSegment(p, pts[i], pts[i + 1]));
    if (line.closed && pts.length > 2) best = Math.min(best, distanceToSegment(p, pts[pts.length - 1], pts[0]));
  }
  return best;
}

const paints = (chain: readonly Style[], property: string, fallback?: string): boolean => {
  const v = inherited(chain, property) ?? fallback;
  return v !== undefined && v !== 'none' && v !== 'transparent';
};

/** The node under a point (in the drawing's coordinates): the path to the topmost one, down to the shape inside any groups, or null. `tolerance` is how far from a line still counts, in the same units. */
function walkHits(scene: Scene, point: Pt, tolerance: number, all: NodePath[] | null): NodePath | null {
  const visit = (nodes: readonly SceneNode[], parent: readonly Style[], p: Pt, tol: number, prefix: NodePath): NodePath | null => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (node.kind === 'raw' || node.style.display === 'none' || isLocked(node)) continue;
      const chain = [node.style, ...parent];
      if (inherited(chain, 'pointer-events') === 'none') continue;
      let local = p;
      let ltol = tol;
      if (node.transform) {
        const inverse = invert(node.transform);
        if (!inverse) continue;
        const [x, y] = apply(inverse, p.x, p.y);
        local = { x, y };
        ltol = tol / (meanScale(node.transform) || 1);
      }
      const path = [...prefix, i];
      if (node.kind === 'group') {
        const inside = visit(node.children, chain, local, ltol, path);
        if (inside && !all) return inside;
        continue;
      }
      const commands = outline(node);
      if (commands) {
        const lines = flatten(commands);
        // Fill is black unless set; a fill of "none" can't be clicked inside.
        if (paints(chain, 'fill', 'black') && insideFill(local, lines, inherited(chain, 'fill-rule') === 'evenodd')) {
          if (all) all.push(path);
          else return path;
        }
        if (paints(chain, 'stroke')) {
          const width = parseLength(inherited(chain, 'stroke-width')) ?? 1;
          if (distanceToLines(local, lines) <= width / 2 + ltol) {
          if (all) all.push(path);
          else return path;
        }
        }
        // A shape that shows nothing can still be reached at its edge.
        else if (!paints(chain, 'fill', 'black') && distanceToLines(local, lines) <= ltol) {
          if (all) all.push(path);
          else return path;
        }
      } else if (node.kind === 'text') {
        const b = textBounds(node, chain);
        if (local.x >= b.x - ltol && local.x <= b.x + b.width + ltol && local.y >= b.y - ltol && local.y <= b.y + b.height + ltol) {
          if (all) all.push(path);
          else return path;
        }
      } else if (node.kind === 'image') {
        if (local.x >= node.x && local.x <= node.x + node.width && local.y >= node.y && local.y <= node.y + node.height) {
          if (all) all.push(path);
          else return path;
        }
      }
    }
    return null;
  };
  return visit(scene.children, [scene.style], point, tolerance, []);
}

export function hitTest(scene: Scene, point: Pt, tolerance = 0): NodePath | null {
  return walkHits(scene, point, tolerance, null);
}

/** Every shape under a point, the topmost first (each as the path to the shape itself, down inside any groups). */
export function hitTestAll(scene: Scene, point: Pt, tolerance = 0): NodePath[] {
  const all: NodePath[] = [];
  walkHits(scene, point, tolerance, all);
  return all;
}

/** The top-level nodes inside or touched by a box: what a rubber band selects. */
export function nodesInRect(scene: Scene, rect: { x: number; y: number; width: number; height: number }, mode: 'inside' | 'touching' = 'touching'): NodePath[] {
  const out: NodePath[] = [];
  scene.children.forEach((node, i) => {
    if (node.kind === 'raw' || node.style.display === 'none' || isLocked(node)) return;
    const b = worldBounds(scene, [i]);
    if (!b) return;
    const inside = b.x >= rect.x && b.y >= rect.y && b.x + b.width <= rect.x + rect.width && b.y + b.height <= rect.y + rect.height;
    const touching = b.x <= rect.x + rect.width && b.x + b.width >= rect.x && b.y <= rect.y + rect.height && b.y + b.height >= rect.y;
    if (mode === 'inside' ? inside : touching) out.push([i]);
  });
  return out;
}
