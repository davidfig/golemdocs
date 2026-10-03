// The drawing's page: its size, view box and background (src/vector/canvas.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backgroundOf, fitCanvasToArtwork, resizeCanvas, setBackground, sizeText, BACKGROUND_ATTR } from '../src/vector/canvas.ts';
import { worldBounds } from '../src/vector/edit.ts';
import { readSvg } from '../src/vector/svgRead.ts';
import { writeSvg } from '../src/vector/svgWrite.ts';

const scene = () =>
  readSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">
  <rect id="a" x="100" y="50" width="100" height="50" fill="red"/>
  <circle id="b" cx="300" cy="120" r="30" fill="blue"/>
</svg>`);

test('keeping the shapes: the page shows more of the drawing, and shapes stay put at the same size', () => {
  const s = scene();
  resizeCanvas(s, 800, 300, 'keep');
  assert.deepEqual([s.width, s.height], [800, 300]);
  assert.deepEqual(s.viewBox, { x: 0, y: 0, width: 800, height: 300 });
  assert.deepEqual(worldBounds(s, [0]), { x: 100, y: 50, width: 100, height: 50 });
  resizeCanvas(s, 200, 100, 'keep');
  assert.deepEqual(s.viewBox, { x: 0, y: 0, width: 200, height: 100 });
});

test('scaling the shapes: they grow with the page, and stretch when its shape changes', () => {
  const s = scene();
  resizeCanvas(s, 800, 400, 'scale');
  assert.deepEqual(s.viewBox, { x: 0, y: 0, width: 800, height: 400 });
  assert.deepEqual(worldBounds(s, [0]), { x: 200, y: 100, width: 200, height: 100 });
  const t = scene();
  resizeCanvas(t, 800, 200, 'scale');
  assert.deepEqual(worldBounds(t, [0]), { x: 200, y: 50, width: 200, height: 50 });
  // And it is written as it is.
  assert.match(writeSvg(t), /width="800" height="200" viewBox="0 0 800 200"/);
});

test('sizes are held to what a page can be', () => {
  const s = scene();
  resizeCanvas(s, 0, 999999, 'keep');
  assert.deepEqual([s.width, s.height], [1, 20000]);
});

test('fitting to the artwork makes the page the box around the shapes, plus a margin, at the same scale', () => {
  const s = scene();
  assert.equal(fitCanvasToArtwork(s, 10), true);
  // The shapes span x 100 to 330, y 50 to 150.
  assert.deepEqual(s.viewBox, { x: 90, y: 40, width: 250, height: 120 });
  assert.deepEqual([s.width, s.height], [250, 120]);
  const empty = readSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>');
  assert.equal(fitCanvasToArtwork(empty), false);
  // At another scale (2 units per pixel) the page is in pixels, not units.
  const big = readSvg('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 200 200"><rect x="40" y="40" width="80" height="40"/></svg>');
  fitCanvasToArtwork(big, 0);
  assert.deepEqual([big.width, big.height], [40, 20]);
});

test('a background is a rectangle behind everything that follows the page', () => {
  const s = scene();
  assert.equal(backgroundOf(s), null);
  setBackground(s, '#ffffcc');
  assert.equal(backgroundOf(s), '#ffffcc');
  assert.equal(s.children.length, 3);
  assert.equal(s.children[0].attrs[BACKGROUND_ATTR], 'true');
  resizeCanvas(s, 800, 400, 'scale');
  const bg = s.children[0] as { width: number; height: number };
  assert.deepEqual([bg.width, bg.height], [800, 400]);
  // The other shapes were scaled, the background was not scaled twice.
  assert.deepEqual(worldBounds(s, [1]), { x: 200, y: 100, width: 200, height: 100 });
  fitCanvasToArtwork(s, 5);
  assert.deepEqual([(s.children[0] as { x: number }).x, (s.children[0] as { width: number }).width], [s.viewBox.x, s.viewBox.width]);
  setBackground(s, '#000000');
  assert.equal(s.children.length, 3, 'replaced, not added');
  setBackground(s, null);
  assert.equal(s.children.length, 2);
  assert.equal(backgroundOf(s), null);
  assert.equal(sizeText(scene()), '400 × 200');
});
