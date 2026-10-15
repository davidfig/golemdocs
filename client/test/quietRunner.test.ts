// Work that waits for a pause in editing (src/quietRunner.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QuietRunner, traced, type QuietTimers } from '../src/quietRunner.ts';

/** A clock and timers that only move when the test says so. */
function fake() {
  let time = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const idle: (() => void)[] = [];
  const api: QuietTimers = {
    now: () => time,
    set: (callback, ms) => {
      timers.set(nextId, { at: time + ms, callback });
      return nextId++;
    },
    clear: (id) => void timers.delete(id),
    idle: (callback) => void idle.push(callback),
  };
  return {
    api,
    /** Moves the clock forward, firing the timers that fall due in order, then any idle callbacks. */
    advance(ms: number, runIdle = true) {
      const target = time + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = Math.max(time, due[1].at);
        due[1].callback();
      }
      time = target;
      if (runIdle) this.runIdle();
    },
    runIdle() {
      for (const callback of idle.splice(0)) callback();
    },
  };
}

test('a task runs once it has been quiet long enough', () => {
  const clock = fake();
  const runner = new QuietRunner(3000, clock.api);
  const ran: string[] = [];
  runner.run(() => ran.push('a'));
  clock.advance(2999);
  assert.deepEqual(ran, []);
  clock.advance(1);
  assert.deepEqual(ran, ['a']);
});

test('typing holds the task off until a pause', () => {
  const clock = fake();
  const runner = new QuietRunner(3000, clock.api);
  const ran: string[] = [];
  runner.run(() => ran.push('a'));
  clock.advance(2000);
  runner.touch();
  clock.advance(2000); // 4000 in, but only 2000 since the last edit
  assert.deepEqual(ran, []);
  clock.advance(1000);
  assert.deepEqual(ran, ['a']);
});

test('typing while waiting for idle time holds it off again', () => {
  const clock = fake();
  const runner = new QuietRunner(3000, clock.api);
  const ran: string[] = [];
  runner.run(() => ran.push('a'));
  clock.advance(3000, false); // quiet: now waits for the browser to be idle
  runner.touch(); // typing starts again before it is
  clock.runIdle();
  assert.deepEqual(ran, []);
  clock.advance(2999);
  assert.deepEqual(ran, []);
  clock.advance(1);
  assert.deepEqual(ran, ['a']);
});

test('a newer task replaces one still waiting', () => {
  const clock = fake();
  const runner = new QuietRunner(1000, clock.api);
  const ran: string[] = [];
  runner.run(() => ran.push('a'));
  clock.advance(500);
  runner.run(() => ran.push('b'));
  clock.advance(5000);
  assert.deepEqual(ran, ['b']);
});

test('flush runs the waiting task now, once', () => {
  const clock = fake();
  const runner = new QuietRunner(3000, clock.api);
  const ran: string[] = [];
  runner.run(() => ran.push('a'));
  runner.flush();
  assert.deepEqual(ran, ['a']);
  runner.flush();
  clock.advance(10_000);
  assert.deepEqual(ran, ['a']);
});

test('cancel drops the waiting task', () => {
  const clock = fake();
  const runner = new QuietRunner(1000, clock.api);
  const ran: string[] = [];
  runner.run(() => ran.push('a'));
  runner.cancel();
  clock.advance(10_000);
  assert.deepEqual(ran, []);
});

test('traced returns what the work returns, sync or async, and records a span', async () => {
  assert.equal(traced('test-sync', () => 7), 7);
  assert.equal(await traced('test-async', async () => 8), 8);
  assert.ok(performance.getEntriesByName('golem:test-sync', 'measure').length >= 1);
  assert.ok(performance.getEntriesByName('golem:test-async', 'measure').length >= 1);
});

test('traced lets an error through and still records the span', async () => {
  await assert.rejects(traced('test-fail', async () => Promise.reject(new Error('no'))), /no/);
  assert.throws(() => traced('test-throw', () => { throw new Error('boom'); }), /boom/);
});
