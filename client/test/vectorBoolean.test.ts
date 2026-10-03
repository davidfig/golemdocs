// Boolean operations on shapes (src/vector/boolean.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { booleanNodes, combine } from '../src/vector/boolean.ts';
import { nodeAt } from '../src/vector/edit.ts';
import { flatten } from '../src/vector/hit.ts';
import { IDENTITY } from '../src/vector/model.ts';
import type { PathCommand, PathNode } from '../src/vector/model.ts';
import { ellipsePath, pathBounds, rectPath } from '../src/vector/pathData.ts';
import { readSvg } from '../src/vector/svgRead.ts';

/** The area a path covers (rings that hold others count against them), by the shoelace formula. */
function area(commands: readonly PathCommand[]): number {
  return Math.abs(flatten(commands).reduce((sum, line) => {
    let a = 0;
    const p = line.points;
    for (let i = 0; i < p.length; i++) {
      const q = p[(i + 1) % p.length];
      a += p[i].x * q.y - q.x * p[i].y;
    }
    // Rings go opposite ways for holes, so signed areas add up to the filled area.
    return sum + a / 2;
  }, 0));
}

const a = { commands: rectPath(0, 0, 10, 10), matrix: IDENTITY };
const b = { commands: rectPath(5, 5, 10, 10), matrix: IDENTITY };

test('unite, intersect, subtract and exclude two overlapping squares', () => {
  assert.equal(area(combine([a, b], 'unite')), 175);
  assert.equal(area(combine([a, b], 'intersect')), 25);
  assert.equal(area(combine([a, b], 'subtract')), 75);
  assert.equal(area(combine([a, b], 'exclude')), 150);
  assert.deepEqual(pathBounds(combine([a, b], 'intersect')), { x: 5, y: 5, width: 5, height: 5 });
});

test('subtracting from the back shape leaves a hole when the front one is inside', () => {
  const inner = { commands: rectPath(3, 3, 4, 4), matrix: IDENTITY };
  const out = combine([a, inner], 'subtract');
  assert.equal(out.filter((c) => c[0] === 'M').length, 2, 'outer and hole');
  assert.ok(Math.abs(area(out) - 84) < 1e-9);
});

test('curves are cut into pieces and the result is straight lines', () => {
  const circle = { commands: ellipsePath(10, 10, 6, 6), matrix: IDENTITY };
  const out = combine([a, circle], 'intersect');
  assert.ok(out.every((c) => c[0] !== 'C'));
  // A quarter of the circle: pi * 36 / 4, within the flattening error.
  assert.ok(Math.abs(area(out) - (Math.PI * 36) / 4) < 0.5, `${area(out)}`);
  // Shapes that do not meet leave nothing to intersect.
  const far = { commands: rectPath(50, 50, 5, 5), matrix: IDENTITY };
  assert.deepEqual(combine([a, far], 'intersect'), []);
  assert.equal(area(combine([a, far], 'unite')), 125);
});

test('shapes are combined where they are on the page, whatever transforms they have', () => {
  const moved = { commands: rectPath(0, 0, 10, 10), matrix: [1, 0, 0, 1, 5, 5] as const };
  assert.equal(area(combine([a, moved], 'intersect')), 25);
});

const SCENE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect id="a" width="10" height="10" fill="red"/>
  <circle id="m" cx="50" cy="50" r="2"/>
  <rect id="b" x="5" y="5" width="10" height="10" fill="blue" transform="translate(1 0)"/>
</svg>`;

test('the shapes are replaced by the result, at the place of the topmost, with the front shape’s look', () => {
  const s = readSvg(SCENE);
  const at = booleanNodes(s, [[0], [2]], 'unite')!;
  assert.deepEqual(at, [1]);
  assert.deepEqual(s.children.map((n) => n.id), ['m', undefined]);
  const result = nodeAt(s, at) as PathNode;
  assert.equal(result.kind, 'path');
  assert.equal(result.style.fill, 'blue');
  const b = pathBounds(result.commands)!;
  assert.deepEqual([b.x, b.y, b.width, b.height], [0, 0, 16, 15]);
  // Subtracting keeps the look of the one cut from.
  const t = readSvg(SCENE);
  const cut = nodeAt(t, booleanNodes(t, [[0], [2]], 'subtract')!) as PathNode;
  assert.equal(cut.style.fill, 'red');
});

test('what can’t be combined is left alone', () => {
  const s = readSvg(SCENE);
  assert.equal(booleanNodes(s, [[0]], 'unite'), null);
  assert.equal(s.children.length, 3);
  const g = readSvg('<svg xmlns="http://www.w3.org/2000/svg"><g><rect width="5" height="5"/></g><rect width="5" height="5"/></svg>');
  assert.equal(booleanNodes(g, [[0, 0], [1]], 'unite'), null, 'different groups');
  const far = readSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/><rect x="20" width="5" height="5"/></svg>');
  assert.equal(booleanNodes(far, [[0], [1]], 'intersect'), null, 'nothing left');
  assert.equal(far.children.length, 2);
});
