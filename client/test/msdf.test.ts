// Runtime multi-channel distance fields (src/formats/msdf.ts), read back the way the text shader
// reads them: the median of the three channels, bilinearly sampled, 0.5 on the outline.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Outline } from '../../pdf/src/fonts/program.ts';
import { generateField, type Field } from '../src/formats/msdf.ts';

const PX = 48;
const RANGE = 8;

/** A polygon (ems, y up) as an outline. */
function polygon(...pts: [number, number][]): Outline[number] {
  return pts.map((p, i) => ({ points: [...p, ...pts[(i + 1) % pts.length]] }));
}

const square = (x0: number, y0: number, x1: number, y1: number) => polygon([x0, y0], [x1, y0], [x1, y1], [x0, y1]);

/** The shader's view of the field at a point (ems, y up): the median of the bilinearly sampled channels. */
function sample(f: Field, x: number, y: number): number {
  const px = (x - f.left) * PX - 0.5;
  const py = (f.top - y) * PX - 0.5;
  const x0 = Math.max(0, Math.min(f.width - 1, Math.floor(px)));
  const y0 = Math.max(0, Math.min(f.height - 1, Math.floor(py)));
  const x1 = Math.min(f.width - 1, x0 + 1);
  const y1 = Math.min(f.height - 1, y0 + 1);
  const fx = Math.min(1, Math.max(0, px - x0));
  const fy = Math.min(1, Math.max(0, py - y0));
  const c = [0, 1, 2].map((k) => {
    const at = (i: number, j: number) => f.pixels[(j * f.width + i) * 3 + k] / 255;
    return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
  });
  return Math.max(Math.min(c[0], c[1]), Math.min(Math.max(c[0], c[1]), c[2]));
}

const inside = (f: Field, x: number, y: number) => sample(f, x, y) > 0.5;

test('a square: inside, outside, and the edge where it is', () => {
  const f = generateField([square(0, 0, 0.5, 0.5)], PX, RANGE)!;
  assert.ok(inside(f, 0.25, 0.25));
  assert.ok(!inside(f, 0.6, 0.25));
  assert.ok(!inside(f, -0.05, 0.25));
  // Half a pixel either side of the edge.
  assert.ok(inside(f, 0.5 - 0.5 / PX, 0.25));
  assert.ok(!inside(f, 0.5 + 0.5 / PX, 0.25));
  // The field reaches range / 2 pixels past the outline.
  assert.ok(f.left <= -RANGE / 2 / PX && f.right >= 0.5 + RANGE / 2 / PX);
});

test('corners stay sharp, where a single-channel field would round them', () => {
  const f = generateField([square(0, 0, 0.5, 0.5)], PX, RANGE)!;
  // A fifth of a pixel in from the corner, along the diagonal.
  const d = 0.2 / PX;
  assert.ok(inside(f, 0.5 - d, 0.5 - d));
  assert.ok(!inside(f, 0.5 + d, 0.5 + d));
  // A thin spike: its tip is still there a pixel from the end.
  const spike = generateField([polygon([0, 0], [0.6, 0.05], [0, 0.1])], PX, RANGE)!;
  assert.ok(inside(spike, 0.6 - 1.5 / PX, 0.05));
});

test('either winding direction gives the same field', () => {
  const ccw = generateField([square(0, 0, 0.3, 0.4)], PX, RANGE)!;
  const cw = generateField([polygon([0, 0], [0, 0.4], [0.3, 0.4], [0.3, 0])], PX, RANGE)!;
  assert.deepEqual([cw.width, cw.height], [ccw.width, ccw.height]);
  for (const [x, y] of [[0.15, 0.2], [0.35, 0.2], [0.29, 0.39]]) assert.equal(inside(cw, x, y), inside(ccw, x, y), `${x}, ${y}`);
});

test('holes and overlapping contours fill as the non-zero rule says', () => {
  // A ring: an outer square and an inner one wound the other way.
  const ring = generateField([square(0, 0, 0.6, 0.6), polygon([0.2, 0.2], [0.2, 0.4], [0.4, 0.4], [0.4, 0.2])], PX, RANGE)!;
  assert.ok(inside(ring, 0.1, 0.3));
  assert.ok(!inside(ring, 0.3, 0.3));
  // Two squares wound the same way, overlapping: one shape, filled where they overlap too.
  const both = generateField([square(0, 0, 0.4, 0.4), square(0.2, 0.2, 0.6, 0.6)], PX, RANGE)!;
  for (const [x, y] of [[0.1, 0.1], [0.3, 0.3], [0.21, 0.3], [0.5, 0.5]]) assert.ok(inside(both, x, y), `${x}, ${y}`);
  assert.ok(!inside(both, 0.5, 0.1));
});

test('curves: a circle from four cubics is round', () => {
  const k = 0.5523 * 0.3;
  const c = (x: number, y: number) => [0.3 + x, 0.3 + y];
  const circle: Outline[number] = [
    { points: [...c(0.3, 0), ...c(0.3, k), ...c(k, 0.3), ...c(0, 0.3)] },
    { points: [...c(0, 0.3), ...c(-k, 0.3), ...c(-0.3, k), ...c(-0.3, 0)] },
    { points: [...c(-0.3, 0), ...c(-0.3, -k), ...c(-k, -0.3), ...c(0, -0.3)] },
    { points: [...c(0, -0.3), ...c(k, -0.3), ...c(0.3, -k), ...c(0.3, 0)] },
  ];
  const f = generateField([circle], PX, RANGE)!;
  for (let a = 0; a < Math.PI * 2; a += 0.3) {
    const r = (dr: number) => [0.3 + Math.cos(a) * (0.3 + dr), 0.3 + Math.sin(a) * (0.3 + dr)] as const;
    assert.ok(inside(f, ...r(-0.5 / PX)), `inside at ${a}`);
    assert.ok(!inside(f, ...r(0.5 / PX)), `outside at ${a}`);
  }
});

test('nothing to draw: no field', () => {
  assert.equal(generateField([], PX, RANGE), null);
});
