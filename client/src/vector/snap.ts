// Snapping: pulling what is being moved, resized or drawn to the edges and centres of the other
// shapes and of the page, within a few pixels, and telling where the lines it caught are so that
// they can be drawn as guides.

import { selectionBounds } from './edit.ts';
import type { NodePath } from './edit.ts';
import type { Bounds } from './geometry.ts';
import type { Scene } from './model.ts';

export interface SnapTargets {
  /** The x of vertical lines, and the y of horizontal ones, that things snap to. */
  xs: number[];
  ys: number[];
}

export interface Snap {
  /** How far to move to land on the lines. */
  dx: number;
  dy: number;
  /** The lines landed on. */
  guides: SnapTargets;
}

const unique = (values: number[]): number[] => [...new Set(values.map((v) => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);

/** The lines of every top-level shape of the scene (except the ones in `exclude`) and of the page itself: edges and centres. */
export function snapTargets(scene: Scene, exclude: readonly NodePath[] = []): SnapTargets {
  const xs: number[] = [];
  const ys: number[] = [];
  const add = (b: Bounds): void => {
    xs.push(b.x, b.x + b.width / 2, b.x + b.width);
    ys.push(b.y, b.y + b.height / 2, b.y + b.height);
  };
  add(scene.viewBox);
  scene.children.forEach((node, i) => {
    if (node.kind === 'raw' || node.style.display === 'none') return;
    if (exclude.some((p) => p[0] === i)) return;
    const b = selectionBounds(scene, [[i]]);
    if (b) add(b);
  });
  return { xs: unique(xs), ys: unique(ys) };
}

/** The line nearest to a value, if one is within `threshold`. */
export function snapValue(value: number, lines: readonly number[], threshold: number): number | null {
  let best: number | null = null;
  for (const line of lines) if (Math.abs(line - value) <= threshold && (best === null || Math.abs(line - value) < Math.abs(best - value))) best = line;
  return best;
}

/** How to move a box so that its edges or centre land on target lines (each axis on its own). */
export function snapBox(box: Bounds, targets: SnapTargets, threshold: number): Snap {
  const along = (start: number, size: number, lines: readonly number[]): { delta: number; guide: number | null } => {
    let best: { delta: number; guide: number } | null = null;
    for (const v of [start, start + size / 2, start + size]) {
      const line = snapValue(v, lines, threshold);
      if (line !== null && (!best || Math.abs(line - v) < Math.abs(best.delta))) best = { delta: line - v, guide: line };
    }
    return best ?? { delta: 0, guide: null };
  };
  const x = along(box.x, box.width, targets.xs);
  const y = along(box.y, box.height, targets.ys);
  return { dx: x.delta, dy: y.delta, guides: { xs: x.guide === null ? [] : [x.guide], ys: y.guide === null ? [] : [y.guide] } };
}

/** A point pulled to lines on each axis. */
export function snapPoint(p: { x: number; y: number }, targets: SnapTargets, threshold: number): { x: number; y: number; guides: SnapTargets } {
  const x = snapValue(p.x, targets.xs, threshold);
  const y = snapValue(p.y, targets.ys, threshold);
  return { x: x ?? p.x, y: y ?? p.y, guides: { xs: x === null ? [] : [x], ys: y === null ? [] : [y] } };
}
