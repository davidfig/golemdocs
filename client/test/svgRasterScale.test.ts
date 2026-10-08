// How sharp a drawing's texture is made: sizes in steps, within the texture limits, and when it is drawn again.
// Run: node --experimental-transform-types --test test/svgRasterScale.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { svgNeedsRedraw, svgRasterScale } from '../src/webgl/shapes/imageRenderer.ts';

test('the size is the next step up from what is needed, steps a factor of root two apart', () => {
  assert.equal(svgRasterScale(1, 200, 100), 1);
  assert.equal(svgRasterScale(1.2, 200, 100), Math.SQRT2);
  assert.equal(svgRasterScale(1.5, 200, 100), 2);
  assert.equal(svgRasterScale(2, 200, 100), 2);
  assert.ok(Math.abs(svgRasterScale(1.3333, 200, 100) - Math.SQRT2) < 1e-9);
});

test('it is never below a quarter pixel per point, and never above what the texture limits allow', () => {
  assert.equal(svgRasterScale(0.01, 200, 100), 0.25);
  // 4096 pixels on the longer side.
  assert.equal(svgRasterScale(100, 200, 100), 4096 / 200);
  // 12 million pixels in all, for a drawing that is square.
  assert.ok(Math.abs(svgRasterScale(1000, 1000, 1000, 100_000, 12_000_000) - Math.sqrt(12)) < 1e-9);
  assert.equal(svgRasterScale(1000, 100, 100, 1024, 1e9), 10.24);
});

test('a texture is drawn again for more detail or far less memory, but not for a small change, nor when it is as sharp as it can be', () => {
  const limit = svgRasterScale(Infinity, 200, 100);
  // Zoomed in past it: more detail.
  assert.equal(svgNeedsRedraw(1, 2, limit), true);
  // Zoomed in a little: still within the step.
  assert.equal(svgNeedsRedraw(Math.SQRT2, svgRasterScale(1.3, 200, 100), limit), false);
  // Zoomed out a lot: smaller is enough.
  assert.equal(svgNeedsRedraw(8, 1, limit), true);
  // Zoomed out a little: keep it.
  assert.equal(svgNeedsRedraw(2, 1.5, limit), false);
  // Already as sharp as the limits allow, however far in it is shown.
  assert.equal(svgNeedsRedraw(limit, limit, limit), false);
});
