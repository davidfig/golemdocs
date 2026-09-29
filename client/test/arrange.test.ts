import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrangePages, columnsToFill, nearestPage, type Page } from '../src/document/arrange.ts';

class TestPage implements Page {
  x = -1;
  y = -1;
  constructor(readonly width: number, readonly height: number) {}
  moveTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }
}
const pages = (...sizes: [number, number][]) => sizes.map(([w, h]) => new TestPage(w, h));

test('one column stacks pages with a gap between them', () => {
  const p = pages([100, 200], [100, 200], [100, 200]);
  const bounds = arrangePages(p, 1, 10);
  assert.deepEqual(p.map((q) => [q.x, q.y]), [[0, 0], [0, 210], [0, 420]]);
  assert.deepEqual(bounds, { x: 0, y: 0, width: 100, height: 620 });
});

test('columns fill row by row; a row is as tall as its tallest page; narrower pages are centered', () => {
  const p = pages([100, 100], [60, 300], [100, 100]);
  const bounds = arrangePages(p, 2, 10);
  assert.deepEqual([p[0].x, p[0].y], [0, 0]);
  assert.deepEqual([p[1].x, p[1].y], [110 + 20, 0], 'centered in a 100-wide column');
  assert.deepEqual([p[2].x, p[2].y], [0, 310], 'the second row starts below the tall page');
  assert.deepEqual(bounds, { x: 0, y: 0, width: 210, height: 410 });
});

test('more columns than pages uses only as many as there are pages; no pages is empty', () => {
  const p = pages([100, 100], [100, 100]);
  assert.equal(arrangePages(p, 5, 0).width, 200);
  assert.deepEqual(arrangePages([], 3, 10), { x: 0, y: 0, width: 0, height: 0 });
  assert.equal(arrangePages(pages([10, 10]), 0, 0).width, 10, 'zero columns still means one');
});

test('pages stay sorted by y, which culling needs', () => {
  const p = pages([100, 50], [80, 90], [120, 70], [100, 40], [60, 60]);
  arrangePages(p, 2, 5);
  for (let i = 1; i < p.length; i++) assert.ok(p[i].y >= p[i - 1].y);
});

test('the column count follows the viewport shape', () => {
  const p = pages(...Array.from({ length: 12 }, (): [number, number] => [100, 100]));
  assert.equal(columnsToFill(p, 0.1, 0), 1, 'a tall narrow view wants one column');
  assert.equal(columnsToFill(p, 100, 0), 12, 'a very wide view wants a single row');
  assert.equal(columnsToFill(p, 4 / 3, 0), 4, 'a 4:3 view over square pages is 4 by 3');
  assert.equal(columnsToFill([], 2, 0), 1);
});

test('the nearest page is the one under the point, else the closest', () => {
  const a = { x: 0, y: 0, width: 100, height: 100 };
  const b = { x: 0, y: 200, width: 100, height: 100 };
  assert.equal(nearestPage([a, b], 50, 250), b);
  assert.equal(nearestPage([a, b], 50, 120), a, 'in the gap, closer to a');
  assert.equal(nearestPage([a, b], 50, 180), b, 'in the gap, closer to b');
  assert.equal(nearestPage([a, b], 500, 500), b, 'far outside');
  assert.equal(nearestPage([], 0, 0), null);
});
