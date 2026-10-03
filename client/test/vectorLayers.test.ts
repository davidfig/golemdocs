// What the layers list changes: visibility, locks, names and order (src/vector/edit.ts), and that locked and hidden nodes can't be picked.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isHidden, isLocked, moveNodeTo, nodeAt, setLocked, setName, setVisible, NAME_ATTR } from '../src/vector/edit.ts';
import { hitTest, nodesInRect } from '../src/vector/hit.ts';
import { readSvg } from '../src/vector/svgRead.ts';
import { writeSvg } from '../src/vector/svgWrite.ts';

const scene = () =>
  readSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect id="a" width="50" height="50" fill="red"/>
  <rect id="b" width="50" height="50" fill="blue"/>
  <g id="g"><rect id="c" x="60" width="20" height="20"/><rect id="d" x="60" y="30" width="20" height="20"/></g>
</svg>`);

const ids = (list: { id?: string }[]) => list.map((n) => n.id);

test('a locked node can be seen but not picked; a hidden one is neither painted nor picked', () => {
  const s = scene();
  assert.deepEqual(hitTest(s, { x: 10, y: 10 }), [1]);
  setLocked(s, [[1]], true);
  assert.ok(isLocked(nodeAt(s, [1])!));
  // The one behind it can be picked now.
  assert.deepEqual(hitTest(s, { x: 10, y: 10 }), [0]);
  assert.deepEqual(nodesInRect(s, { x: 0, y: 0, width: 100, height: 100 }), [[0], [2]]);
  setVisible(s, [[0]], false);
  assert.ok(isHidden(nodeAt(s, [0])!));
  assert.equal(hitTest(s, { x: 10, y: 10 }), null);
  setVisible(s, [[0]], true);
  setLocked(s, [[1]], false);
  assert.deepEqual(hitTest(s, { x: 10, y: 10 }), [1]);
  // Saved with the file: hidden is display none, locked an attribute.
  setLocked(s, [[0]], true);
  setVisible(s, [[2]], false);
  const text = writeSvg(s);
  assert.match(text, /data-golem-locked="true"/);
  assert.match(text, /display="none"/);
  assert.ok(isLocked(readSvg(text).children[0]));
});

test('names are kept in an attribute', () => {
  const s = scene();
  setName(s, [0], '  Background ');
  assert.equal(nodeAt(s, [0])!.attrs[NAME_ATTR], 'Background');
  setName(s, [0], '');
  assert.equal(nodeAt(s, [0])!.attrs[NAME_ATTR], undefined);
});

test('a node is moved to a place in its group, or into another group', () => {
  const s = scene();
  // Above everything: after the last child.
  assert.deepEqual(moveNodeTo(s, [0], [], 3), [2]);
  assert.deepEqual(ids(s.children), ['b', 'g', 'a']);
  // To the bottom.
  assert.deepEqual(moveNodeTo(s, [2], [], 0), [0]);
  assert.deepEqual(ids(s.children), ['a', 'b', 'g']);
  // Into the group, between its children.
  assert.deepEqual(moveNodeTo(s, [0], [2], 1), [1, 1]);
  assert.deepEqual(ids((s.children[1] as unknown as { children: { id?: string }[] }).children), ['c', 'a', 'd']);
  // A group can't go inside itself.
  assert.equal(moveNodeTo(s, [1], [1], 0), null);
  assert.equal(moveNodeTo(s, [9], [], 0), null);
});
