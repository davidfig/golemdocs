// The camera's arithmetic (src/view/camera.ts): document points to canvas pixels, zoom, pan, fit, clamp.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Camera, CSS_PX_PER_POINT } from '../src/view/camera.ts';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('scale is device pixels per point: zoom x 96/72 x dpr', () => {
  const c = new Camera();
  near(c.scale, 96 / 72);
  c.zoom = 2;
  c.dpr = 1.5;
  near(c.scale, 2 * CSS_PX_PER_POINT * 1.5);
});

test('toDocument maps CSS pixels through zoom and the view origin', () => {
  const c = new Camera();
  c.x = 100;
  c.y = 50;
  c.zoom = 2;
  const p = c.toDocument(96, 48);
  near(p.x, 100 + 96 / (2 * CSS_PX_PER_POINT));
  near(p.y, 50 + 48 / (2 * CSS_PX_PER_POINT));
  assert.deepEqual(new Camera().toDocument(0, 0), { x: 0, y: 0 });
  assert.equal(new Camera().toDocument(96, 0).x, 72, 'at 100% 96 CSS px are 72 points');
});

test('zoomAt keeps the document point under the cursor fixed', () => {
  const c = new Camera();
  c.x = 30;
  c.y = -10;
  const before = c.toDocument(200, 120);
  c.zoomAt(200, 120, 3);
  near(c.zoom, 3);
  const after = c.toDocument(200, 120);
  near(after.x, before.x);
  near(after.y, before.y);
  c.zoomAt(5, 5, 1 / 6);
  const again = c.toDocument(5, 5);
  near(c.zoom, 0.5);
  assert.ok(Number.isFinite(again.x));
});

test('zoomAt clamps the zoom, and at the limit the view does not drift', () => {
  const c = new Camera();
  c.maxZoom = 4;
  c.zoomAt(10, 10, 100);
  assert.equal(c.zoom, 4);
  const { x, y } = c;
  c.zoomAt(300, 200, 2); // already at the limit: nothing changes
  assert.equal(c.zoom, 4);
  near(c.x, x);
  near(c.y, y);
  c.minZoom = 0.25;
  c.zoomAt(0, 0, 1e-9);
  assert.equal(c.zoom, 0.25);
});

test('panBy moves by CSS pixels, converted to points at the current zoom', () => {
  const c = new Camera();
  c.panBy(96, -48);
  near(c.x, 72);
  near(c.y, -36);
  c.zoom = 2;
  c.panBy(96, 0);
  near(c.x, 72 + 36);
  c.panBy(0, 0);
  near(c.y, -36);
});

test('fit shows the whole rectangle, centred, limited by the tighter axis', () => {
  const c = new Camera();
  // A wide box in a square view: width limits.
  c.fit({ x: 10, y: 20, width: 200, height: 50 }, 448, 448, 24);
  near(c.zoom, (448 - 48) / (200 * CSS_PX_PER_POINT));
  const topLeft = c.toDocument(0, 0);
  const bottomRight = c.toDocument(448, 448);
  near((topLeft.x + bottomRight.x) / 2, 110);
  near((topLeft.y + bottomRight.y) / 2, 45);
  assert.ok(topLeft.x < 10 && bottomRight.x > 210);
  // A tall box: height limits.
  c.fit({ x: 0, y: 0, width: 50, height: 200 }, 448, 448, 0);
  near(c.zoom, 448 / (200 * CSS_PX_PER_POINT));
});

test('fit respects the zoom limits, and default padding is 24 px', () => {
  const c = new Camera();
  c.maxZoom = 1;
  c.fit({ x: 0, y: 0, width: 10, height: 10 }, 1000, 1000);
  assert.equal(c.zoom, 1);
  c.minZoom = 0.5;
  c.fit({ x: 0, y: 0, width: 1e6, height: 1e6 }, 1000, 1000);
  assert.equal(c.zoom, 0.5);
  const d = new Camera();
  d.fit({ x: 0, y: 0, width: 100, height: 100 }, 300, 300);
  near(d.zoom, (300 - 48) / (100 * CSS_PX_PER_POINT));
});

