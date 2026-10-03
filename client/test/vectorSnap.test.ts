// Snapping to other shapes and the page (src/vector/snap.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUIDES_ATTR, readGuides, snapBox, snapPoint, snapTargets, snapValue, writeGuides } from '../src/vector/snap.ts';
import { readSvg } from '../src/vector/svgRead.ts';

const scene = () =>
  readSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <rect x="20" y="10" width="40" height="30" fill="red"/>
  <rect x="100" y="50" width="20" height="20" fill="blue"/>
  <rect x="150" y="0" width="10" height="10" fill="green" display="none"/>
</svg>`);

test('the lines are the edges and centres of the page and of every visible shape but those being moved', () => {
  const t = snapTargets(scene());
  assert.deepEqual(t.xs, [0, 20, 40, 60, 100, 110, 120, 200]);
  assert.deepEqual(t.ys, [0, 10, 25, 40, 50, 60, 70, 100]);
  assert.deepEqual(snapTargets(scene(), [[1]]).xs, [0, 20, 40, 60, 100, 200]);
});

test('a value is pulled to the nearest line within reach', () => {
  assert.equal(snapValue(42, [0, 40, 60], 5), 40);
  assert.equal(snapValue(50, [0, 40, 60], 5), null);
  assert.equal(snapValue(58, [0, 57, 60], 5), 57);
});

test('a box lands its edge or its centre on a line, each way on its own, and says which lines', () => {
  const t = snapTargets(scene(), [[1]]);
  // The box's left is 3 right of the first shape's left edge (20), and its middle 40 from the page's: only x snaps.
  const s = snapBox({ x: 23, y: 77, width: 20, height: 10 }, t, 6);
  assert.deepEqual([s.dx, s.dy], [-3, 0]);
  assert.deepEqual(s.guides, { xs: [20], ys: [] });
  // The centre of a box beside a shape's centre line.
  const c = snapBox({ x: 0, y: 12, width: 30, height: 26 }, t, 6);
  assert.equal(c.guides.ys.length, 1);
  assert.deepEqual(snapBox({ x: 80, y: 85, width: 5, height: 5 }, t, 2), { dx: 0, dy: 0, guides: { xs: [], ys: [] } });
});

test('a point is pulled on each axis', () => {
  const t = snapTargets(scene());
  const p = snapPoint({ x: 102, y: 33 }, t, 4);
  assert.deepEqual([p.x, p.y], [100, 33]);
  assert.deepEqual(p.guides, { xs: [100], ys: [] });
});

test('guides are kept in the file, are snapped to, and are read back as they were', () => {
  const s = scene();
  assert.deepEqual(readGuides(s), { v: [], h: [] });
  writeGuides(s, { v: [75.12345], h: [33] });
  assert.equal(s.attrs[GUIDES_ATTR], '{"v":[75.123],"h":[33]}');
  assert.deepEqual(readGuides(s), { v: [75.123], h: [33] });
  const t = snapTargets(s);
  assert.ok(t.xs.includes(75.123) && t.ys.includes(33));
  assert.deepEqual(snapPoint({ x: 77, y: 90 }, t, 4).guides, { xs: [75.123], ys: [] });
  writeGuides(s, { v: [], h: [] });
  assert.equal(s.attrs[GUIDES_ATTR], undefined);
  s.attrs[GUIDES_ATTR] = 'not json';
  assert.deepEqual(readGuides(s), { v: [], h: [] });
});

test('hidden guides are left out of the lines to snap to', () => {
  const s = scene();
  writeGuides(s, { v: [77], h: [33] });
  assert.ok(snapTargets(s).xs.includes(77) && snapTargets(s).ys.includes(33));
  assert.ok(!snapTargets(s, [], false).xs.includes(77) && !snapTargets(s, [], false).ys.includes(33));
});
