import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeTip } from '../src/ui/tooltipPlacement.ts';

const tip = { width: 100, height: 30 };
const viewport = { width: 800, height: 600 };

test('a tip for an element is centered below it', () => {
  const { left, top } = placeTip(tip, { left: 200, top: 100, width: 40, height: 20 }, viewport);
  assert.equal(left, 170);
  assert.equal(top, 126);
});

test('a tip for an element near the bottom goes above it', () => {
  const { top } = placeTip(tip, { left: 200, top: 570, width: 40, height: 20 }, viewport);
  assert.equal(top, 534);
});

test('a tip stays inside the window at both sides', () => {
  assert.equal(placeTip(tip, { left: 0, top: 100, width: 10, height: 20 }, viewport).left, 4);
  assert.equal(placeTip(tip, { left: 790, top: 100, width: 10, height: 20 }, viewport).left, 696);
});

test('a tip at a point sits below and to the right of it, or above near the bottom', () => {
  assert.deepEqual(placeTip(tip, { x: 300, y: 100 }, viewport), { left: 312, top: 120 });
  assert.equal(placeTip(tip, { x: 300, y: 590 }, viewport).top, 554);
});

test('a tip taller than the room either side is pinned inside the window', () => {
  const { top } = placeTip({ width: 50, height: 80 }, { left: 10, top: 20, width: 10, height: 10 }, { width: 200, height: 100 });
  assert.equal(top, 16);
});