test('clamp keeps the view within the content plus padding', () => {
  const bounds = { x: 0, y: 0, width: 1000, height: 2000 };
  const c = new Camera(); // 400x300 CSS px view = 300x225 points at 100%
  c.x = -500;
  c.y = -500;
  c.clamp(bounds, 400, 300, 24);
  near(c.x, -18); // 24 CSS px = 18 points of margin
  near(c.y, -18);
  c.x = 5000;
  c.y = 5000;
  c.clamp(bounds, 400, 300, 24);
  near(c.x, 1000 + 18 - 300);
  near(c.y, 2000 + 18 - 225);
  c.x = 200;
  c.y = 300;
  c.clamp(bounds, 400, 300, 24);
  assert.deepEqual([c.x, c.y], [200, 300], 'inside: untouched');
});

test('clamp centres a document smaller than the view, per axis', () => {
  const c = new Camera();
  c.x = 999;
  c.y = 999;
  // 100x100 points in an 800x600 CSS view (600x450 points): centred on both axes.
  c.clamp({ x: 0, y: 0, width: 100, height: 100 }, 800, 600, 24);
  near(c.x, 50 - 300);
  near(c.y, 50 - 225);
  // Wide in x only.
  const d = new Camera();
  d.x = 999;
  d.y = 9999;
  d.clamp({ x: 0, y: 0, width: 100, height: 5000 }, 800, 600, 0);
  near(d.x, 50 - 300);
  near(d.y, 5000 - 450);
});

test('clampToStart keeps text at the top-left corner, with padding only past its end', () => {
  const c = new Camera(); // 400x300 CSS px view = 300x225 points at 100%
  // Text shorter and narrower than the view sits at its start, not in the middle.
  c.x = -500;
  c.y = 999;
  c.clampToStart({ x: 0, y: 0, width: 100, height: 100 }, 400, 300, 24);
  assert.deepEqual([c.x, c.y], [0, 0]);
  // Nothing before the start is shown, even with padding; the end may be scrolled 24 CSS px (18 points) past.
  const bounds = { x: 0, y: -10, width: 1000, height: 2000 };
  c.x = -50;
  c.y = -50;
  c.clampToStart(bounds, 400, 300, 24);
  assert.deepEqual([c.x, c.y], [0, -10]);
  c.x = 5000;
  c.y = 5000;
  c.clampToStart(bounds, 400, 300, 24);
  near(c.x, 1000 + 18 - 300);
  near(c.y, -10 + 2000 + 18 - 225);
});

test('clamp ignores empty bounds and follows the zoom', () => {
  const c = new Camera();
  c.x = 77;
  c.clamp({ x: 0, y: 0, width: 0, height: 100 }, 100, 100);
  c.clamp({ x: 0, y: 0, width: 100, height: -1 }, 100, 100);
  assert.equal(c.x, 77);
  c.zoom = 2; // a 400 px view is 150 points, padding 12 px = 4.5 points
  c.x = -1000;
  c.clamp({ x: 0, y: 0, width: 1000, height: 1000 }, 400, 400, 12);
  near(c.x, -(12 / (2 * CSS_PX_PER_POINT)));
});

test('scrollPastEnd lets the view run half a screen past the end, and is off by default', () => {
  const c = new Camera();
  const bounds = { x: 0, y: 0, width: 600, height: 5000 };
  const pointsPerCss = 1 / (c.zoom * CSS_PX_PER_POINT);
  const view = 800 * pointsPerCss;
  c.y = 1e9;
  c.clamp(bounds, 800, 800);
  near(c.y, 5000 + 24 * pointsPerCss - view);
  c.scrollPastEnd = true;
  c.y = 1e9;
  c.clamp(bounds, 800, 800);
  near(c.y, 5000 + 24 * pointsPerCss - view / 2);
  c.y = -1e9;
  c.clamp(bounds, 800, 800);
  near(c.y, -24 * pointsPerCss);
});

test('scrollPastEnd also applies to text that starts at the top-left corner', () => {
  const c = new Camera();
  c.scrollPastEnd = true;
  const pointsPerCss = 1 / (c.zoom * CSS_PX_PER_POINT);
  c.y = 1e9;
  c.clampToStart({ x: 0, y: 0, width: 600, height: 5000 }, 800, 800);
  near(c.y, 5000 + 24 * pointsPerCss - 400 * pointsPerCss);
});
