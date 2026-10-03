// Clipping masks (src/vector/clipEdit.ts), read back with the same clip reader the painter uses.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isClipped, makeClippingMask, releaseClippingMask } from '../src/vector/clipEdit.ts';
import { nodeAt } from '../src/vector/edit.ts';
import { readClip } from '../src/vector/clip.ts';
import { pathBounds } from '../src/vector/pathData.ts';
import { readSvg } from '../src/vector/svgRead.ts';
import { writeSvg } from '../src/vector/svgWrite.ts';
import type { GroupNode, PathNode } from '../src/vector/model.ts';

const scene = () =>
  readSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect id="big" width="100" height="100" fill="red"/>
  <circle id="small" cx="30" cy="30" r="10" fill="blue"/>
  <rect id="top" x="20" y="20" width="30" height="30" transform="translate(5 5)"/>
</svg>`);

test('the topmost shape becomes the clip of a group of the others', () => {
  const s = scene();
  const at = makeClippingMask(s, [[0], [1], [2]])!;
  assert.deepEqual(at, [0]);
  assert.equal(s.children.length, 1);
  const group = nodeAt(s, at) as GroupNode;
  assert.deepEqual(group.children.map((c) => c.id), ['big', 'small']);
  assert.ok(isClipped(s, group));
  const clip = readClip(s, group.style['clip-path'], null)!;
  // The clip shape's own transform is part of its outline.
  const b = pathBounds(clip.commands)!;
  assert.deepEqual([b.x, b.y, b.width, b.height], [25, 25, 30, 30]);
  assert.match(writeSvg(s), /<clipPath id="clipPath1">\s*<path d="[^"]+"\/>\s*<\/clipPath>/);
});

test('it can be taken off again, leaving the shape on top', () => {
  const s = scene();
  const at = makeClippingMask(s, [[0], [1], [2]])!;
  const released = releaseClippingMask(s, at);
  assert.deepEqual(released, [[0], [1]]);
  assert.ok(!isClipped(s, nodeAt(s, [0])));
  const shape = nodeAt(s, [1]) as PathNode;
  assert.equal(shape.kind, 'path');
  assert.equal(shape.style.fill, 'none');
  assert.deepEqual(pathBounds(shape.commands), { x: 25, y: 25, width: 30, height: 30 });
  assert.equal(s.defs.length, 0, 'the clip is not kept when nothing uses it');
  assert.deepEqual(releaseClippingMask(s, [0]), []);
});

test('it needs a shape on top and at least one other, in one group', () => {
  const s = scene();
  assert.equal(makeClippingMask(s, [[0]]), null);
  const t = readSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/><text>hi</text></svg>');
  assert.equal(makeClippingMask(t, [[0], [1]]), null, 'text on top');
  assert.equal(t.defs.length, 0);
});
