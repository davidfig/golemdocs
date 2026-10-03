// Making and changing gradients (src/vector/gradientEdit.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { colorAt, createGradient, editableGradient, gradientHandles, gradientInLocal, ownGradient, readStops, referenceCount, setGradientPoint, uniqueId, writeStops } from '../src/vector/gradientEdit.ts';
import { readGradient } from '../src/vector/gradients.ts';
import { parseColor } from '../src/vector/style.ts';
import { readSvg } from '../src/vector/svgRead.ts';
import { writeSvg } from '../src/vector/svgWrite.ts';

const BOX = { x: 10, y: 20, width: 100, height: 40 };

const scene = () =>
  readSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>
  <rect id="a" x="10" y="20" width="100" height="40" fill="url(#g)"/>
  <rect id="b" x="10" y="20" width="100" height="40" fill="url(#g)"/>
</svg>`);

test('a new gradient runs across the box in the shape’s own coordinates, and its id is new', () => {
  const s = scene();
  const id = createGradient(s, 'linear', BOX, '#112233', '#ffffff');
  assert.equal(id, 'linearGradient1');
  assert.equal(uniqueId(s, 'linearGradient'), 'linearGradient2');
  const g = readGradient(s, id)!;
  assert.equal(g.units, 'user');
  assert.deepEqual([g.x1, g.y1, g.x2, g.y2], [10, 40, 110, 40]);
  assert.deepEqual(g.stops.map((x) => x.offset), [0, 1]);
  const radial = readGradient(s, createGradient(s, 'radial', BOX, '#000', '#fff'))!;
  assert.deepEqual([radial.cx, radial.cy, radial.r], [60, 40, 50]);
  // And it is saved with the drawing.
  assert.match(writeSvg(s), /<linearGradient id="linearGradient1" gradientUnits="userSpaceOnUse" x1="10" y1="40" x2="110" y2="40">/);
});

test('a gradient in box units is converted to the shape’s coordinates when it is changed', () => {
  const s = scene();
  const { element, gradient } = editableGradient(s, 'g', BOX)!;
  assert.equal(element.attrs.gradientUnits, 'userSpaceOnUse');
  assert.deepEqual([gradient.x1, gradient.x2, gradient.y1], [10, 110, 20]);
  const handles = gradientHandles(gradient);
  assert.deepEqual(handles.points, [{ x: 10, y: 20 }, { x: 110, y: 20 }]);
  assert.deepEqual(handles.stops.map((x) => x.at.x), [10, 110]);
  // Without changing the file, the same numbers can be had (for showing the handles).
  const fresh = scene();
  assert.deepEqual(gradientInLocal(readGradient(fresh, 'g')!, BOX).x2, 110);
  // A turned gradient is left alone.
  const turned = readSvg('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="t" gradientTransform="rotate(30)"><stop offset="0"/><stop offset="1"/></linearGradient></defs></svg>');
  assert.equal(editableGradient(turned, 't', BOX), null);
  assert.equal(editableGradient(scene(), 'missing', BOX), null);
});

test('a gradient used by two shapes is copied before one is changed', () => {
  const s = scene();
  assert.equal(referenceCount(s, 'g'), 2);
  const copy = ownGradient(s, 'g');
  assert.notEqual(copy, 'g');
  assert.ok(readGradient(s, copy));
  // The shape being changed is pointed at the copy by the caller; with one user the gradient stays.
  (s.children[0] as { style: Record<string, string> }).style.fill = `url(#${copy})`;
  assert.equal(referenceCount(s, 'g'), 1);
  assert.equal(ownGradient(s, 'g'), 'g');
});

test('the points of a gradient move, and a radial one’s centre takes its edge along', () => {
  const s = scene();
  const { element } = editableGradient(s, 'g', BOX)!;
  setGradientPoint(element, 1, { x: 90, y: 50 });
  assert.deepEqual([element.attrs.x2, element.attrs.y2], ['90', '50']);
  const id = createGradient(s, 'radial', BOX, '#000', '#fff');
  const radial = editableGradient(s, id, BOX)!.element;
  setGradientPoint(radial, 1, { x: 60 + 30, y: 40 });
  assert.equal(radial.attrs.r, '30');
  setGradientPoint(radial, 0, { x: 70, y: 45 });
  assert.deepEqual([radial.attrs.cx, radial.attrs.cy, radial.attrs.r], ['70', '45', '30']);
});

test('stops are read, replaced in order, and a new one takes the colour between its neighbours', () => {
  const s = scene();
  const { element } = editableGradient(s, 'g', BOX)!;
  const stops = readStops(element);
  assert.deepEqual(stops, [{ offset: 0, color: '#f00' }, { offset: 1, color: '#00f' }]);
  const middle = colorAt(stops, 0.5, parseColor);
  assert.equal(middle, '#800080');
  writeStops(element, [...stops, { offset: 0.5, color: middle }]);
  assert.deepEqual(readStops(element).map((x) => x.offset), [0, 0.5, 1]);
  assert.equal(colorAt([{ offset: 0, color: '#f00' }, { offset: 1, color: '#f00' }], 0.2, parseColor), '#ff0000');
});

test('writing stops tells where each one went, even when its offset is rounded or it passes a neighbour', () => {
  const { element } = editableGradient(scene(), 'g', BOX)!;
  const stops = readStops(element);
  const added = { offset: 0.123456789, color: '#0f0' };
  assert.equal(writeStops(element, [...stops, added]).indexOf(added), 1);
  assert.equal(readStops(element)[1].offset, 0.1235);
  // The first stop dragged past the others ends up last.
  const moved = readStops(element);
  const first = moved[0];
  first.offset = 0.9;
  assert.equal(writeStops(element, moved).indexOf(first), 1);
  assert.deepEqual(readStops(element).map((x) => x.color), ['#0f0', '#f00', '#00f']);
});
