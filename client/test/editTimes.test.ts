// View › Debug › Edit times (src/editTimes.ts): the worst recent edit and the slow count, so a single stall can still be seen.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeEdit, EDIT_WINDOW_MS, EditTimes, SLOW_EDIT_MS } from '../src/editTimes.ts';

test('keeps the worst edit and counts the slow ones, after faster edits have come', () => {
  const times = new EditTimes();
  times.record({ at: 1000, total: 4, worker: 2 });
  times.record({ at: 1100, total: 80, worker: 3 });
  times.record({ at: 1200, total: SLOW_EDIT_MS, worker: 2 }); // not over the line
  times.record({ at: 1300, total: 5, worker: 2 });
  const summary = times.summary(1300)!;
  assert.equal(summary.last.total, 5);
  assert.deepEqual(summary.worst, { at: 1100, total: 80, worker: 3 });
  assert.equal(summary.slow, 1);
  assert.equal(summary.count, 4);
});

test('forgets edits older than the window', () => {
  const times = new EditTimes();
  times.record({ at: 0, total: 200, worker: 1 });
  times.record({ at: 10, total: 5, worker: 1 });
  const summary = times.summary(EDIT_WINDOW_MS + 5)!;
  assert.equal(summary.worst.total, 5);
  assert.equal(summary.slow, 0);
  assert.equal(times.summary(EDIT_WINDOW_MS * 3), null);
});

test('says where the worst edit spent its time', () => {
  assert.deepEqual(
    describeEdit({ at: 0, total: 130, worker: 12.4, spell: 8.2, waited: { ms: 95.3, behind: [{ name: 'save', ms: 90.1 }, { name: 'layout', ms: 4.2 }] }, answered: 120 }),
    { waited: '95 ms (save 90 ms, layout 4 ms)', worker: '12 ms (spelling 8 ms)', page: '12 ms', draw: '10 ms' },
  );
  // Neither waiting nor the worker: the page was busy before it took the answer.
  assert.deepEqual(describeEdit({ at: 0, total: 97, worker: 1, answered: 90 }), { waited: '0 ms', worker: '1 ms', page: '89 ms', draw: '7 ms' });
});

test('names what the page was busy with when it held the answer up', () => {
  const time = { at: 0, total: 130, worker: 1, answered: 120, page: { ms: 118, behind: [{ name: 'autosave', ms: 90 }, { name: 'other', ms: 28 }] } };
  assert.equal(describeEdit(time).page, '118 ms (autosave 90 ms, other 28 ms)');
});
