// The layers of a picture: groups, order, hiding and locking, and the boxes of shapes (src/formats/imageLayers.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Shape } from '../src/formats/imageDraw.ts';
import {
  activeParent,
  boundsOf,
  boundsOfAll,
  childrenOf,
  descendantsOf,
  duplicateShapes,
  groupShapes,
  isHiddenIn,
  isLockedIn,
  moveLayer,
  newGroup,
  paintLayers,
  pickable,
  removeShapes,
  resizeBox,
  scaleShape,
  stepLayer,
  ungroupShape,
} from '../src/formats/imageLayers.ts';

const rect = (id: string, x: number, y: number, to: number, extra: Partial<Shape> = {}): Shape => ({ id, tool: 'rectangle', color: '#f00', width: 2, points: [{ x, y }, { x: to, y: to }], ...extra });
const ids = (shapes: readonly Shape[]): string[] => shapes.map((s) => s.id!);

test('a group is made of the shapes that name it as their parent', () => {
  const made = groupShapes([rect('a', 0, 0, 10), rect('b', 0, 0, 20), rect('c', 0, 0, 30)], ['a', 'c'], 'Pair');
  assert.ok(made);
  const group = made.shapes.find((s) => s.id === made.id)!;
  assert.equal(group.tool, 'group');
  assert.equal(group.name, 'Pair');
  assert.deepEqual(ids(childrenOf(made.shapes, made.id)), ['a', 'c']);
  assert.deepEqual(ids(childrenOf(made.shapes, undefined)).filter((id) => id !== made.id), ['b']);
});

test('hiding or locking a group reaches everything inside, however deep', () => {
  const outer = newGroup([], 'Outer');
  const inner = newGroup(outer.shapes, 'Inner', outer.id);
  const shapes = [...inner.shapes, rect('a', 0, 0, 10, { parent: inner.id })].map((s) => (s.id === outer.id ? { ...s, hidden: true, locked: true } : s));
  const a = shapes.find((s) => s.id === 'a')!;
  assert.ok(isHiddenIn(shapes, a));
  assert.ok(isLockedIn(shapes, a));
  assert.deepEqual(pickable(shapes), []);
  assert.deepEqual(ids(descendantsOf(shapes, outer.id)).sort(), [inner.id, 'a'].sort());
});

test('ungrouping puts the shapes in the group the group was in; deleting a group takes its shapes along', () => {
  const made = groupShapes([rect('a', 0, 0, 10), rect('b', 0, 0, 20)], ['a', 'b'], 'G')!;
  assert.deepEqual(ids(ungroupShape(made.shapes, made.id)), ['a', 'b']);
  assert.equal(ungroupShape(made.shapes, made.id).some((s) => s.parent), false);
  assert.deepEqual(removeShapes(made.shapes, [made.id]), []);
});

test('a copy of a group is a group of copies, each with a new id', () => {
  const made = groupShapes([rect('a', 0, 0, 10)], ['a'], 'G')!;
  const copy = duplicateShapes(made.shapes, [made.id], 5);
  assert.equal(copy.shapes.length, 4);
  const [newId] = copy.ids;
  assert.notEqual(newId, made.id);
  const inside = childrenOf(copy.shapes, newId);
  assert.equal(inside.length, 1);
  assert.notEqual(inside[0].id, 'a');
  assert.deepEqual(inside[0].points[0], { x: 5, y: 5 });
});

test('a layer is moved before, after or into another, and not into itself', () => {
  const g = newGroup([rect('a', 0, 0, 10), rect('b', 0, 0, 10)], 'G');
  const into = moveLayer(g.shapes, 'a', g.id, 'inside')!;
  assert.equal(into.find((s) => s.id === 'a')!.parent, g.id);
  const after = moveLayer(g.shapes, 'a', 'b', 'after')!;
  assert.deepEqual(ids(after).filter((id) => id !== g.id), ['b', 'a']);
  assert.equal(moveLayer(into, g.id, g.id, 'inside'), null);
  assert.equal(moveLayer(g.shapes, 'a', 'b', 'inside'), null);
  // A group can't go into what it holds.
  assert.equal(moveLayer(into, g.id, 'a', 'before'), null);
});

test('stepping forward or back changes order among the shapes of one group only', () => {
  const shapes = [rect('a', 0, 0, 1), rect('b', 0, 0, 1), rect('c', 0, 0, 1)];
  assert.deepEqual(ids(stepLayer(shapes, 'a', 'forward')!), ['b', 'a', 'c']);
  assert.deepEqual(ids(stepLayer(shapes, 'a', 'forward', true)!), ['b', 'c', 'a']);
  assert.equal(stepLayer(shapes, 'c', 'forward'), null);
  assert.deepEqual(ids(stepLayer(shapes, 'c', 'backward', true)!), ['c', 'a', 'b']);
});

