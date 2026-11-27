// What the layout worker was doing while a keystroke waited (src/layout/taskLog.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskLog } from '../src/layout/taskLog.ts';

test('a wait is put down to the tasks that ran during it, most first', () => {
  const log = new TaskLog();
  log.begin('insert', 1000);
  log.begin('save', 1002);
  log.begin('layout', 1092);
  log.begin('insert', 1100); // the keystroke, sent at 1010
  assert.deepEqual(log.within(1010, 1100), [
    { name: 'save', ms: 82 },
    { name: 'layout', ms: 8 },
  ]);
});

test('a task running on is one span, and the one running now counts up to the end of the wait', () => {
  const log = new TaskLog();
  log.begin('layout', 0);
  log.begin('layout', 30);
  log.begin('layout', 60);
  assert.deepEqual(log.within(10, 70), [{ name: 'layout', ms: 60 }]);
});

test('tasks under a millisecond are left out, and only the longest few are named', () => {
  const log = new TaskLog();
  ['a', 'b', 'c', 'd'].forEach((name, i) => log.begin(name, i * 10));
  log.begin('tiny', 40);
  log.begin('e', 40.5);
  assert.deepEqual(
    log.within(0, 41, 3).map((task) => task.name),
    ['a', 'b', 'c'],
  );
});
