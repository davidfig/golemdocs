// Live blocks kept up to date in the background (docs/live-blocks.md §6, *Updates in the background*): the sources changed
// since the account's marker, whoever changed them, and what shows them, one document at a time within this device's limit.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackgroundLive } from '../src/live/background.ts';
import type { BackgroundEntry, LiveMarker, MarkerChange } from '../src/live/background.ts';

interface Doc extends BackgroundEntry {
  /** The documents its blocks read. */
  reads: string[];
}

const doc = (key: string, updatedAt: number, reads: string[] = [], size = 1000): Doc => ({ key, cloud: { id: `c-${key}`, updatedAt }, size, reads });

function setup(docs: Doc[], marker: Partial<LiveMarker> = {}, limit = 10_000, busy = new Set<string>()) {
  const state: LiveMarker = { kept: true, workedTo: 100, deferred: [], now: 1000, ...marker };
  const moves: MarkerChange[] = [];
  const updated: string[] = [];
  const progress: (number | null)[] = [];
  let idles = 0;
  const live = new BackgroundLive<Doc>({
    marker: async () => ({ ...state, deferred: [...state.deferred] }),
    async move(change) {
      moves.push(change);
      if (change.workedTo !== undefined) state.workedTo = Math.max(state.workedTo ?? 0, change.workedTo);
      state.deferred = [...new Set([...state.deferred, ...(change.defer ?? [])])].filter((id) => !(change.done ?? []).includes(id));
    },
    entries: () => docs,
    dependents: async (keys) => docs.filter((d) => d.reads.some((r) => keys.includes(r))),
    sources: async (entry) => docs.filter((d) => entry.reads.includes(d.key)),
    async update(entry) {
      updated.push(entry.key);
      return busy.has(entry.key) ? 'notNow' : 'written';
    },
    limit: () => limit,
    idle: async () => void idles++,
    progress: (left) => progress.push(left),
  });
  return { live, state, moves, updated, progress, idles: () => idles };
}

test('the dependents of sources changed since the marker are updated, in the order the sources changed, and the marker follows', async () => {
  const docs = [doc('budget', 300), doc('notes', 200), doc('old', 50), doc('summary', 90, ['budget']), doc('journal', 90, ['notes', 'budget']), doc('archive', 90, ['old'])];
  const { live, state, updated, progress } = setup(docs);
  await live.look();
  // notes changed first: journal; then budget: summary (journal is done once).
  assert.deepEqual(updated, ['journal', 'summary']);
  assert.equal(state.workedTo, 300);
  assert.deepEqual(progress, [2, 1, null]);
});

test('the first device to start only sets the marker; no account marker, nothing happens', async () => {
  const docs = [doc('budget', 300), doc('summary', 90, ['budget'])];
  const first = setup(docs, { workedTo: null });
  await first.live.look();
  assert.deepEqual(first.updated, []);
  assert.equal(first.state.workedTo, 1000);
  const none = setup(docs, { kept: false });
  await none.live.look();
  assert.deepEqual(none.updated, []);
  assert.deepEqual(none.moves, []);
});

test('a document too large for this device is deferred, and a larger device does it', async () => {
  const docs = [doc('workbook', 300, [], 30_000), doc('report', 90, ['workbook'], 5_000), doc('memo', 90, ['workbook'], 100)];
  // A phone: report and its workbook are over its limit. memo too (the workbook is what it loads).
  const phone = setup(docs, {}, 20_000);
  await phone.live.look();
  assert.deepEqual(phone.updated, []);
  assert.deepEqual(phone.state.deferred, ['c-report', 'c-memo']);
  assert.equal(phone.state.workedTo, 300);
  // A computer, later: nothing changed since, but the deferred ones are done and taken off.
  const computer = setup(docs, { workedTo: 300, deferred: ['c-report', 'c-memo', 'c-gone'] }, 100_000);
  await computer.live.look();
  assert.deepEqual(computer.updated, ['report', 'memo']);
  assert.deepEqual(computer.state.deferred, []);
});

test('every update waits for the person to be idle; a look asked for meanwhile follows the one running', async () => {
  const docs = [doc('a', 300), doc('b', 90, ['a']), doc('c', 90, ['a'])];
  const run = setup(docs);
  const first = run.live.look();
  const second = run.live.look();
  // Updating b and c changes them in the account: the second look finds them as sources (nothing shows them).
  docs[1].cloud!.updatedAt = 400;
  docs[2].cloud!.updatedAt = 401;
  await Promise.all([first, second]);
  assert.deepEqual(run.updated, ['b', 'c']);
  assert.equal(run.idles(), 2);
  assert.equal(run.state.workedTo, 401);
});

test('a source changed with nothing showing it moves the marker on once', async () => {
  const docs = [doc('a', 200), doc('b', 300)];
  const run = setup(docs);
  await run.live.look();
  assert.deepEqual(run.moves, [{ workedTo: 300 }]);
});

test('a document that can’t be written now is deferred and tried again; the marker still moves on', async () => {
  const docs = [doc('budget', 300), doc('shared', 90, ['budget']), doc('mine', 90, ['budget'])];
  const busy = new Set(['shared']);
  const run = setup(docs, {}, 10_000, busy);
  await run.live.look();
  assert.deepEqual(run.updated, ['shared', 'mine']);
  assert.deepEqual(run.state.deferred, ['c-shared']);
  assert.equal(run.state.workedTo, 300);
  // Still busy: it stays deferred. Free: done, and taken off.
  await run.live.look();
  assert.deepEqual(run.state.deferred, ['c-shared']);
  busy.clear();
  await run.live.look();
  assert.deepEqual(run.state.deferred, []);
  assert.deepEqual(run.updated, ['shared', 'mine', 'shared', 'shared']);
});
