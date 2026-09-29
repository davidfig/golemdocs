import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameMonitor } from '../src/debug.ts';

test('a steady run of frames drops none and sets the frame rate', () => {
  const m = new FrameMonitor();
  for (let i = 0; i < 60; i++) m.record(1000 + i * (1000 / 60), 2);
  assert.equal(m.dropped, 0);
  assert.equal(Math.round(m.rate), 60);
});

test('the frame rate holds through idle time, and a new run replaces it', () => {
  const m = new FrameMonitor();
  for (let i = 0; i < 20; i++) m.record(1000 + i * 20, 1); // 50 fps
  m.record(9000, 1); // idle for seconds, then one frame: still the last run's rate
  assert.equal(Math.round(m.rate), 50);
  for (let i = 1; i < 10; i++) m.record(9000 + i * 10, 1); // 100 fps
  assert.equal(Math.round(m.rate), 100);
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
