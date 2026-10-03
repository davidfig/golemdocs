// The assistant's tools for vector drawings (src/assistant/drawingTools.ts), run against a recording stand-in for the editor.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeDrawing, editDrawing } from '../src/assistant/drawingTools.ts';
import type { DrawingEditor } from '../src/assistant/drawingTools.ts';
import type { NodePath } from '../src/vector/edit.ts';
import { readSvg } from '../src/vector/svgRead.ts';
import { TOOLS } from '../../server/src/assistantTools.ts';

const scene = () =>
  readSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
  <rect id="back" x="10" y="10" width="80" height="40" fill="#e44" stroke="#000" stroke-width="2"/>
  <circle cx="150" cy="50" r="30" fill="#0a0"/>
  <g><rect width="5" height="5"/><rect width="5" height="5"/></g>
  <text x="20" y="80" font-size="14">Hello <tspan>there</tspan></text>
</svg>`);

function recorder() {
  const s = scene();
  const calls: unknown[][] = [];
  let selection: NodePath[] = [];
  const record = (name: string) => (...args: unknown[]) => void calls.push([name, ...args, ...(['delete', 'duplicate', 'group', 'ungroup', 'order', 'transformSelection', 'applyStyle', 'applyStrokeStyle', 'applyFillType', 'makeClip', 'releaseClip'].includes(name) ? [selection.map((p) => p[0])] : [])]);
  const editor: DrawingEditor = {
    drawing: s,
    select: (paths) => void (selection = paths),
    delete: record('delete'),
    duplicate: record('duplicate'),
    group: record('group'),
    ungroup: record('ungroup'),
    order: record('order'),
    transformSelection: record('transformSelection'),
    applyStyle: record('applyStyle'),
    applyStrokeStyle: record('applyStrokeStyle'),
    applyFillType: record('applyFillType'),
    boolean: async (op) => void calls.push(['boolean', op, selection.map((p) => p[0])]),
    makeClip: record('makeClip'),
    releaseClip: record('releaseClip'),
    addShape: record('addShape'),
  };
  return { editor, calls };
}

test('the drawing is described as numbered shapes from back to front', () => {
  const text = describeDrawing(scene());
  const lines = text.split('\n');
  assert.match(lines[0], /^Drawing 200 x 100, coordinates from \(0, 0\) to \(200, 100\)/);
  assert.match(lines[1], /^0: rect "back" at x=10 y=10 width=80 height=40; fill #e44; stroke #000; stroke-width 2$/);
  assert.match(lines[2], /^1: circle at x=120 y=20 width=60 height=60; fill #0a0$/);
  assert.match(lines[3], /^2: group at .*; 2 shapes inside$/);
  assert.match(lines[4], /^3: text at .*; text "Hello there"$/);
  assert.match(describeDrawing(readSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>')), /\(nothing yet\)/);
});

test('shapes are added with the colors given, or the editor’s defaults', async () => {
  const { editor, calls } = recorder();
  const answer = await editDrawing(editor, { op: 'add_rect', x: 1, y: 2, width: 30, height: 20, fill: '#112233', stroke: 'none' });
  assert.match(answer, /Added a rectangle as shape 4/);
  const node = calls[0][1] as { kind: string; style: Record<string, string>; x: number };
  assert.deepEqual([node.kind, node.x, node.style.fill, node.style.stroke], ['rect', 1, '#112233', 'none']);
  await editDrawing(editor, { op: 'add_ellipse', x: 0, y: 0, width: 10, height: 10 });
  const ellipse = calls[1][1] as { cx: number; rx: number; style: Record<string, string> };
  assert.deepEqual([ellipse.cx, ellipse.rx, ellipse.style.fill, ellipse.style['stroke-width']], [5, 5, '#5b8def', '2']);
  await editDrawing(editor, { op: 'add_line', x: 0, y: 0, to_x: 10, to_y: 10, stroke: '#ff0000', stroke_width: 4 });
  assert.deepEqual((calls[2][1] as { commands: unknown[]; style: Record<string, string> }).style, { fill: 'none', stroke: '#ff0000', 'stroke-width': '4' });
  await editDrawing(editor, { op: 'add_path', d: 'M0 0 L10 0 L5 8 Z' });
  assert.equal((calls[3][1] as { commands: unknown[] }).commands.length, 4);
  await editDrawing(editor, { op: 'add_text', text: 'Hi', x: 5, y: 9, font_size: 12 });
  const text = calls[4][1] as { runs: { text: string }[]; style: Record<string, string> };
  assert.deepEqual([text.runs[0].text, text.style['font-size'], text.style.fill], ['Hi', '12', '#000000']);
});

test('changes act on the shapes named, with the same commands as the toolbar', async () => {
  const { editor, calls } = recorder();
  assert.match(await editDrawing(editor, { op: 'delete', shapes: [0, 2] }), /Deleted 2 shapes/);
  await editDrawing(editor, { op: 'order', shapes: [1], to: 'front' });
  await editDrawing(editor, { op: 'move', shapes: [1], dx: 5, dy: -5 });
  await editDrawing(editor, { op: 'scale', shapes: [0], sx: 2 });
  await editDrawing(editor, { op: 'rotate', shapes: [0], degrees: 90 });
  await editDrawing(editor, { op: 'style', shapes: [0], fill: '#00ff00', stroke_width: 6 });
  await editDrawing(editor, { op: 'stroke_style', shapes: [1], value: 'brush:taperBoth' });
  await editDrawing(editor, { op: 'fill_type', shapes: [0], type: 'linear' });
  await editDrawing(editor, { op: 'unite', shapes: [0, 1] });
  await editDrawing(editor, { op: 'make_clip', shapes: [0, 1] });
  assert.deepEqual(calls.map((c) => c[0]), ['delete', 'order', 'transformSelection', 'transformSelection', 'transformSelection', 'applyStyle', 'applyStrokeStyle', 'applyFillType', 'boolean', 'makeClip']);
  assert.deepEqual(calls[0].at(-1), [0, 2]);
  assert.deepEqual(calls[1].slice(1), ['front', [1]]);
  assert.deepEqual([...(calls[2][1] as number[])], [1, 0, 0, 1, 5, -5]);
  // Scaling is about the shape's top-left: (10, 10) stays where it is.
  assert.deepEqual([...(calls[3][1] as number[])], [2, 0, 0, 2, -10, -10]);
  assert.deepEqual(calls[5][1], { fill: '#00ff00', strokeWidth: 6 });
  assert.deepEqual(calls[6].slice(1), ['brush:taperBoth', [1]]);
});

test('a request that doesn’t make sense is refused, with what to do instead', async () => {
  const { editor, calls } = recorder();
  const fails = (args: Record<string, unknown>, message: RegExp) => assert.rejects(editDrawing(editor, args), message);
  await fails({ op: 'nonsense', shapes: [0] }, /`op` must be one of/);
  await fails({ op: 'delete' }, /`shapes` must list/);
  await fails({ op: 'delete', shapes: [9] }, /no shape 9/);
  await fails({ op: 'add_rect', x: 0, y: 0, width: 0, height: 5 }, /above 0/);
  await fails({ op: 'add_rect', x: 0, y: 0, width: 5, height: 5, fill: 'banana' }, /color/);
  await fails({ op: 'order', shapes: [0], to: 'sideways' }, /front, forward/);
  await fails({ op: 'stroke_style', shapes: [0], value: 'brush:nope' }, /`value` must be one of/);
  await fails({ op: 'unite', shapes: [0] }, /at least two/);
  await fails({ op: 'style', shapes: [0] }, /Say what to change/);
  await fails({ op: 'add_path', d: 'M0 0' }, /at least two points/);
  assert.deepEqual(calls, []);
  const closed = { ...editor, drawing: null };
  await assert.rejects(editDrawing(closed, { op: 'delete', shapes: [0] }), /not open/);
});

test('the model is told about both tools, with the stroke styles the editor offers', () => {
  const read = TOOLS.find((t) => t.name === 'read_drawing');
  const edit = TOOLS.find((t) => t.name === 'edit_drawing');
  assert.ok(read && edit);
  for (const style of ['taperBoth', 'calligraphic', 'dryBrush', 'confetti', 'arrowBoth', 'diamondEnd', 'dash:dashDot']) assert.match(edit!.description, new RegExp(style));
});
