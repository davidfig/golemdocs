import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameMonitor } from '../src/debug.ts';

test('a steady run of frames drops none, and fps counts the last second', () => {
  const m = new FrameMonitor();
  for (let i = 0; i < 60; i++) m.record(1000 + i * (1000 / 60), 2);
  assert.equal(m.dropped, 0);
  assert.equal(m.fps(1000 + 59 * (1000 / 60)), 60);
  assert.equal(m.fps(1000 + 59 * (1000 / 60) + 5000), 0);
});

test('a slow gap inside a run counts the missed frames; idle time does not', () => {
  const m = new FrameMonitor();
  m.record(1000, 1);
  m.record(1016.7, 1);
  m.record(1066.7, 30); // 50 ms: about two missed frames
  assert.equal(m.dropped, 2);
  assert.equal(m.maxCpuMs, 30);
  m.record(5000, 1); // idle for seconds: a new run, not dropped frames
  assert.equal(m.dropped, 2);
});

test('clear resets the worst cases', () => {
  const m = new FrameMonitor();
  m.record(1000, 5);
  m.record(1100, 5);
  m.clear();
  assert.deepEqual([m.maxCpuMs, m.maxGapMs, m.dropped], [0, 0, 0]);
});
