// The ends of a selection, for its handles (src/ui/selectionHandles.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ends } from '../src/ui/selectionHandles.ts';

const order = (page: number) => [7, 3].indexOf(page);

test('the handles go at the left of the first line and the right of the last, in reading order', () => {
  // Out of order on purpose: the last line first, then a line on the page before.
  const rects = Float64Array.from([3, 10, 40, 50, 12, 3, 10, 20, 200, 12, 7, 80, 300, 60, 12, 7, 10, 312, 200, 12]);
  const { start, end } = ends(rects, order);
  assert.deepEqual(start, { page: 7, x: 80, y: 300, height: 12 });
  assert.deepEqual(end, { page: 3, x: 60, y: 40, height: 12 });
});

test('a selection on one line has its ends at that line\'s two edges', () => {
  const { start, end } = ends(Float64Array.from([7, 30, 50, 40, 14]), order);
  assert.deepEqual(start, { page: 7, x: 30, y: 50, height: 14 });
  assert.deepEqual(end, { page: 7, x: 70, y: 50, height: 14 });
});
