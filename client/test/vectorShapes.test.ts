import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SHAPE_IDS, shapePath } from '../src/vector/shapes.ts';

const points = (id: (typeof SHAPE_IDS)[number], x: number, y: number, w: number, h: number): [number, number][] =>
  shapePath(id, x, y, w, h).flatMap((c): [number, number][] => (c[0] === 'Z' ? [] : c[0] === 'C' ? [[c[5], c[6]]] : [[c[1], c[2]]]));

test('every shape is closed and stays inside the box it is drawn in', () => {
  for (const id of SHAPE_IDS) {
    const commands = shapePath(id, 10, 20, 100, 60);
    assert.equal(commands[0][0], 'M', id);
    assert.equal(commands[commands.length - 1][0], 'Z', id);
    for (const [x, y] of points(id, 10, 20, 100, 60)) {
      assert.ok(x >= 10 - 1e-6 && x <= 110 + 1e-6 && y >= 20 - 1e-6 && y <= 80 + 1e-6, `${id} point ${x},${y}`);
    }
  }
});

test('a star touches all four sides of its box and has ten corners', () => {
  const pts = points('star', 0, 0, 100, 100);
  assert.equal(pts.length, 10);
  assert.equal(Math.min(...pts.map((p) => p[0])), 0);
  assert.equal(Math.max(...pts.map((p) => p[0])), 100);
  assert.equal(Math.min(...pts.map((p) => p[1])), 0);
  assert.equal(Math.max(...pts.map((p) => p[1])), 100);
});

test('a rounded rectangle keeps the same corner radius at any size', () => {
  const wide = points('roundRect', 0, 0, 200, 50);
  assert.equal(wide[0][0], 10);
  const tall = points('roundRect', 0, 0, 50, 200);
  assert.equal(tall[0][0], 10);
});
