// Free drawing: a pointer's points made into a smooth path with few points (src/vector/freehand.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dedupe, fitCurve, freehandPath, simplify } from '../src/vector/freehand.ts';
import { flatten, distanceToLines } from '../src/vector/hit.ts';
import { pathBounds } from '../src/vector/pathData.ts';

const circle = (n: number, r = 50, cx = 100, cy = 100) => Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) }));

/** How far the farthest of the points is from the path. */
const worstDistance = (points: { x: number; y: number }[], path: Parameters<typeof flatten>[0]) => {
  const lines = flatten(path, 48);
  return Math.max(...points.map((p) => distanceToLines(p, lines)));
};

test('points on top of each other are thinned, and the last one is kept', () => {
  const out = dedupe([{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 5, y: 0 }, { x: 5.2, y: 0 }], 1);
  assert.deepEqual(out, [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5.2, y: 0 }]);
});

test('a straight line with a little shake becomes its two ends', () => {
  const wobble = Array.from({ length: 40 }, (_, i) => ({ x: i * 5, y: Math.sin(i) * 0.4 }));
  assert.deepEqual(simplify(wobble, 1).length, 2);
  assert.equal(simplify(wobble, 0.01).length > 2, true);
});

test('a stroke along a curve is fitted by a few cubics that stay within the tolerance', () => {
  const stroke = Array.from({ length: 80 }, (_, i) => ({ x: i * 4, y: 60 * Math.sin((i * 4) / 60) }));
  const path = fitCurve(stroke, 2);
  assert.equal(path[0][0], 'M');
  assert.ok(path.length >= 2 && path.length <= 10, `${path.length} commands for 80 points`);
  assert.ok(path.slice(1).every((c) => c[0] === 'C'));
  assert.ok(worstDistance(stroke, path) < 2.5, `${worstDistance(stroke, path)}`);
});

test('a hand-drawn circle comes out as a closed, smooth path with few points', () => {
  // A little noise, as a hand makes.
  const noisy = circle(120).map((p, i) => ({ x: p.x + Math.sin(i * 3) * 0.6, y: p.y + Math.cos(i * 5) * 0.6 }));
  const path = freehandPath([...noisy, noisy[0]], 2);
  assert.equal(path[path.length - 1][0], 'Z');
  assert.ok(path.length <= 14, `${path.length}`);
  const b = pathBounds(path)!;
  assert.ok(Math.abs(b.width - 100) < 5 && Math.abs(b.height - 100) < 5);
  assert.ok(worstDistance(noisy, path) < 3);
});

test('an open stroke stays open, and a tap or a dot draws nothing', () => {
  const open = Array.from({ length: 30 }, (_, i) => ({ x: i * 6, y: i * 2 }));
  assert.notEqual(freehandPath(open, 2).at(-1)![0], 'Z');
  assert.deepEqual(freehandPath([{ x: 1, y: 1 }], 2), []);
  assert.deepEqual(freehandPath([{ x: 1, y: 1 }, { x: 1.2, y: 1 }], 2), []);
  // Two far points make a straight curve.
  assert.deepEqual(freehandPath([{ x: 0, y: 0 }, { x: 30, y: 0 }], 2).map((c) => c[0]), ['M', 'C']);
});

test('a sharp corner is kept as a corner', () => {
  const l = [...Array.from({ length: 20 }, (_, i) => ({ x: i * 5, y: 0 })), ...Array.from({ length: 20 }, (_, i) => ({ x: 95, y: i * 5 + 5 }))];
  const path = freehandPath(l, 1.5);
  assert.ok(worstDistance(l, path) < 2);
  const corner = path.find((c) => c[0] === 'C' && Math.abs((c as number[])[5] - 95) < 3 && Math.abs((c as number[])[6]) < 3);
  assert.ok(corner, 'a curve ends at the corner');
});
