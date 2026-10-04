// The nudge tool's pushing of lines (src/vector/nudge.ts).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PathCommand, PathNode, Scene } from '../src/vector/model.ts';
import { emptyScene } from '../src/vector/model.ts';
import { falloff, nudgePath, nudgeScene, subdivideNear } from '../src/vector/nudge.ts';
import { pathBounds } from '../src/vector/pathData.ts';

const line: PathCommand[] = [['M', 0, 0], ['L', 100, 0]];
const endOf = (c: readonly PathCommand[]): [number, number] => {
  const l = c[c.length - 1] as readonly ['L', number, number];
  return [l[1], l[2]];
};
const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-6, `${a} is not ${b}`);

describe('falloff', () => {
  test('is full at the middle and nothing at the edge', () => {
    assert.equal(falloff(0, 10), 1);
    assert.equal(falloff(10, 10), 0);
    assert.equal(falloff(20, 10), 0);
    assert.ok(falloff(5, 10) > 0 && falloff(5, 10) < 1);
  });
});

describe('subdivideNear', () => {
  test('cuts a long line under the brush into short pieces that end where it did', () => {
    const cut = subdivideNear(line, { x: 50, y: 0 }, 20);
    assert.ok(cut.length > 5);
    assert.deepEqual(endOf(cut), [100, 0]);
  });
  test('leaves a segment out of reach alone', () => {
    assert.deepEqual(subdivideNear(line, { x: 50, y: 500 }, 20), line);
  });
  test('cuts a curve into curves on the same line', () => {
    const curve: PathCommand[] = [['M', 0, 0], ['C', 0, 50, 100, 50, 100, 0]];
    const cut = subdivideNear(curve, { x: 50, y: 40 }, 30);
    assert.ok(cut.length > 3);
    near(pathBounds(cut)!.height, pathBounds(curve)!.height);
    near(pathBounds(cut)!.width, pathBounds(curve)!.width);
    assert.ok(cut.slice(1).every((c) => c[0] === 'C'));
  });
});

describe('nudgePath', () => {
  test('bends a line around the push and keeps its ends', () => {
    const out = nudgePath(line, { x: 50, y: 0 }, { x: 0, y: 10 }, 30)!;
    assert.deepEqual(out[0], ['M', 0, 0]);
    assert.deepEqual(endOf(out), [100, 0]);
    const top = Math.max(...out.map((c) => (c[0] === 'L' ? c[2] : 0)));
    near(top, 10);
    const at = out.find((c) => c[0] === 'L' && c[2] === top) as readonly ['L', number, number];
    near(at[1], 50);
  });
  test('touches nothing out of reach, or with no push', () => {
    assert.equal(nudgePath(line, { x: 50, y: 300 }, { x: 0, y: 10 }, 30), null);
    assert.equal(nudgePath(line, { x: 50, y: 0 }, { x: 0, y: 0 }, 30), null);
  });
  test('moves the handles with their anchor', () => {
    const curve: PathCommand[] = [['M', 0, 0], ['C', 10, 0, 90, 0, 100, 0]];
    const out = nudgePath(curve, { x: 0, y: 0 }, { x: 0, y: 5 }, 8)!;
    assert.equal((out[0] as readonly ['M', number, number])[2], 5);
    assert.equal((out[1] as readonly ['C', number, number, number, number, number, number])[2], 5);
  });
  test('moves both ends of a closed path the same, so it stays closed', () => {
    const closed: PathCommand[] = [['M', 0, 0], ['L', 40, 0], ['L', 40, 40], ['L', 0, 0], ['Z']];
    const out = nudgePath(closed, { x: 0, y: 0 }, { x: 3, y: 4 }, 10)!;
    const m = out[0] as readonly ['M', number, number];
    const last = out[out.length - 2] as readonly ['L', number, number];
    assert.deepEqual([last[1], last[2]], [m[1], m[2]]);
  });
});

const sceneOf = (...nodes: Scene['children']): Scene => ({ ...emptyScene(200, 200), children: nodes });
const pathNode = (commands: PathCommand[], extra: Partial<PathNode> = {}): PathNode => ({ kind: 'path', commands, style: {}, attrs: {}, ...extra });

describe('nudgeScene', () => {
  test('pushes the paths under the brush', () => {
    const scene = sceneOf(pathNode(line));
    assert.equal(nudgeScene(scene, { x: 50, y: 0 }, { x: 0, y: 10 }, 30), true);
    near(pathBounds((scene.children[0] as PathNode).commands)!.height, 10);
  });
  test('turns a rectangle into a path to bend it', () => {
    const scene = sceneOf({ kind: 'rect', x: 0, y: 0, width: 100, height: 100, rx: 0, ry: 0, style: {}, attrs: {} });
    assert.equal(nudgeScene(scene, { x: 50, y: 0 }, { x: 0, y: -10 }, 30), true);
    assert.equal(scene.children[0].kind, 'path');
    near(pathBounds((scene.children[0] as PathNode).commands)!.y, -10);
  });
  test('leaves locked and hidden nodes, and what is out of reach', () => {
    const scene = sceneOf(pathNode(line, { attrs: { 'data-golem-locked': 'true' } }), pathNode(line, { style: { display: 'none' } }), pathNode(line));
    assert.equal(nudgeScene(scene, { x: 50, y: 400 }, { x: 0, y: 10 }, 30), false);
    nudgeScene(scene, { x: 50, y: 0 }, { x: 0, y: 10 }, 30);
    assert.deepEqual((scene.children[0] as PathNode).commands, line);
    assert.deepEqual((scene.children[1] as PathNode).commands, line);
    assert.notDeepEqual((scene.children[2] as PathNode).commands, line);
  });
  test('pushes only the selection when there is one', () => {
    const scene = sceneOf(pathNode(line), pathNode(line));
    assert.equal(nudgeScene(scene, { x: 50, y: 0 }, { x: 0, y: 10 }, 30, [[1]]), true);
    assert.deepEqual((scene.children[0] as PathNode).commands, line);
    assert.notDeepEqual((scene.children[1] as PathNode).commands, line);
  });
  test('takes the brush through a transform', () => {
    // Drawn twice as big, so a push of 20 in the drawing is 10 in the path's own units.
    const scene = sceneOf(pathNode(line, { transform: [2, 0, 0, 2, 0, 0] }));
    nudgeScene(scene, { x: 100, y: 0 }, { x: 0, y: 20 }, 60);
    near(pathBounds((scene.children[0] as PathNode).commands)!.height, 10);
  });
});
