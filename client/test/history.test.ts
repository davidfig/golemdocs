// What the version history dialog shows and does (src/history.ts): this browser's and the account's versions as one list, and the name a
// restored document is given. The storage underneath is tested in localHistory.test.ts and the server's side in server/test/history.test.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHistory, restoredName, type HistoryDeps } from '../src/history.ts';

const deps = (device: { version: number; size: number; name: string | null }[] | Error, account: { version: number; size: number; name: string | null }[] | Error): HistoryDeps => ({
  listLocal: async () => {
    if (device instanceof Error) throw device;
    return device;
  },
  listCloud: async () => {
    if (account instanceof Error) throw account;
    return account;
  },
});

test('this browser’s versions and the account’s are one list, newest first, each saying where it is', async () => {
  const { entries, unreachable } = await loadHistory(
    { localId: 'a', cloudId: 'b' },
    deps([{ version: 100, size: 1, name: null }, { version: 300, size: 3, name: 'Sent' }], [{ version: 200, size: 2, name: null }]),
  );
  assert.deepEqual(entries.map((e) => [e.source, e.version, e.name]), [['device', 300, 'Sent'], ['account', 200, null], ['device', 100, null]]);
  assert.deepEqual(unreachable, []);
});

test('a source that cannot be reached is reported and the other still shows', async () => {
  const offline = await loadHistory({ localId: 'a', cloudId: 'b' }, deps([{ version: 1, size: 1, name: null }], new Error('offline')));
  assert.deepEqual(offline.entries.map((e) => e.source), ['device']);
  assert.deepEqual(offline.unreachable, ['account']);
  const damaged = await loadHistory({ localId: 'a', cloudId: 'b' }, deps(new Error('storage'), [{ version: 1, size: 1, name: null }]));
  assert.deepEqual(damaged.entries.map((e) => e.source), ['account']);
  assert.deepEqual(damaged.unreachable, ['device']);
});

test('a document with no copy in the account asks only this browser, and one with no copy here only the account', async () => {
  const asked: string[] = [];
  const watching: HistoryDeps = {
    listLocal: async (id) => (asked.push(`local:${id}`), []),
    listCloud: async (id) => (asked.push(`cloud:${id}`), []),
  };
  await loadHistory({ localId: 'a', cloudId: null }, watching);
  await loadHistory({ localId: null, cloudId: 'b' }, watching);
  assert.deepEqual(asked, ['local:a', 'cloud:b']);
});

test('a restored document is named like the original, with when the version was saved, keeping its extension', () => {
  const name = restoredName('Report.docx', Date.UTC(2026, 9, 6, 14, 30), 'en');
  assert.match(name, /^Report \(.*2026.*\)\.docx$/);
  assert.match(restoredName('Notes', Date.UTC(2026, 0, 2), 'en'), /^Notes \(.*\)$/);
  assert.match(restoredName('.hidden', Date.UTC(2026, 0, 2), 'en'), /^\.hidden \(.*\)$/);
});
