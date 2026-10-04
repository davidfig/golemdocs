// The maths of drawing on a picture (src/formats/imageDraw.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrowHead, bubbleGeometry, constrainEnd, contrastOn, hitShape, nextStepNumber, lineWidth, paintShape } from '../src/formats/imageDraw.ts';
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
  // A rectangle is traced as a path (so a brush can run along it too), then stroked.
  assert.ok(calls.includes('lineTo2') && calls.includes('closePath0') && calls.includes('stroke0'));
  calls.length = 0;
  paintShape(ctx, shape('ellipse', [0, 0], [10, 5]));
  assert.ok(calls.includes('bezierCurveTo6') && calls.includes('stroke0'));
  calls.length = 0;
  paintShape(ctx, shape('pen', [4, 4]));
  assert.ok(calls.includes('arc5') && calls.includes('fill0'));
  calls.length = 0;
  paintShape(ctx, shape('arrow', [0, 0], [30, 0]));
  assert.ok(calls.includes('fill0') && calls.filter((c) => c === 'lineTo2').length >= 3);
});

test('a pen stroke drawn with pressure is filled as an outline of varying width, not stroked', () => {
  const calls: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, name: string) => (name in target ? target[name] : (...args: unknown[]) => void calls.push(`${name}${args.length}`)),
    set: (target, name: string, value) => ((target[name] = value), true),
  }) as unknown as CanvasRenderingContext2D;
  const points = [{ x: 0, y: 0 }, { x: 20, y: 5 }, { x: 40, y: 0 }];
  paintShape(ctx, { tool: 'pen', color: '#f00', width: 3, points });
  assert.ok(calls.includes('stroke0') && !calls.includes('fill0'));
  calls.length = 0;
  paintShape(ctx, { tool: 'pen', color: '#f00', width: 3, points, pressures: [0.2, 0.9, 0.4] });
  assert.ok(calls.includes('fill0') && !calls.includes('stroke0'));
  // Another stroke style picked (dashes) wins over the pressure.
  calls.length = 0;
  paintShape(ctx, { tool: 'pen', color: '#f00', width: 3, points, pressures: [0.2, 0.9, 0.4], stroke: 'dash:dashed' });
  assert.ok(calls.includes('stroke0'));
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

test('a bubble sits above the point it speaks about, or below it when there is no room', () => {
  const bubble = (y: number): Shape => ({ tool: 'bubble', color: '#000', width: 4, points: [{ x: 100, y }], text: 'Hi' });
  const above = bubbleGeometry(bubble(200), 40);
  assert.ok(!above.below && above.y + above.height < 200);
  const near = bubbleGeometry(bubble(10), 40);
  assert.ok(near.below && near.y > 10);
  assert.ok(above.base[0] >= above.x && above.base[1] <= above.x + above.width);
});

test('step markers are numbered one after the highest, and the eraser can find them', () => {
  const step = (n: number): Shape => ({ tool: 'step', color: '#f00', width: 4, points: [{ x: 50, y: 50 }], text: String(n) });
  assert.equal(nextStepNumber([]), 1);
  assert.equal(nextStepNumber([step(1), step(3), { ...step(9), tool: 'pen' }]), 4);
  assert.ok(hitShape(step(1), { x: 60, y: 50 }, 0));
  assert.ok(!hitShape(step(1), { x: 200, y: 50 }, 0));
  assert.ok(hitShape({ tool: 'bubble', color: '#000', width: 4, points: [{ x: 100, y: 200 }], text: 'Hello' }, { x: 100, y: 170 }, 0));
});

test('a marker number is black on light colours and white on dark ones', () => {
  assert.equal(contrastOn('#ffff00'), '#000');
  assert.equal(contrastOn('#e5322d'), '#fff');
  assert.equal(contrastOn('red'), '#fff');
});

import { DEFAULT_DRAW_STYLE, fillShape, paintOf, styleFields } from '../src/formats/imageDraw.ts';
import { boundsOf, hitShapeIn } from '../src/formats/imageLayers.ts';

test('a ready-made shape is hit inside when filled and on its outline when not', () => {
  const triangle: Shape = { tool: 'shape', shape: 'triangle', color: '#000', width: 2, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] };
  assert.equal(hitShape(triangle, { x: 50, y: 60 }, 2), false);
  assert.equal(hitShape({ ...triangle, fill: true }, { x: 50, y: 60 }, 2), true);
  // The top corners of the box are outside a triangle.
  assert.equal(hitShape({ ...triangle, fill: true }, { x: 2, y: 2 }, 1), false);
  assert.equal(hitShape(triangle, { x: 50, y: 100 }, 2), true);
});

