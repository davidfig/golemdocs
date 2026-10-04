// What the assistant can do with the shapes drawn over a picture (src/assistant/pictureLayerTools.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Shape } from '../src/formats/imageDraw.ts';
import { describeLayers, drawnShape, layerOp } from '../src/assistant/pictureLayerTools.ts';

const size = { width: 400, height: 300 };
const run = (op: string, args: Record<string, unknown>, shapes: readonly Shape[]) => layerOp(op, args, shapes, size);

test('draw makes a shape with the options it is given, and nothing it was not', () => {
  const plain = drawnShape({ tool: 'rectangle', x: 10, y: 20, to_x: 110, to_y: 90 }, size, []);
  assert.equal(plain.fill, undefined);
  assert.equal(plain.opacity, undefined);
  const full = drawnShape({ tool: 'shape', shape: 'heart', x: 10, y: 20, to_x: 110, to_y: 90, fill_color: '#112233', gradient_to: '#ffffff', gradient_type: 'radial', opacity: 50, stroke_style: 'brush:chalk', no_stroke: true }, size, []);
  assert.deepEqual([full.shape, full.fill, full.fillColor, full.gradient, full.opacity, full.stroke, full.noStroke], ['heart', true, '#112233', { type: 'radial', to: '#ffffff', angle: 90 }, 0.5, 'brush:chalk', true]);
  assert.throws(() => drawnShape({ tool: 'line', x: 0, y: 0, to_x: 1, to_y: 1, stroke_style: 'brush:nope' }, size, []), /stroke_style/);
  assert.throws(() => drawnShape({ tool: 'shape', shape: 'blob', x: 0, y: 0, to_x: 1, to_y: 1 }, size, []), /shape/);
  assert.throws(() => drawnShape({ tool: 'line', x: 0, y: 0, to_x: 1, to_y: 1, color: 'red' }, size, []), /#e53935/);
  assert.throws(() => drawnShape({ tool: 'line', x: 0, y: 0, to_x: 1000, to_y: 1 }, size, []), /to_x/);
});

test('the brushes that change pixels are drawn as strokes with a strength', () => {
  const smudge = drawnShape({ tool: 'smudge', x: 10, y: 10, to_x: 100, to_y: 10, strength: 70 }, size, []);
  assert.deepEqual([smudge.tool, smudge.strength, smudge.fill], ['smudge', 70, undefined]);
  assert.equal(drawnShape({ tool: 'mixer', x: 0, y: 0, to_x: 5, to_y: 5, color: '#112233' }, size, []).strength, 50);
  assert.throws(() => drawnShape({ tool: 'burn', x: 0, y: 0, to_x: 5, to_y: 5, strength: 200 }, size, []), /strength/);
});

test('layers are made, filled, listed as a tree, hidden and put in order', () => {
  let shapes: Shape[] = [];
  shapes = run('new_layer', { name: 'Sky' }, shapes).shapes;
  shapes = run('draw', { tool: 'ellipse', x: 0, y: 0, to_x: 50, to_y: 50, layer: 0 }, shapes).shapes;
  shapes = run('draw', { tool: 'line', x: 0, y: 0, to_x: 50, to_y: 50 }, shapes).shapes;
  assert.equal(shapes[1].parent, shapes[0].id);
  assert.equal(shapes[2].parent, undefined);
  const listed = describeLayers(shapes).split('\n');
  assert.match(listed[0], /^0: group "Sky"/);
  assert.match(listed[1], /^ {2}1: ellipse/);
  assert.match(listed[2], /^2: line/);

  shapes = run('hide_layer', { number: 0 }, shapes).shapes;
  assert.match(describeLayers(shapes), /hidden by its group/);
  shapes = run('show_layer', { number: 0 }, shapes).shapes;
  assert.equal(shapes[0].hidden, undefined);

  shapes = run('set_layer', { number: 0, opacity: 40, blend: 'multiply' }, shapes).shapes;
  assert.deepEqual([shapes[0].opacity, shapes[0].blend], [0.4, 'multiply']);
  shapes = run('set_layer', { number: 0, opacity: 100, blend: 'normal' }, shapes).shapes;
  assert.deepEqual([shapes[0].opacity, shapes[0].blend], [undefined, undefined]);

  const ordered = run('order_layer', { number: 0, to: 'front' }, shapes).shapes;
  // The group, with what is in it, is now over the line.
  assert.deepEqual(ordered.filter((s) => !s.parent).map((s) => s.tool), ['line', 'group']);
  assert.match(run('order_layer', { number: 2, to: 'front' }, shapes).message, /already/);
});

test('erasing or moving a group takes what is in it along', () => {
  let shapes: Shape[] = run('new_layer', { name: 'G' }, []).shapes;
  shapes = run('draw', { tool: 'rectangle', x: 10, y: 10, to_x: 20, to_y: 20, layer: 0 }, shapes).shapes;
  const moved = run('move_shape', { number: 0, dx: 5, dy: 6 }, shapes).shapes;
  assert.deepEqual(moved[1].points[0], { x: 15, y: 16 });
  assert.deepEqual(run('erase_shape', { number: 0 }, shapes).shapes, []);
});

test('grouping, ungrouping and copying work from the numbers layers prints', () => {
  let shapes: Shape[] = [];
  for (const x of [0, 10]) shapes = run('draw', { tool: 'rectangle', x, y: 0, to_x: x + 5, to_y: 5 }, shapes).shapes;
  shapes = run('group', { numbers: [0, 1], name: 'Both' }, shapes).shapes;
  const group = shapes.find((s) => s.tool === 'group')!;
  assert.equal(group.name, 'Both');
  assert.equal(shapes.filter((s) => s.parent === group.id).length, 2);
  const copied = run('duplicate_layer', { number: shapes.indexOf(group) }, shapes).shapes;
  assert.equal(copied.length, 6);
  assert.equal(run('ungroup', { number: shapes.indexOf(group) }, shapes).shapes.some((s) => s.parent), false);
  assert.throws(() => run('ungroup', { number: 0 }, shapes.filter((s) => s.tool !== 'group').map((s) => ({ ...s, parent: undefined }))), /not a group/);
  assert.throws(() => run('group', { numbers: [9] }, shapes), /numbers/);
  assert.throws(() => run('erase_shape', { number: 0 }, []), /no shapes/);
  assert.throws(() => run('nonsense', {}, shapes), /op/);
});
