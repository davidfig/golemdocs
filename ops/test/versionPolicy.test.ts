import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHECKPOINT_GAP, CLOUD_LIMITS, byteBudget, shouldCheckpoint, versionsToDrop, type VersionStamp } from '../src/index.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 1_000 * DAY;
const limits = { ...CLOUD_LIMITS, maxBytes: Infinity };
const v = (ago: number, size = 100, named = false): VersionStamp => ({ at: NOW - ago, size, ...(named ? { named } : {}) });

test('the first save of a document is checkpointed', () => {
  assert.equal(shouldCheckpoint({ lastAt: null, replacedAt: NOW - HOUR, replacedSize: 1000, nextSize: 1100, now: NOW }), true);
});

test('saves in the middle of a burst keep nothing; a long burst keeps one every gap', () => {
  const last = NOW - 3 * HOUR;
  const replacedAt = NOW - MIN; // saved a minute ago: the burst goes on
  assert.equal(shouldCheckpoint({ lastAt: last, replacedAt, replacedSize: 1000, nextSize: 1000, now: NOW }), true, 'but the last checkpoint is old');
  assert.equal(shouldCheckpoint({ lastAt: NOW - 5 * MIN, replacedAt, replacedSize: 1000, nextSize: 1000, now: NOW }), false);
  assert.equal(shouldCheckpoint({ lastAt: replacedAt - CHECKPOINT_GAP, replacedAt, replacedSize: 1000, nextSize: 1000, now: NOW }), true);
});

test('a save after a pause keeps the version the pause followed', () => {
  const last = NOW - 3 * HOUR;
  const replacedAt = last + 3 * MIN; // inside the last checkpoint's gap
  assert.equal(shouldCheckpoint({ lastAt: last, replacedAt, replacedSize: 1000, nextSize: 1000, now: replacedAt + CHECKPOINT_GAP - 1 }), false);
  assert.equal(shouldCheckpoint({ lastAt: last, replacedAt, replacedSize: 1000, nextSize: 1000, now: replacedAt + CHECKPOINT_GAP }), true);
});

test('a version already kept is not kept twice', () => {
  assert.equal(shouldCheckpoint({ lastAt: NOW, replacedAt: NOW, replacedSize: 1000, nextSize: 1, now: NOW }), false);
});

test('a save that shrinks the document sharply is checkpointed inside the gap', () => {
  const last = NOW - 5 * MIN;
  assert.equal(shouldCheckpoint({ lastAt: last, replacedAt: NOW - MIN, replacedSize: 100_000, nextSize: 20_000, now: NOW }), true);
  assert.equal(shouldCheckpoint({ lastAt: last, replacedAt: NOW - MIN, replacedSize: 100_000, nextSize: 80_000, now: NOW }), false);
  // tiny documents are not judged by it
  assert.equal(shouldCheckpoint({ lastAt: last, replacedAt: NOW - MIN, replacedSize: 500, nextSize: 10, now: NOW }), false);
});

test('recent versions are all kept, older ones thin to one per hour, day and week', () => {
  assert.deepEqual(versionsToDrop([v(5 * MIN), v(20 * MIN), v(50 * MIN)], NOW, limits), []);
  // The newest three are never thinned by age, so these are older than three fresher ones.
  const fresh = [v(MIN), v(2 * MIN), v(3 * MIN)];
  // three in one hour-bucket, a few hours old: the newest stays
  const bucketStart = Math.floor((NOW - 3 * HOUR) / HOUR) * HOUR;
  const hour: VersionStamp[] = [bucketStart + 10 * MIN, bucketStart + 20 * MIN, bucketStart + 30 * MIN].map((t) => ({ at: t, size: 100 }));
  assert.deepEqual(versionsToDrop([...fresh, ...hour], NOW, limits).sort(), [hour[0]!.at, hour[1]!.at].sort());
  // two in one day, a week old
  const dayStart = Math.floor((NOW - 7 * DAY) / DAY) * DAY;
  assert.deepEqual(versionsToDrop([...fresh, { at: dayStart + HOUR, size: 1 }, { at: dayStart + 5 * HOUR, size: 1 }], NOW, limits), [dayStart + HOUR]);
  // two in one week, two months old
  const weekStart = Math.floor((NOW - 60 * DAY) / (7 * DAY)) * 7 * DAY;
  assert.deepEqual(versionsToDrop([...fresh, { at: weekStart + DAY, size: 1 }, { at: weekStart + 2 * DAY, size: 1 }], NOW, limits), [weekStart + DAY]);
});

test('what is older than three months goes, but the newest three are kept however old', () => {
  assert.deepEqual(versionsToDrop([v(91 * DAY)], NOW, limits), []);
  const old = [91, 92, 93, 94].map((days) => v(days * DAY));
  assert.deepEqual(versionsToDrop(old, NOW, limits), [NOW - 94 * DAY]);
});

test('named versions outlive their age and the byte budget', () => {
  const old = v(200 * DAY, 10_000_000, true);
  assert.deepEqual(versionsToDrop([old, v(MIN, 100)], NOW, { ...limits, maxBytes: 1000 }), []);
});

test('the count cap drops the oldest unnamed, and the byte cap the same way', () => {
  const spread = Array.from({ length: 12 }, (_, i) => v(MIN + i * 5 * MIN));
  const dropped = versionsToDrop(spread, NOW, { ...limits, maxUnnamed: 10 });
  assert.deepEqual(dropped.sort(), [NOW - MIN - 10 * 5 * MIN, NOW - MIN - 11 * 5 * MIN].sort());
  const bytes = versionsToDrop([v(MIN, 600), v(2 * MIN, 600), v(3 * MIN, 600)], NOW, { ...limits, maxBytes: 1000 });
  assert.deepEqual(bytes.sort(), [NOW - 2 * MIN, NOW - 3 * MIN].sort());
});

test('only the oldest named versions beyond the cap go', () => {
  const named = [v(MIN, 1, true), v(2 * MIN, 1, true), v(3 * MIN, 1, true)];
  assert.deepEqual(versionsToDrop(named, NOW, { ...limits, maxNamed: 2 }), [NOW - 3 * MIN]);
});

test('a document’s byte budget grows with its size but has a floor', () => {
  assert.equal(byteBudget(10), 5 * 1024 * 1024);
  assert.equal(byteBudget(10 * 1024 * 1024), 80 * 1024 * 1024);
});
