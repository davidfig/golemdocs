// A document's word history (src/wordHistory.ts): what was written each day and in each period, and how the open document's
// counts are kept on this device and sent to the account.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryWordStore, trimRecord } from '../src/storage/wordStore.ts';
import { CloudError } from '../src/cloud.ts';
import { DocumentWords, addDays, dailyProgress, dayOf, firstDayOfWeek, mergeDays, periodStart, periodWords, progressBars, writtenBetween, type WordApi, type WordDay } from '../src/wordHistory.ts';

const day = (d: string, words: number, start: number | null = null): WordDay => ({ day: d, words, start });

test('days are local dates, and adding days crosses months and years', () => {
  assert.equal(dayOf(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
});

test('a day’s progress is measured from its start, or from the day before when it has none', () => {
  const days = [day('2026-11-20', 100), day('2026-11-22', 180, 150), day('2026-11-23', 170), day('2026-11-24', 300, 0)];
  assert.deepEqual(dailyProgress(days), [
    { day: '2026-11-20', written: 0, words: 100 }, // the first day, with nothing to measure from
    { day: '2026-11-22', written: 30, words: 180 }, // edits between sessions (100 → 150) are not counted
    { day: '2026-11-23', written: -10, words: 170 }, // cutting counts too
    { day: '2026-11-24', written: 300, words: 300 },
  ]);
  assert.equal(writtenBetween(days, '2026-11-22', '2026-11-23'), 20);
  // Out of order in, in order out.
  assert.deepEqual(dailyProgress([day('2026-11-02', 5), day('2026-11-01', 2)]).map((d) => d.day), ['2026-11-01', '2026-11-02']);
});

test('periods end today: the week starts on the person’s first day of the week', () => {
  // 2026-11-26 is a Thursday.
  assert.equal(periodStart('today', '2026-11-26'), '2026-11-26');
  assert.equal(periodStart('week', '2026-11-26', 1), '2026-11-23', 'Monday');
  assert.equal(periodStart('week', '2026-11-26', 7), '2026-11-22', 'Sunday');
  assert.equal(periodStart('week', '2026-11-23', 1), '2026-11-23', 'a Monday starts its own week');
  assert.equal(periodStart('week', '2026-11-29', 1), '2026-11-23', 'a Sunday ends a Monday week');
  assert.equal(periodStart('month', '2026-11-26'), '2026-11-01');
  assert.equal(periodStart('year', '2026-11-26'), '2026-01-01');
  assert.equal(periodStart('total', '2026-11-26'), null);
});

test('the status bar’s number for each period', () => {
  const days = [day('2025-12-31', 50, 0), day('2026-11-02', 150, 100), day('2026-11-24', 400, 300), day('2026-11-26', 520, 400)];
  const at = (p: Parameters<typeof periodWords>[0]) => periodWords(p, days, 530, '2026-11-26', 1);
  assert.equal(at('total'), 530, 'the document’s words now');
  assert.equal(at('today'), 120);
  assert.equal(at('week'), 220);
  assert.equal(at('month'), 270);
  assert.equal(at('year'), 270);
  assert.equal(periodWords('today', [], 10, '2026-11-26'), 0, 'nothing written');
});

test('chart bars fill in the days and months with no writing', () => {
  const days = [day('2026-11-24', 400, 300), day('2026-11-26', 520, 400)];
  assert.deepEqual(progressBars(days, '2026-11-23', '2026-11-26', 'day'), [
    { key: '2026-11-23', written: 0 },
    { key: '2026-11-24', written: 100 },
    { key: '2026-11-25', written: 0 },
    { key: '2026-11-26', written: 120 },
  ]);
  assert.deepEqual(progressBars([...days, day('2025-11-03', 10, 0)], '2025-11-01', '2026-01-15', 'month'), [
    { key: '2025-11', written: 10 },
    { key: '2025-12', written: 0 },
    { key: '2026-01', written: 0 },
  ]);
});

test('merging: this device’s unsent days win, but a start known in the account is kept', () => {
  const merged = mergeDays([day('2026-11-25', 90, 80), day('2026-11-26', 100, 95)], [day('2026-11-26', 140, 120), day('2026-11-27', 10, 0)]);
  assert.deepEqual(merged, [day('2026-11-25', 90, 80), day('2026-11-26', 140, 95), day('2026-11-27', 10, 0)]);
});

test('the device keeps the latest days and every unsent one', () => {
  const days = Array.from({ length: 10 }, (_, i) => day(addDays('2026-01-01', i), i));
  const trimmed = trimRecord({ days, pending: ['2026-01-02'], filled: false, at: 0 }, 3);
  assert.deepEqual(trimmed.days.map((d) => d.day), ['2026-01-02', '2026-01-08', '2026-01-09', '2026-01-10']);
});

/** An account that keeps days in memory, as the server does. */
function fakeAccount(options: { refuse?: number } = {}) {
  const kept = new Map<string, Map<string, WordDay>>();
  const puts: { days: WordDay[]; fill: boolean }[] = [];
  const versionWords = new Map<number, number | null>();
  /** Versions that can't be asked about (offline). */
  const unreachable = new Set<number>();
  const api: WordApi = {
    async get(id) {
      if (options.refuse) throw new CloudError(options.refuse, 'no');
      return [...(kept.get(id)?.values() ?? [])].sort((a, b) => (a.day < b.day ? -1 : 1));
    },
    async put(id, days, o = {}) {
      if (options.refuse) throw new CloudError(options.refuse, 'no');
      puts.push({ days: [...days], fill: !!o.fill });
      const rows = kept.get(id) ?? new Map<string, WordDay>();
      kept.set(id, rows);
      for (const d of days) {
        const had = rows.get(d.day);
        if (had && o.fill) continue;
        // As the server: the day keeps its first start, unless the new one was moved past changes made elsewhere.
        rows.set(d.day, { day: d.day, words: d.words, start: d.shifted ? d.start : (had?.start ?? d.start) });
      }
    },
    async versions() {
      return [...versionWords.keys()].map((version) => ({ version }));
    },
    async versionWords(_id, version) {
      if (unreachable.has(version)) throw new Error('offline');
      return versionWords.get(version) ?? null;
    },
  };
  return { api, kept, puts, versionWords, unreachable, options };
}

const clock = (text: string) => {
  let now = new Date(text);
  return { now: () => now, set: (t: string) => (now = new Date(t)) };
};

test('opening and reading leaves nothing; writing keeps the day with where it started', async () => {
  const store = memoryWordStore();
  const account = fakeAccount();
  const time = clock('2026-11-26T10:00:00');
  const words = new DocumentWords({ key: 'cloud:d1', cloudId: 'd1' }, store, () => true, account.api, time.now);
  await words.ready();
  words.count(1000);
  words.count(1000);
  assert.deepEqual(words.history(), []);
  words.count(1012);
  words.count(1050);
  assert.deepEqual(words.history(), [day('2026-11-26', 1050, 1000)]);
  await words.flush();
  assert.deepEqual(store.records.get('cloud:d1')?.days, [day('2026-11-26', 1050, 1000)]);
  assert.deepEqual(store.records.get('cloud:d1')?.pending, []);
  assert.deepEqual([...account.kept.get('d1')!.values()], [day('2026-11-26', 1050, 1000)]);
  words.close();
});

test('a day that begins while the document is open starts where the last one ended', async () => {
  const time = clock('2026-11-26T23:58:00');
  const words = new DocumentWords({ key: 'local:a', cloudId: null }, memoryWordStore(), () => false, fakeAccount().api, time.now);
  await words.ready();
  words.count(100);
  words.count(130);
  time.set('2026-11-27T00:03:00');
  words.count(150);
  assert.deepEqual(words.history(), [day('2026-11-26', 130, 100), day('2026-11-27', 150, 130)]);
  words.close();
});

test('the account’s days come in with the device’s own, and another device’s start for today is kept', async () => {
  const store = memoryWordStore();
  const account = fakeAccount();
  await account.api.put('d1', [day('2026-11-25', 900, 800), day('2026-11-26', 1000, 950)]);
  const time = clock('2026-11-26T15:00:00');
  const words = new DocumentWords({ key: 'cloud:d1', cloudId: 'd1' }, store, () => true, account.api, time.now);
  await words.ready();
  words.count(1000);
  words.count(1100);
  assert.deepEqual(words.history(), [day('2026-11-25', 900, 800), day('2026-11-26', 1100, 950)]);
  words.close();
});

test('without sync, or refused by the account, the history stays on this device', async () => {
  const store = memoryWordStore();
  const account = fakeAccount({ refuse: 402 });
  const time = clock('2026-11-26T10:00:00');
  const words = new DocumentWords({ key: 'cloud:d1', cloudId: 'd1' }, store, () => true, account.api, time.now);
  await words.ready();
  words.count(10);
  words.count(20);
  await words.flush();
  assert.deepEqual(store.records.get('cloud:d1')?.days, [day('2026-11-26', 20, 10)]);
  words.close();
});

test('a document first uploaded takes its history to the account', async () => {
  const store = memoryWordStore();
  const account = fakeAccount();
  const time = clock('2026-11-26T10:00:00');
  const words = new DocumentWords({ key: 'local:a', cloudId: null }, store, () => true, account.api, time.now);
  await words.ready();
  words.count(0);
  words.count(42);
  await words.flush();
  assert.ok(store.records.has('local:a'));
  assert.equal(account.puts.length, 0);
  await words.moved({ key: 'cloud:d9', cloudId: 'd9' });
  await words.flush();
  assert.ok(!store.records.has('local:a'));
  assert.deepEqual(store.records.get('cloud:d9')?.days, [day('2026-11-26', 42, 0)]);
  assert.deepEqual([...account.kept.get('d9')!.values()], [day('2026-11-26', 42, 0)]);
  words.close();
});

test('the days before the history began are filled in from the last version of each, once', async () => {
  const store = memoryWordStore();
  const account = fakeAccount();
  const at = (t: string) => new Date(t).getTime();
  account.versionWords.set(at('2026-11-20T09:00:00'), 100);
  account.versionWords.set(at('2026-11-20T18:00:00'), 140); // the day’s last
  account.versionWords.set(at('2026-11-22T12:00:00'), null); // nothing the server can count
  account.versionWords.set(at('2026-11-26T08:00:00'), 999); // a day already kept
  await account.api.put('d1', [day('2026-11-26', 300, 200)]);
  const time = clock('2026-11-26T15:00:00');
  const words = new DocumentWords({ key: 'cloud:d1', cloudId: 'd1' }, store, () => true, account.api, time.now);
  assert.equal(await words.fillFromVersions(), 1);
  assert.deepEqual(words.history(), [day('2026-11-20', 140), day('2026-11-26', 300, 200)]);
  assert.deepEqual(account.puts.at(-1), { days: [day('2026-11-20', 140)], fill: true });
  assert.equal(await words.fillFromVersions(), 0, 'once');
  words.close();
  // Another session on this device doesn't do it again either.
  const again = new DocumentWords({ key: 'cloud:d1', cloudId: 'd1' }, store, () => true, account.api, time.now);
  assert.equal(await again.fillFromVersions(), 0);
  again.close();
});

test('the week starts where the person is: a language with no region takes the browser’s', () => {
  assert.equal(firstDayOfWeek('en', ['en-GB']), 1, 'English in Britain: Monday');
  assert.equal(firstDayOfWeek('en', ['en-US']), 7, 'English in the United States: Sunday');
  assert.equal(firstDayOfWeek('en', ['fr', 'en-AU']), 1, 'the first language that names a region');
  assert.equal(firstDayOfWeek('de', ['en-US']), 7, 'the region decides, not the language');
  assert.equal(firstDayOfWeek('en-GB', ['en-US']), 1, 'a locale with a region keeps it');
  assert.equal(firstDayOfWeek('de', []), 1);
  assert.equal(firstDayOfWeek('en', ['not a tag', 'en-GB']), 1);
});

test('words changed elsewhere between two sessions of a day are not counted as written', async () => {
  const store = memoryWordStore();
  const account = fakeAccount();
  const time = clock('2026-11-26T09:00:00');
  const morning = new DocumentWords({ key: 'cloud:d1', cloudId: 'd1' }, store, () => true, account.api, time.now);
  await morning.ready();
  morning.count(1000);
  morning.count(1100); // 100 written
  morning.close();
  await new Promise((r) => setTimeout(r, 0));

  // At noon an agent adds 2000 words to the file; the afternoon's session opens it with them.
  time.set('2026-11-26T14:00:00');
  const afternoon = new DocumentWords({ key: 'cloud:d1', cloudId: 'd1' }, store, () => true, account.api, time.now);
  await afternoon.ready();
  afternoon.count(3100);
  assert.equal(writtenBetween(afternoon.history(), '2026-11-26', '2026-11-26'), 100, 'only the morning’s writing');
  afternoon.count(3150);
  // 100 in the morning and 50 now: the 2000 between are moved past.
  assert.deepEqual(afternoon.history(), [{ day: '2026-11-26', words: 3150, start: 3000, shifted: true }]);
  await afternoon.flush();
  assert.deepEqual([...account.kept.get('d1')!.values()], [day('2026-11-26', 3150, 3000)], 'the account takes the moved start');
  assert.deepEqual(afternoon.history(), [day('2026-11-26', 3150, 3000)], 'and it is not sent to replace it again');
  afternoon.close();

  // Opened again with nothing changed in between: nothing moves.
  await new Promise((r) => setTimeout(r, 0));
  const evening = new DocumentWords({ key: 'cloud:d1', cloudId: 'd1' }, store, () => true, account.api, time.now);
  await evening.ready();
  evening.count(3150);
  assert.deepEqual(evening.history(), [day('2026-11-26', 3150, 3000)]);
  evening.close();
});

test('words cut elsewhere between sessions are not counted either, and a count before the days arrive is settled once they do', async () => {
  const account = fakeAccount();
  await account.api.put('d1', [day('2026-11-26', 500, 400)]);
  const time = clock('2026-11-26T15:00:00');
  const words = new DocumentWords({ key: 'cloud:d1', cloudId: 'd1' }, memoryWordStore(), () => true, account.api, time.now);
  // Counted before this device's and the account's days are in.
  words.count(450);
  words.count(470);
  await words.ready();
  await words.flush();
  assert.deepEqual(words.history(), [day('2026-11-26', 470, 350)], '100 before, and 20 now');
  assert.deepEqual([...account.kept.get('d1')!.values()], [day('2026-11-26', 470, 350)]);
  words.close();
});

test('versions that could not be asked about are asked about the next time', async () => {
  const store = memoryWordStore();
  const account = fakeAccount();
  const at = (t: string) => new Date(t).getTime();
  account.versionWords.set(at('2026-11-20T18:00:00'), 140);
  account.versionWords.set(at('2026-11-21T18:00:00'), 160);
  account.unreachable.add(at('2026-11-21T18:00:00'));
  const time = clock('2026-11-26T15:00:00');
  const words = new DocumentWords({ key: 'cloud:d1', cloudId: 'd1' }, store, () => true, account.api, time.now);
  assert.equal(await words.fillFromVersions(), 1);
  assert.deepEqual(words.history(), [day('2026-11-20', 140)]);
  assert.equal(store.records.get('cloud:d1')?.filled, false, 'not done with');
  account.unreachable.clear();
  assert.equal(await words.fillFromVersions(), 1, 'only the one it could not ask about');
  assert.deepEqual(words.history(), [day('2026-11-20', 140), day('2026-11-21', 160)]);
  assert.equal(await words.fillFromVersions(), 0, 'then done');
  words.close();
});

test('refused by the account, then signed in again or moved: what was written goes to the account', async () => {
  const account = fakeAccount({ refuse: 401 });
  const time = clock('2026-11-26T10:00:00');
  const words = new DocumentWords({ key: 'cloud:d1', cloudId: 'd1' }, memoryWordStore(), () => true, account.api, time.now);
  await words.ready();
  words.count(10);
  words.count(20);
  await words.flush();
  assert.equal(account.puts.length, 0);
  delete account.options.refuse;
  words.retry();
  await new Promise((r) => setTimeout(r, 0));
  await words.flush();
  assert.deepEqual([...account.kept.get('d1')!.values()], [day('2026-11-26', 20, 10)]);
  words.close();

  const other = fakeAccount({ refuse: 404 });
  const moving = new DocumentWords({ key: 'cloud:d2', cloudId: 'd2' }, memoryWordStore(), () => true, other.api, time.now);
  await moving.ready();
  moving.count(5);
  moving.count(8);
  await moving.flush();
  delete other.options.refuse;
  await moving.moved({ key: 'cloud:d3', cloudId: 'd3' });
  await moving.flush();
  assert.deepEqual([...other.kept.get('d3')!.values()], [day('2026-11-26', 8, 5)]);
  moving.close();
});
