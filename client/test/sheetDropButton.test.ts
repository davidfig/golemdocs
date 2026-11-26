import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SheetGeometry } from '../src/sheet/geometry.ts';
import { DROP_BUTTON_POINTS, arrowRows, choicesButton, dropTarget, filterButton } from '../src/sheet/renderer.ts';
import { CSS_PX_PER_POINT } from '../src/view/camera.ts';

/** Cells 64 points wide and `rowH` tall. */
const grid = (rowH = 15): SheetGeometry => ({ x: (c: number) => c * 64, y: (r: number) => r * rowH }) as unknown as SheetGeometry;

/** One CSS pixel in sheet points at this zoom. */
const cssPx = (zoom: number): number => 1 / (zoom * CSS_PX_PER_POINT);

test('the filter button is the same size in sheet points at every zoom', () => {
  for (const zoom of [0.5, 1, 2, 4]) {
    const box = filterButton(grid(20), 0, 0, cssPx(zoom))!;
    assert.ok(Math.abs(box.x1 - box.x0 - DROP_BUTTON_POINTS) < 1e-9, `zoom ${zoom}`);
    assert.equal(box.x1 - box.x0, box.y1 - box.y0);
  }
});

test('the filter button is 15 CSS pixels at 100%', () => {
  const box = filterButton(grid(20), 0, 0, cssPx(1))!;
  assert.ok(Math.abs((box.x1 - box.x0) * CSS_PX_PER_POINT - 15) < 1e-9);
});

test('the filter button never outgrows a short row', () => {
  const px = cssPx(1);
  const box = filterButton(grid(8), 0, 0, px)!;
  assert.ok(Math.abs(box.y1 - box.y0 - (8 - 2 * px)) < 1e-9);
});

test('the list button zooms with the cells too', () => {
  for (const zoom of [0.5, 2]) {
    const box = choicesButton(grid(20), 0, 0, cssPx(zoom))!;
    assert.ok(Math.abs(box.y1 - box.y0 - DROP_BUTTON_POINTS) < 1e-9);
  }
});

test('a small button keeps a clickable area of at least 10 CSS pixels', () => {
  const px = cssPx(0.25);
  const box = filterButton(grid(20), 0, 0, px)!;
  const hit = dropTarget(box, px);
  assert.ok(Math.abs((hit.x1 - hit.x0) / px - 10) < 1e-9);
  assert.ok(Math.abs((hit.x0 + hit.x1) / 2 - (box.x0 + box.x1) / 2) < 1e-9);
  // A button already bigger than that is its own target.
  const big = filterButton(grid(20), 0, 0, cssPx(2))!;
  assert.deepEqual(dropTarget(big, cssPx(2)), big);
});

test('the filter button stands level with its cell\'s text: bottom, top or middle', () => {
  const px = cssPx(1);
  const g = grid(40);
  const bottom = filterButton(g, 0, 0, px)!;
  const top = filterButton(g, 0, 0, px, 'top')!;
  const middle = filterButton(g, 0, 0, px, 'center')!;
  assert.ok(Math.abs(bottom.y1 - (40 - px)) < 1e-9);
  assert.ok(Math.abs(top.y0 - px) < 1e-9);
  assert.ok(Math.abs((middle.y0 + middle.y1) / 2 - 20) < 1e-9);
  for (const b of [top, middle]) assert.equal(b.y1 - b.y0, bottom.y1 - bottom.y0);
});

test('the arrow\'s rows sit on whole device pixels and narrow to a point', () => {
  const rows = arrowRows(50.3, 10.4, 16, 9);
  for (const [x, y, w, coverage] of rows) {
    assert.ok(Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(w), `${x} ${y} ${w}`);
    assert.ok(coverage > 0 && coverage <= 1);
  }
  // Each row's ink (width times coverage) is the triangle's width at that row, shrinking towards the tip.
  const ink = new Map<number, number>();
  for (const [, y, w, coverage] of rows) ink.set(y, (ink.get(y) ?? 0) + w * coverage);
  const widths = [...ink.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  assert.equal(widths.length, 9);
  for (let i = 0; i < widths.length; i++) assert.ok(Math.abs(widths[i] - 16 * (1 - (i + 0.5) / 9)) < 0.05, `row ${i}: ${widths[i]}`);
  // The slanted edges are partly covered pixels, not whole steps.
  assert.ok(rows.some(([, , , c]) => c < 1));
});
