// The maths of drawing on a picture (src/formats/imageDraw.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrowHead, constrainEnd, hitShape, lineWidth, paintShape } from '../src/formats/imageDraw.ts';
import type { Shape } from '../src/formats/imageDraw.ts';

test('line thickness grows with the step and the picture, and is never under 2 pixels', () => {
  assert.equal(lineWidth(0, 100, 80), 2);
  assert.equal(lineWidth(1, 2000, 1000), 12);
  assert.ok(lineWidth(3, 2000, 1000) > lineWidth(2, 2000, 1000));
  assert.equal(lineWidth(99, 1000, 1000), lineWidth(3, 1000, 1000));
});

test('shift snaps a line to 45° steps and a box to a square', () => {
  const start = { x: 10, y: 10 };
  const line = constrainEnd('line', start, { x: 50, y: 14 });
  assert.ok(Math.abs(line.y - 10) < 1e-9 && Math.abs(line.x - (10 + Math.hypot(40, 4))) < 1e-9);
  const diagonal = constrainEnd('arrow', start, { x: 40, y: 34 });
  assert.ok(Math.abs(diagonal.x - 10 - (diagonal.y - 10)) < 1e-9);
  assert.deepEqual(constrainEnd('rectangle', start, { x: 30, y: -50 }), { x: 70, y: -50 });
  assert.deepEqual(constrainEnd('pen', start, { x: 1, y: 2 }), { x: 1, y: 2 });
});

test('an arrow head sits behind its tip, both sides equally', () => {
  const [a, b] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 4);
  assert.ok(a.x < 100 && b.x < 100);
  assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y + b.y) < 1e-9 && a.y !== b.y);
});

test('shapes are painted with the calls their tool needs', () => {
  const calls: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, name: string) => (name in target ? target[name] : (...args: unknown[]) => void calls.push(`${name}${args.length}`)),
    set: (target, name: string, value) => ((target[name] = value), true),
  }) as unknown as CanvasRenderingContext2D;
  const shape = (tool: Shape['tool'], ...points: [number, number][]): Shape => ({ tool, color: '#f00', width: 3, points: points.map(([x, y]) => ({ x, y })) });
  paintShape(ctx, shape('rectangle', [0, 0], [10, 5]));
  assert.ok(calls.includes('rect4') && calls.includes('stroke0'));
  calls.length = 0;
  paintShape(ctx, shape('ellipse', [0, 0], [10, 5]));
  assert.ok(calls.includes('ellipse7'));
  calls.length = 0;
  paintShape(ctx, shape('pen', [4, 4]));
  assert.ok(calls.includes('arc5') && calls.includes('fill0'));
  calls.length = 0;
  paintShape(ctx, shape('arrow', [0, 0], [30, 0]));
  assert.ok(calls.includes('fill0') && calls.filter((c) => c === 'lineTo2').length >= 3);
});

test('the eraser finds strokes and shapes where they are drawn, and misses elsewhere', () => {
  const shape = (tool: Shape['tool'], points: [number, number][], extra: Partial<Shape> = {}): Shape => ({ tool, color: '#000', width: 4, points: points.map(([x, y]) => ({ x, y })), ...extra });
  const pen = shape('pen', [[0, 0], [100, 0]]);
  assert.ok(hitShape(pen, { x: 50, y: 3 }, 2));
  assert.ok(!hitShape(pen, { x: 50, y: 30 }, 2));
  const outline = shape('rectangle', [[10, 10], [110, 60]]);
  assert.ok(hitShape(outline, { x: 60, y: 10 }, 2));
  assert.ok(!hitShape(outline, { x: 60, y: 35 }, 2));
  assert.ok(hitShape({ ...outline, fill: true }, { x: 60, y: 35 }, 2));
  const ring = shape('ellipse', [[0, 0], [100, 60]]);
  assert.ok(hitShape(ring, { x: 50, y: 0 }, 2));
  assert.ok(!hitShape(ring, { x: 50, y: 30 }, 2));
  assert.ok(hitShape(shape('pixelate', [[0, 0], [20, 20]]), { x: 10, y: 10 }, 0));
  const words = shape('text', [[5, 5]], { text: 'Hi' });
  assert.ok(hitShape(words, { x: 10, y: 10 }, 0));
  assert.ok(!hitShape(words, { x: 200, y: 10 }, 0));
});
