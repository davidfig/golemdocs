// The arithmetic of picture editing (src/formats/imagePixels.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adjustPixels, applyEffect, blurPixels, boxWithAspect, clampBox, resizedTo, tooBig } from '../src/formats/imagePixels.ts';

const px = (...rgba: number[]) => new Uint8ClampedArray(rgba);

test('no adjustment leaves pixels alone', () => {
  const data = px(10, 200, 30, 255);
  adjustPixels(data, { brightness: 0, contrast: 0, saturation: 0 });
  assert.deepEqual([...data], [10, 200, 30, 255]);
});

test('brightness lightens and darkens, clamped, and never touches alpha', () => {
  const up = px(100, 100, 100, 77, 250, 250, 250, 255);
  adjustPixels(up, { brightness: 20, contrast: 0, saturation: 0 });
  assert.deepEqual([...up], [151, 151, 151, 77, 255, 255, 255, 255]);
  const down = px(100, 100, 100, 255, 10, 10, 10, 255);
  adjustPixels(down, { brightness: -20, contrast: 0, saturation: 0 });
  assert.deepEqual([...down], [49, 49, 49, 255, 0, 0, 0, 255]);
});

test('contrast pushes values away from mid-grey', () => {
  const data = px(128, 128, 128, 255, 200, 200, 200, 255, 50, 50, 50, 255);
  adjustPixels(data, { brightness: 0, contrast: 50, saturation: 0 });
  assert.equal(data[0], 128);
  assert.ok(data[4] > 200);
  assert.ok(data[8] < 50);
});

test('minus 100 saturation is greyscale and plus 100 strengthens colour', () => {
  const grey = px(255, 0, 0, 255);
  adjustPixels(grey, { brightness: 0, contrast: 0, saturation: -100 });
  assert.equal(grey[0], grey[1]);
  assert.equal(grey[1], grey[2]);
  assert.equal(grey[0], 76);
  const vivid = px(150, 100, 100, 255);
  adjustPixels(vivid, { brightness: 0, contrast: 0, saturation: 100 });
  assert.ok(vivid[0] - vivid[1] > 50);
});

test('crop boxes stay inside the picture, in whole pixels', () => {
  assert.deepEqual(clampBox({ x: -5, y: 10.4, width: 500, height: 20.6 }, 100, 80), { x: 0, y: 10, width: 100, height: 21 });
  assert.deepEqual(clampBox({ x: 99, y: 79, width: 50, height: 50 }, 100, 80), { x: 99, y: 79, width: 1, height: 1 });
});

test('a box takes on a fixed shape inside itself', () => {
  assert.deepEqual(boxWithAspect({ x: 0, y: 0, width: 400, height: 300 }, 1), { x: 50, y: 0, width: 300, height: 300 });
  assert.deepEqual(boxWithAspect({ x: 10, y: 20, width: 400, height: 300 }, 2, 'topLeft'), { x: 10, y: 20, width: 400, height: 200 });
  assert.deepEqual(boxWithAspect({ x: 0, y: 0, width: 100, height: 400 }, 0.5), { x: 0, y: 100, width: 100, height: 200 });
});

test('resizing keeps the picture\'s shape on request', () => {
  assert.deepEqual(resizedTo(400, 300, { width: 200 }, true), { width: 200, height: 150 });
  assert.deepEqual(resizedTo(400, 300, { height: 100 }, true), { width: 133, height: 100 });
  assert.deepEqual(resizedTo(400, 300, { width: 200 }, false), { width: 200, height: 300 });
  assert.deepEqual(resizedTo(400, 300, { width: 0 }, false), { width: 1, height: 300 });
});

test('pictures beyond what a canvas can hold are refused', () => {
  assert.equal(tooBig(4000, 3000), false);
  assert.equal(tooBig(20000, 100), true);
  assert.equal(tooBig(12000, 12000), true);
});

test('dragging a crop handle moves that edge only, within the picture and above the minimum', async () => {
  const { dragBox } = await import('../src/formats/imagePixels.ts');
  const bounds = { width: 400, height: 300 };
  const start = { x: 100, y: 100, width: 100, height: 100 };
  assert.deepEqual(dragBox(start, 'e', 50, 999, bounds, null), { x: 100, y: 100, width: 150, height: 100 });
  assert.deepEqual(dragBox(start, 'w', -500, 0, bounds, null), { x: 0, y: 100, width: 200, height: 100 });
  assert.deepEqual(dragBox(start, 'n', 0, 500, bounds, null, 8), { x: 100, y: 192, width: 100, height: 8 });
  assert.deepEqual(dragBox(start, 'se', 1000, 1000, bounds, null), { x: 100, y: 100, width: 300, height: 200 });
  assert.deepEqual(dragBox(start, 'move', -500, 500, bounds, null), { x: 0, y: 200, width: 100, height: 100 });
});

