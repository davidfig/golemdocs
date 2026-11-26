// How fast a selecting drag scrolls the view at its edges (src/ui/edgeScroll.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EDGE_MAX_SPEED, EDGE_SPEED, EDGE_ZONE_PX, edgeSpeed, edgeVelocity } from '../src/ui/edgeScroll.ts';

test('away from the edges nothing scrolls', () => {
  assert.equal(edgeSpeed(500, 0, 1000), 0);
  assert.equal(edgeSpeed(EDGE_ZONE_PX, 0, 1000), 0);
  assert.equal(edgeSpeed(1000 - EDGE_ZONE_PX, 0, 1000), 0);
});

test('inside an edge the speed rises towards it, backwards at the start', () => {
  const half = edgeSpeed(EDGE_ZONE_PX / 2, 0, 1000);
  assert.ok(half < 0 && half > -EDGE_SPEED, `${half}`);
  assert.equal(edgeSpeed(0, 0, 1000), -EDGE_SPEED);
  assert.equal(edgeSpeed(1000, 0, 1000), EDGE_SPEED);
  assert.ok(edgeSpeed(1000 - 2, 0, 1000) > edgeSpeed(1000 - 10, 0, 1000));
});

test('past an edge it keeps speeding up, to a limit', () => {
  assert.ok(edgeSpeed(1040, 0, 1000) > EDGE_SPEED);
  assert.ok(edgeSpeed(-40, 0, 1000) < -EDGE_SPEED);
  assert.equal(edgeSpeed(100_000, 0, 1000), EDGE_MAX_SPEED);
  assert.equal(edgeSpeed(-100_000, 0, 1000), -EDGE_MAX_SPEED);
});

test('a view too small for its edge zones scrolls only once the pointer is outside it', () => {
  assert.equal(edgeSpeed(10, 0, 20), 0);
  assert.equal(edgeSpeed(0, 0, 2), 0);
  assert.ok(edgeSpeed(-5, 0, 2) < 0);
  assert.ok(edgeSpeed(7, 0, 2) > 0);
});

test('each axis is measured against its own edges', () => {
  const view = { left: 100, top: 50, right: 900, bottom: 650 };
  assert.deepEqual(edgeVelocity(500, 350, view), { x: 0, y: 0 });
  const corner = edgeVelocity(950, 20, view);
  assert.ok(corner.x > 0 && corner.y < 0, JSON.stringify(corner));
});
