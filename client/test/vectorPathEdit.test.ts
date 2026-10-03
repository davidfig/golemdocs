// Editing the points of a path (src/vector/pathEdit.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSmooth, moveAnchor, moveHandle, nearestSegment, penPath, removeAnchor, splitSegment } from '../src/vector/pathEdit.ts';
import { parsePath, pathBounds } from '../src/vector/pathData.ts';

const wave = () => parsePath('M0 0 C0 10 10 10 10 0 C10 -10 20 -10 20 0');

test('moving an anchor takes its handles with it, and the next curve’s first handle', () => {
  const moved = moveAnchor(wave(), 1, 2, 3);
  assert.deepEqual(moved[1], ['C', 0, 10, 12, 13, 12, 3]);
  assert.deepEqual(moved[2], ['C', 12, -7, 20, -10, 20, 0]);
  // The first anchor has no handle of its own before it, only the curve’s first handle after it.
  const first = moveAnchor(wave(), 0, 1, 1);
  assert.deepEqual(first[0], ['M', 1, 1]);
  assert.deepEqual(first[1], ['C', 1, 11, 10, 10, 10, 0]);
});

test('moving a handle can turn the handle across the anchor to stay in line', () => {
  const smooth = moveHandle(wave(), 1, 'c2', 0, 5, true);
  assert.deepEqual(smooth[1], ['C', 0, 10, 10, 15, 10, 0]);
  // The other side mirrors: it kept its length (10) and now points away from the new direction.
  const next = smooth[2] as readonly ['C', number, number, number, number, number, number];
  assert.ok(Math.abs(next[1] - 10) < 1e-9 && Math.abs(next[2] + 10) < 1e-9, `${next[1]},${next[2]}`);
  const free = moveHandle(wave(), 1, 'c2', 0, 5, false);
  assert.deepEqual(free[2], wave()[2]);
  assert.ok(isSmooth(wave(), 1));
  assert.ok(!isSmooth(parsePath('M0 0 C0 10 10 10 10 0 C10 10 20 10 20 0'), 1));
  assert.ok(!isSmooth(parsePath('M0 0 L5 5'), 1));
});

test('splitting a segment keeps its shape', () => {
  const lineSplit = splitSegment(parsePath('M0 0 L10 0'), 1, 0.25);
  assert.deepEqual(lineSplit, [['M', 0, 0], ['L', 2.5, 0], ['L', 10, 0]]);
  const original = wave();
  const split = splitSegment(original, 1, 0.5);
  assert.equal(split.length, 4);
  assert.deepEqual(split[1][0], 'C');
  const a = pathBounds(original)!;
  const b = pathBounds(split)!;
  for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(a[key] - b[key]) < 1e-9, key);
  // The curve’s middle is where the new anchor is.
  assert.deepEqual([(split[1] as number[])[5], (split[1] as number[])[6]], [5, 7.5]);
});

test('removing an anchor joins its neighbours', () => {
  assert.deepEqual(removeAnchor(parsePath('M0 0 L5 5 L10 0'), 1), [['M', 0, 0], ['L', 10, 0]]);
  const joined = removeAnchor(wave(), 1);
  assert.deepEqual(joined, [['M', 0, 0], ['C', 0, 10, 20, -10, 20, 0]]);
  // Removing where the path starts moves the start on.
  assert.deepEqual(removeAnchor(parsePath('M0 0 L5 5 L10 0'), 0), [['M', 5, 5], ['L', 10, 0]]);
  assert.deepEqual(removeAnchor(parsePath('M0 0'), 0), []);
});

test('the nearest place on a path', () => {
  const near = nearestSegment(wave(), { x: 10, y: 4 })!;
  assert.equal(near.index, 1);
  assert.ok(near.distance < 4);
  const line = nearestSegment(parsePath('M0 0 L10 0 L10 10'), { x: 12, y: 5 })!;
  assert.equal(line.index, 2);
  assert.ok(Math.abs(line.t - 0.5) < 1e-9 && Math.abs(line.distance - 2) < 1e-9);
  assert.equal(nearestSegment([], { x: 0, y: 0 }), null);
  // The closing side of a closed path counts.
  const closed = nearestSegment(parsePath('M0 0 L10 0 L10 10 Z'), { x: 4, y: 5.5 })!;
  assert.equal(closed.index, 3);
});

test('pen points make lines between corners and curves where there are handles', () => {
  assert.deepEqual(penPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false), [['M', 0, 0], ['L', 10, 0], ['L', 10, 10]]);
  const curved = penPath([{ x: 0, y: 0, outHandle: { x: 0, y: 5 } }, { x: 10, y: 0, inHandle: { x: 10, y: 5 } }], false);
  assert.deepEqual(curved, [['M', 0, 0], ['C', 0, 5, 10, 5, 10, 0]]);
  assert.deepEqual(penPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }], true), [['M', 0, 0], ['L', 10, 0], ['L', 5, 5], ['Z']]);
  assert.deepEqual(penPath([], false), []);
});
