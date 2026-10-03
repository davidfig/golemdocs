// Changing a scene and finding what is under a point (src/vector/edit.ts, hit.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addNode, cloneScene, duplicateNodes, groupNodes, nodeAt, outermost, removeNodes, reorderNodes, selectionBounds, setStyle, styleOf, transformNodes, translateNodes, ungroupNode, worldBounds, worldMatrix } from '../src/vector/edit.ts';
import { distanceToSegment, flatten, hitTest, insideFill, nodesInRect } from '../src/vector/hit.ts';
import { rotation, scaling } from '../src/vector/matrix.ts';
import { readSvg } from '../src/vector/svgRead.ts';
import { writeSvg } from '../src/vector/svgWrite.ts';
import { parsePath } from '../src/vector/pathData.ts';

const scene = () =>
  readSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect id="a" x="0" y="0" width="50" height="50" fill="red"/>
  <g id="g" transform="translate(100 100) scale(2)">
    <rect id="b" x="0" y="0" width="10" height="10" fill="blue"/>
    <circle id="c" cx="30" cy="5" r="5" fill="none" stroke="black" stroke-width="2"/>
  </g>
  <path id="d" d="M10 150 L60 150" stroke="green" stroke-width="4" fill="none"/>
</svg>`);

const ids = (s: ReturnType<typeof scene>) => s.children.map((n) => n.id);

test('nodes are found by path and know where they are in the drawing', () => {
  const s = scene();
  assert.equal(nodeAt(s, [1, 1])?.id, 'c');
  assert.equal(nodeAt(s, [5]), undefined);
  assert.equal(nodeAt(s, [0, 0]), undefined, 'a rectangle has no children');
  assert.deepEqual([...worldMatrix(s, [1, 0])], [2, 0, 0, 2, 100, 100]);
  assert.deepEqual(worldBounds(s, [1, 0]), { x: 100, y: 100, width: 20, height: 20 });
  assert.deepEqual(selectionBounds(s, [[0], [1, 0]]), { x: 0, y: 0, width: 120, height: 120 });
});

test('moving a node inside a transformed group moves it by the amount asked, on screen', () => {
  const s = scene();
  translateNodes(s, [[1, 0]], 20, 10);
  // The group is scaled by 2: the node itself moves 10 and 5 of its own units.
  assert.deepEqual(worldBounds(s, [1, 0]), { x: 120, y: 110, width: 20, height: 20 });
  assert.deepEqual([...nodeAt(s, [1, 0])!.transform!], [1, 0, 0, 1, 10, 5]);
  // A group moved with something inside it moves once.
  translateNodes(s, [[1], [1, 1]], 4, 0);
  assert.equal(worldBounds(s, [1, 0])!.x, 124);
});

test('scaling and rotating about a point', () => {
  const s = scene();
  // Doubles the first rectangle about its corner.
  transformNodes(s, [[0]], scaling(2));
  assert.deepEqual(worldBounds(s, [0]), { x: 0, y: 0, width: 100, height: 100 });
  transformNodes(s, [[0]], rotation(90, 50, 50));
  const b = worldBounds(s, [0])!;
  assert.ok(Math.abs(b.x - 0) < 1e-9 && Math.abs(b.width - 100) < 1e-9);
});

test('removing and duplicating', () => {
  const s = scene();
  const copies = duplicateNodes(s, [[0], [2]]);
  assert.deepEqual(ids(s), ['a', undefined, 'g', 'd', undefined]);
  assert.deepEqual(copies, [[1], [4]]);
  removeNodes(s, [[1], [4], [2, 0]]);
  assert.deepEqual(ids(s), ['a', 'g', 'd']);
  assert.equal((s.children[1] as { children: unknown[] }).children.length, 1);
});

test('grouping puts nodes in a group where the topmost was, and ungrouping gives them back as they looked', () => {
  const s = scene();
  const group = groupNodes(s, [[0], [2]])!;
  assert.deepEqual(group, [1]);
  assert.deepEqual(ids(s), ['g', undefined]);
  assert.deepEqual((nodeAt(s, group) as { children: { id?: string }[] }).children.map((c) => c.id), ['a', 'd']);
  // Nodes in different groups can't be grouped.
  assert.equal(groupNodes(s, [[0, 0], [1, 0]]), null);

  const t = scene();
  t.children[1].transform = [1, 0, 0, 1, 5, 5];
  t.children[1].style.opacity = '0.5';
  const members = ungroupNode(t, [1]);
  assert.deepEqual(members, [[1], [2]]);
  assert.deepEqual(ids(t), ['a', 'b', 'c', 'd']);
  assert.deepEqual([...t.children[1].transform!], [1, 0, 0, 1, 5, 5]);
  assert.equal(t.children[1].style.opacity, '0.5');
});

test('ordering within a group', () => {
  const s = scene();
  assert.deepEqual(reorderNodes(s, [[0]], 'front'), [[2]]);
  assert.deepEqual(ids(s), ['g', 'd', 'a']);
  reorderNodes(s, [[2]], 'back');
  assert.deepEqual(ids(s), ['a', 'g', 'd']);
  reorderNodes(s, [[0]], 'forward');
  assert.deepEqual(ids(s), ['g', 'a', 'd']);
  reorderNodes(s, [[1], [2]], 'forward');
  assert.deepEqual(ids(s), ['g', 'a', 'd'], 'already at the top');
  reorderNodes(s, [[2]], 'backward');
  assert.deepEqual(ids(s), ['g', 'd', 'a']);
  // Inside a group only its own children are ordered.
  reorderNodes(s, [[0, 0]], 'front');
  assert.deepEqual((s.children[0] as { children: { id?: string }[] }).children.map((c) => c.id), ['c', 'b']);
});

test('styles are set and cleared, and read through the groups around a node', () => {
  const s = scene();
  setStyle(s, [[0], [1, 0]], { fill: '#00ff00', opacity: '0.4', stroke: null });
  assert.equal(nodeAt(s, [0])!.style.fill, '#00ff00');
  assert.equal(styleOf(s, [1, 0], 'fill'), '#00ff00');
  setStyle(s, [[1]], { 'stroke-width': '3' });
  assert.equal(styleOf(s, [1, 1], 'stroke-width'), '2', 'the circle sets its own');
  assert.equal(styleOf(s, [1, 0], 'stroke-width'), '3', 'the rectangle takes the group’s');
  assert.equal(styleOf(s, [0], 'nonsense'), undefined);
});

test('new nodes go on top and are written', () => {
  const s = scene();
  const path = addNode(s, { kind: 'rect', x: 1, y: 2, width: 3, height: 4, rx: 0, ry: 0, style: { fill: 'pink' }, attrs: {} });
  assert.deepEqual(path, [3]);
  addNode(s, { kind: 'ellipse', cx: 0, cy: 0, rx: 2, ry: 2, style: {}, attrs: {} }, [1]);
  assert.match(writeSvg(s), /<rect x="1" y="2" width="3" height="4" fill="pink"\/>/);
  assert.throws(() => addNode(s, { kind: 'ellipse', cx: 0, cy: 0, rx: 2, ry: 2, style: {}, attrs: {} }, [0]));
});

test('a copy of a scene is independent', () => {
  const s = scene();
  const copy = cloneScene(s);
  translateNodes(copy, [[0]], 10, 10);
  assert.equal(nodeAt(s, [0])!.transform, undefined);
  assert.deepEqual(outermost([[1, 0], [1], [0], [0]]), [[0], [1]]);
});

test('flattened curves, fills and distances', () => {
  const lines = flatten(parsePath('M0 0 C0 10 10 10 10 0 Z'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].closed, true);
  assert.ok(insideFill({ x: 5, y: 4 }, lines, false));
  assert.ok(!insideFill({ x: 5, y: 9 }, lines, false));
  assert.ok(!insideFill({ x: -1, y: 1 }, lines, false));
  // A hole by the even-odd rule.
  const ring = flatten(parsePath('M0 0H20V20H0Z M5 5H15V15H5Z'));
  assert.ok(insideFill({ x: 10, y: 10 }, ring, false));
  assert.ok(!insideFill({ x: 10, y: 10 }, ring, true));
  assert.equal(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  assert.equal(distanceToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
});

test('clicking finds the topmost node, through groups and their transforms', () => {
  const s = scene();
  assert.deepEqual(hitTest(s, { x: 25, y: 25 }), [0]);
  assert.deepEqual(hitTest(s, { x: 110, y: 110 }), [1, 0]);
  // The circle is stroke only: its middle is empty, its ring is not. It is at 160,110 with radius 10 on screen.
  assert.equal(hitTest(s, { x: 160, y: 110 }), null);
  assert.deepEqual(hitTest(s, { x: 170, y: 110 }), [1, 1]);
  // A line is hit within half its width, plus the tolerance.
  assert.deepEqual(hitTest(s, { x: 30, y: 151.9 }), [2]);
  assert.equal(hitTest(s, { x: 30, y: 153 }), null);
  assert.deepEqual(hitTest(s, { x: 30, y: 153 }, 2), [2]);
  assert.equal(hitTest(s, { x: 190, y: 10 }), null);
  // Later nodes are above earlier ones.
  addNode(s, { kind: 'rect', x: 0, y: 0, width: 100, height: 100, rx: 0, ry: 0, style: { fill: 'black' }, attrs: {} });
  assert.deepEqual(hitTest(s, { x: 25, y: 25 }), [3]);
});

test('a rubber band takes the top-level nodes it touches or holds', () => {
  const s = scene();
  assert.deepEqual(nodesInRect(s, { x: 40, y: 40, width: 80, height: 80 }), [[0], [1]]);
  assert.deepEqual(nodesInRect(s, { x: -5, y: -5, width: 60, height: 60 }, 'inside'), [[0]]);
  assert.deepEqual(nodesInRect(s, { x: 0, y: 0, width: 40, height: 40 }, 'inside'), []);
});
