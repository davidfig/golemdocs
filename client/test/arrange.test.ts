import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrangeGrid, arrangePages, columnsToFill, gridColumns, nearestPage, onSeam, shownTop, shownBottom, type GridState, type Page } from '../src/document/arrange.ts';

class TestPage implements Page {
  x = -1;
  y = -1;
  shown: { top: number; bottom: number } | null = null;
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

test('onSeam finds the gap between pages, or the line where touching pages meet', () => {
  const apart = pages([100, 200], [100, 200]);
  arrangePages(apart, 1, 10); // gap from 200 to 210
  assert.equal(onSeam(apart, 50, 205, 1), true, 'in the gap');
  assert.equal(onSeam(apart, 50, 100, 1), false, 'inside a page');
  assert.equal(onSeam(apart, 150, 205, 1), false, 'beside the pages');
  assert.equal(onSeam(apart, 50, 420, 1), false, 'below the last page');
  const joined = pages([100, 200], [100, 200]);
  arrangePages(joined, 1, 0);
  assert.equal(onSeam(joined, 50, 200, 2), true, 'on the line');
  assert.equal(onSeam(joined, 50, 198.5, 2), true, 'just above it');
  assert.equal(onSeam(joined, 50, 190, 2), false, 'well inside the page');
  const columns = pages([100, 100], [100, 100]);
  arrangePages(columns, 2, 10);
  assert.equal(onSeam(columns, 105, 50, 1), false, 'between side-by-side pages is not a seam');
});

test('hiding the white space shows only each page\'s body, the bodies meeting edge to edge', () => {
  const p = pages([100, 200], [100, 200], [100, 200]);
  for (const page of p) page.shown = { top: 30, bottom: 170 };
  const bounds = arrangePages(p, 1, 0);
  assert.deepEqual(p.map((q) => q.y), [-30, 110, 250], 'each page sits so its body starts where the last one ended');
  assert.deepEqual(p.map((q) => shownTop(q)), [0, 140, 280]);
  assert.deepEqual(bounds, { x: 0, y: 0, width: 100, height: 420 });
  assert.equal(onSeam(p, 50, 140, 2), true, 'the seam is where the bodies meet');
  assert.equal(onSeam(p, 50, 200, 2), false, 'not where the full pages would meet');
  assert.equal(nearestPage(p, 50, 145), p[1], 'just below the seam is the second page, though the first one\'s hidden margin reaches there');
  assert.equal(nearestPage(p, 50, 135), p[0]);
});

test('a page with no body band is shown whole among cropped ones', () => {
  const p = pages([100, 200], [100, 200]);
  p[0].shown = { top: 30, bottom: 170 };
  arrangePages(p, 1, 0);
  assert.deepEqual([shownTop(p[1]), shownBottom(p[1])], [140, 340]);
});

test('the grid keeps its column count while it still fits the view, so pages arriving do not reshuffle it', () => {
  const square = (n: number) => pages(...Array.from({ length: n }, (): [number, number] => [100, 100]));
  assert.equal(gridColumns(square(12), 4 / 3, 0, 0), 4, 'none yet: the best');
  assert.equal(gridColumns(square(13), 4 / 3, 0, 4), 4, 'one more page: kept');
  assert.equal(gridColumns(square(12), 4 / 3, 0, 5), 4, 'a much worse shape: changed');
  assert.equal(gridColumns(square(3), 4 / 3, 0, 4), 2, 'more columns than pages: the best');
});

test('pages still to come are held as blank sheets, and the grid has its final shape from the start', () => {
  const state: GridState = { columns: 0, blanks: [] };
  const first = pages([100, 100], [100, 100]);
  const bounds = arrangeGrid(first, 12, 4 / 3, 0, state);
  assert.equal(state.blanks.length, 10);
  assert.deepEqual([state.blanks[0].width, state.blanks[0].height], [100, 100], 'the size of the last page laid out');
  assert.equal(state.columns, 4);
  assert.deepEqual(bounds, { x: 0, y: 0, width: 400, height: 300 });
  assert.deepEqual([state.blanks[9].x, state.blanks[9].y], [300, 200]);

  const more = pages(...Array.from({ length: 7 }, (): [number, number] => [100, 100]));
  assert.deepEqual(arrangeGrid(more, 12, 4 / 3, 0, state), bounds, 'the grid does not move as pages arrive');
  assert.equal(state.blanks.length, 5);
  assert.deepEqual([more[6].x, more[6].y], [200, 100]);

  arrangeGrid(more, 0, 4 / 3, 0, state);
  assert.equal(state.blanks.length, 0, 'none once the count is not known');
  arrangeGrid([], 12, 4 / 3, 0, state);
  assert.equal(state.blanks.length, 0, 'none before the first page');
});