test('the eyedropper and the bucket draw nothing', () => {
  const calls: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, { get: (t, n: string) => (n in t ? t[n] : () => void calls.push(n)), set: (t, n: string, v) => ((t[n] = v), true) }) as unknown as CanvasRenderingContext2D;
  for (const tool of ['eyedropper', 'bucket', 'group'] as const) paintShape(ctx, { tool, color: '#000', width: 2, points: [{ x: 1, y: 1 }] });
  assert.deepEqual(calls.filter((c) => c !== 'save' && c !== 'restore'), []);
});

test('filled shapes with a gradient, a dash and an opacity are painted with them', () => {
  const calls: string[] = [];
  const stops: string[] = [];
  const ctx = new Proxy({ globalAlpha: 1 } as Record<string, unknown>, {
    get: (t, n: string) => (n in t ? t[n] : n === 'createLinearGradient' ? () => ({ addColorStop: (_o: number, c: string) => void stops.push(c) }) : (...a: unknown[]) => void calls.push(`${n}${JSON.stringify(a)}`)),
    set: (t, n: string, v) => ((t[n] = v), true),
  }) as unknown as CanvasRenderingContext2D;
  paintShape(ctx, { tool: 'rectangle', color: '#f00', width: 2, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], fill: true, fillColor: '#00f', gradient: { type: 'linear', to: '#fff', angle: 0 }, stroke: 'dash:dashed', opacity: 0.5 });
  assert.deepEqual(stops, ['#00f', '#fff']);
  assert.ok(calls.includes('setLineDash[[8,6]]'));
  assert.ok(calls.includes('fill[]') && calls.includes('stroke[]'));
  calls.length = 0;
  paintShape(ctx, { tool: 'rectangle', color: '#f00', width: 2, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], fill: true, noStroke: true });
  assert.ok(calls.includes('fill[]') && !calls.includes('stroke[]'));
});

test('a new shape takes only what differs from the defaults, from the style', () => {
  assert.deepEqual(styleFields(DEFAULT_DRAW_STYLE, 'rectangle'), {});
  const style = { ...DEFAULT_DRAW_STYLE, fill: true, fillColor: '#123456', fillType: 'radial' as const, opacity: 40, strokeStyle: 'dash:dotted', noStroke: true, shape: 'heart' as const };
  assert.deepEqual(styleFields(style, 'shape'), { opacity: 0.4, stroke: 'dash:dotted', fill: true, fillColor: '#123456', gradient: { type: 'radial', to: '#ffffff', angle: 90 }, noStroke: true, shape: 'heart' });
  // A pen stroke has no fill or shape; text is neither dashed nor outlined.
  assert.deepEqual(styleFields(style, 'pen'), { opacity: 0.4, stroke: 'dash:dotted' });
  assert.deepEqual(styleFields(style, 'text'), { opacity: 0.4 });
  assert.deepEqual(paintOf({ ...DEFAULT_DRAW_STYLE, fillType: 'linear', fillColor: '#00f' }), { color: '#00f', gradient: { type: 'linear', to: '#ffffff', angle: 90 } });
  assert.deepEqual(paintOf(DEFAULT_DRAW_STYLE), { color: '#e5322d' });
});

test('a brush draws the line as a filled outline instead of a stroke, and a plain dash still strokes', () => {
  const run = (stroke: string): string[] => {
    const calls: string[] = [];
    const ctx = new Proxy({ globalAlpha: 1 } as Record<string, unknown>, { get: (t, n: string) => (n in t ? t[n] : (...a: unknown[]) => void calls.push(n)), set: (t, n: string, v) => ((t[n] = v), true) }) as unknown as CanvasRenderingContext2D;
    paintShape(ctx, { tool: 'line', color: '#000', width: 6, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], stroke });
    return calls;
  };
  const brushed = run('brush:taperBoth');
  assert.ok(brushed.includes('fill') && !brushed.includes('stroke'));
  const dashed = run('dash:longDash');
  assert.ok(dashed.includes('stroke') && !dashed.includes('fill'));
  // A style that is not on the list draws a plain line.
  assert.ok(run('brush:nonsense').includes('stroke'));
});

test('the paint bucket makes a fill layer at a point with the fill paint, and it covers nothing until it has been drawn against a picture', () => {
  const fill = fillShape({ ...DEFAULT_DRAW_STYLE, fillColor: '#00f', fillType: 'linear', tolerance: 20, contiguous: false, opacity: 50 }, { x: 4, y: 5 });
  assert.deepEqual([fill.tool, fill.points, fill.fillColor, fill.gradient?.type, fill.tolerance, fill.contiguous, fill.opacity], ['fill', [{ x: 4, y: 5 }], '#00f', 'linear', 51, false, 0.5]);
  // Its region is found from the picture when it is painted, so before that nothing is hit and it has no box.
  assert.equal(hitShapeIn(fill, { x: 4, y: 5 }, 2), false);
  assert.deepEqual(boundsOf([fill], fill), { x: 4, y: 5, width: 0, height: 0 });
});