test('new shapes go in the active group, unless it is gone or locked', () => {
  const g = newGroup([], 'G');
  assert.equal(activeParent(g.shapes, g.id), g.id);
  assert.equal(activeParent(g.shapes, 'missing'), undefined);
  assert.equal(activeParent(g.shapes.map((s) => ({ ...s, locked: true })), g.id), undefined);
  assert.equal(activeParent(g.shapes.map((s) => ({ ...s, hidden: true })), g.id), undefined, 'nor into a hidden one');
  assert.equal(activeParent(g.shapes, null), undefined);
});

test('the box of a shape, of a group and of several shapes', () => {
  const made = groupShapes([rect('a', 10, 10, 20, { width: 2 }), rect('b', 40, 40, 60, { width: 2 })], ['a', 'b'], 'G')!;
  assert.deepEqual(boundsOf(made.shapes, made.shapes.find((s) => s.id === 'a')!), { x: 9, y: 9, width: 12, height: 12 });
  const box = boundsOf(made.shapes, made.shapes.find((s) => s.id === made.id)!)!;
  assert.deepEqual([box.x, box.y, box.width, box.height], [9, 9, 52, 52]);
  assert.equal(boundsOf([], newGroup([], 'Empty').shapes[0]), null);
  assert.equal(boundsOfAll([], []), null);
});

test('scaling carries the points to the new box and grows a text with it', () => {
  const from = { x: 0, y: 0, width: 10, height: 10 };
  const scaled = scaleShape(rect('a', 0, 0, 10), from, { x: 100, y: 0, width: 20, height: 40 });
  assert.deepEqual(scaled.points, [{ x: 100, y: 0 }, { x: 120, y: 40 }]);
  const text = scaleShape({ id: 't', tool: 'text', color: '#000', width: 4, points: [{ x: 0, y: 0 }], text: 'Hi' }, from, { x: 0, y: 0, width: 20, height: 20 });
  assert.equal(text.width, 8);
});

test('dragging a handle keeps the opposite side, and the proportions with Shift', () => {
  const box = { x: 10, y: 10, width: 20, height: 10 };
  assert.deepEqual(resizeBox(box, 'e', 10, 99), { x: 10, y: 10, width: 30, height: 10 });
  assert.deepEqual(resizeBox(box, 'nw', -10, -5), { x: 0, y: 5, width: 30, height: 15 });
  const kept = resizeBox(box, 'se', 20, 0, true);
  assert.equal(kept.width / kept.height, 2);
  // From the middle, both sides move.
  assert.deepEqual(resizeBox(box, 'e', 5, 0, false, true), { x: 5, y: 10, width: 30, height: 10 });
  // Past the other side it flips instead of vanishing.
  assert.deepEqual(resizeBox(box, 'e', -30, 0), { x: 0, y: 10, width: 10, height: 10 });
});

test('layers are painted in order; hidden ones are left out and a group with opacity paints as one piece', () => {
  const calls: string[] = [];
  const ctx = new Proxy({ canvas: { width: 10, height: 10 }, getTransform: () => ({}) } as Record<string, unknown>, {
    get: (target, name: string) => (name in target ? target[name] : () => undefined),
    set: (target, name: string, value) => ((target[name] = value), true),
  }) as unknown as CanvasRenderingContext2D;
  const g = newGroup([rect('a', 0, 0, 5), rect('b', 0, 0, 5, { hidden: true })], 'G');
  const shapes = g.shapes.map((s) => (s.id === 'a' || s.id === 'b' ? { ...s, parent: g.id } : s));
  paintLayers(ctx, shapes, false, (_c, s) => void calls.push(s.id!));
  assert.deepEqual(calls, ['a']);
});

import { hitShape, shapeCenter } from '../src/formats/imageDraw.ts';
import { rotateShape } from '../src/formats/imageLayers.ts';

test('a rotated shape is hit, painted and boxed in its turned place, and turning round a point carries it', () => {
  const bar: Shape = rect('b', 0, 0, 100, { width: 2 });
  const flat = { ...bar, points: [{ x: 0, y: 0 }, { x: 100, y: 10 }], fill: true };
  assert.deepEqual(shapeCenter(flat), { x: 50, y: 5 });
  const upright = rotateShape(flat, 90, shapeCenter(flat));
  assert.equal(upright.rotation, 90);
  // Turned a quarter, the long bar stands up: it is tall now, and the old ends are empty.
  assert.ok(hitShape(upright, { x: 50, y: 40 }, 1));
  assert.ok(!hitShape(upright, { x: 5, y: 5 }, 1));
  const box = boundsOf([upright], upright)!;
  assert.ok(box.height > 95 && box.width < 15);
  // Turning back to upright drops the rotation.
  assert.equal('rotation' in rotateShape(upright, -90, shapeCenter(upright)), false);
  // Turned about a point away from it, the shape's middle goes round that point.
  const carried = rotateShape({ ...flat, points: [{ x: 100, y: 0 }, { x: 120, y: 0 }] }, 180, { x: 0, y: 0 });
  assert.ok(Math.abs(shapeCenter(carried).x + 110) < 1e-9);
});
