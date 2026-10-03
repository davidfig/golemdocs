// The progress card's time left (src/ui/timeLeft.ts).
// Run: node --test test/*.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateSeconds, formatDuration } from '../src/ui/timeLeft.ts';

test('no estimate until there is enough to go on', () => {
  assert.equal(estimateSeconds(0.01, 0, 10_000), null);
  assert.equal(estimateSeconds(0.5, 0, 1000), null);
});

test('the pace so far is extended to the rest, ignoring work before the clock started', () => {
  assert.ok(Math.abs(estimateSeconds(0.5, 0, 10_000)! - 10) < 1e-9);
  assert.ok(Math.abs(estimateSeconds(0.6, 0.2, 10_000)! - 10) < 1e-9);
});

test('durations round to seconds, minutes, then hours', () => {
  assert.match(formatDuration(3), /5/);
  assert.match(formatDuration(100), /2/);
  assert.match(formatDuration(4800), /1.*20/);
});