test('with a fixed shape a crop box keeps it while a handle is dragged', async () => {
  const { dragBox } = await import('../src/formats/imagePixels.ts');
  const bounds = { width: 400, height: 300 };
  const start = { x: 100, y: 100, width: 100, height: 50 };
  const east = dragBox(start, 'e', 40, 0, bounds, 2);
  assert.deepEqual([east.width, east.height, east.x], [140, 70, 100]);
  assert.equal(east.y + east.height / 2, 125);
  const corner = dragBox(start, 'se', 60, 5, bounds, 2);
  assert.deepEqual([corner.x, corner.y, corner.width, corner.height], [100, 100, 160, 80]);
  const nw = dragBox(start, 'nw', -200, -10, bounds, 2);
  assert.equal(nw.x + nw.width, 200);
  assert.equal(nw.y + nw.height, 150);
  assert.ok(nw.x >= 0 && nw.y >= 0);
  assert.equal(Math.round((nw.width / nw.height) * 100), 200);
});

test('grayscale, invert and sepia change colour but keep alpha', () => {
  const grey = px(255, 0, 0, 90);
  applyEffect(grey, 1, 1, 'grayscale');
  assert.deepEqual([...grey], [76, 76, 76, 90]);
  const inverted = px(10, 200, 30, 128);
  applyEffect(inverted, 1, 1, 'invert');
  assert.deepEqual([...inverted], [245, 55, 225, 128]);
  const sepia = px(255, 255, 255, 255);
  applyEffect(sepia, 1, 1, 'sepia');
  assert.deepEqual([...sepia], [255, 255, 239, 255]);
});

test('blur spreads a bright pixel to its neighbours and keeps a flat picture flat', () => {
  const dot = px(0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255);
  blurPixels(dot, 3, 1, 1);
  assert.ok(dot[0] > 0 && dot[8] > 0 && dot[4] < 255);
  const flat = px(50, 60, 70, 255, 50, 60, 70, 255, 50, 60, 70, 255, 50, 60, 70, 255);
  blurPixels(flat, 2, 2, 1);
  assert.deepEqual([...flat], [50, 60, 70, 255, 50, 60, 70, 255, 50, 60, 70, 255, 50, 60, 70, 255]);
});

test('auto levels stretches a dull picture to the full range', () => {
  const data = px(100, 100, 100, 255, 150, 150, 150, 255);
  applyEffect(data, 2, 1, 'autoLevels');
  assert.deepEqual([...data], [0, 0, 0, 255, 255, 255, 255, 255]);
});

test('sharpen leaves a flat picture alone and exaggerates an edge', () => {
  const flat = px(80, 80, 80, 255, 80, 80, 80, 255, 80, 80, 80, 255);
  applyEffect(flat, 3, 1, 'sharpen');
  assert.deepEqual([...flat], [80, 80, 80, 255, 80, 80, 80, 255, 80, 80, 80, 255]);
  const edge = px(100, 100, 100, 255, 100, 100, 100, 255, 200, 200, 200, 255, 200, 200, 200, 255);
  applyEffect(edge, 4, 1, 'sharpen');
  assert.ok(edge[4] < 100 && edge[8] > 200);
});

test('pages stacked in one picture: full scale when they fit, smaller when they must, fewer pages when even that is not enough', async () => {
  const { pictureLayout, PAGE_GAP_POINTS } = await import('../src/thumbnail.ts');
  const letter = { width: 612, height: 792 };
  const limits = { side: 16384, pixels: 100_000_000 };
  // One page, at 2 pixels per point.
  assert.deepEqual(pictureLayout([letter], limits), { scale: 2, count: 1, width: 1224, height: 1584 });
  // Three pages: the gaps between them are grey space in the picture.
  const three = pictureLayout([letter, letter, letter], limits);
  assert.equal(three.count, 3);
  assert.equal(three.height, Math.ceil((792 * 3 + PAGE_GAP_POINTS * 2) * 2));
  // Twenty pages would be 32,000 pixels tall at full scale: smaller, but all of them.
  const many = pictureLayout(Array(20).fill(letter), limits);
  assert.equal(many.count, 20);
  assert.ok(many.scale < 2 && many.scale >= 0.5 && many.height <= 16384);
  // Two hundred pages don't fit even at a quarter scale: as many as do.
  const lots = pictureLayout(Array(200).fill(letter), limits);
  assert.ok(lots.count < 200 && lots.count >= 1 && lots.scale >= 0.5 - 1e-9 && lots.height <= 16384);
  assert.equal(pictureLayout([], limits).count, 1);
});
