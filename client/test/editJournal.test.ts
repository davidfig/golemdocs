import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Operation } from '@golemdocs/ops';
import { EditJournal, MAX_ENTRY_CHARS, MAX_JOURNAL_CHARS, hasJournal, journalDocuments, planRecovery, readJournals, removeJournal, type JournalStore, type StoredJournal } from '../src/storage/editJournal.ts';

const DOC = '11111111-1111-4111-8111-111111111111';
const S1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function memory(limit = Infinity): JournalStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      if ([...map.values()].join('').length + v.length > limit) throw new DOMException('full', 'QuotaExceededError');
      map.set(k, v);
    },
    removeItem: (k) => void map.delete(k),
  };
}

const type = (text: string): Operation[] => [{ type: 'insertText', paragraph: '00000001', offset: 0, text }];
const texts = (j: StoredJournal) => j.batches.map((b) => (b[0] as { text: string }).text);

test('nothing is kept until there is an edit, and a save holding them all leaves nothing', () => {
  const store = memory();
  const journal = new EditJournal(store, S1, 'page');
  journal.attach(DOC, 100);
  assert.equal(hasJournal(store, DOC), false);
  journal.add(1, type('a'));
  journal.add(2, type('b'));
  assert.deepEqual(texts(readJournals(store, DOC)[0]), ['a', 'b']);
  journal.saved(DOC, 200, 2);
  assert.equal(store.map.size, 0);
});

test('a save keeps the edits made after what it holds, and the journal then follows that save', () => {
  const store = memory();
  const journal = new EditJournal(store, S1, 'page');
  journal.attach(DOC, 100);
  journal.add(1, type('a'));
  journal.add(2, type('b'));
  journal.saved(DOC, 200, 1);
  const [kept] = readJournals(store, DOC);
  assert.deepEqual(texts(kept), ['b']);
  assert.equal(kept.base, 200);
});

test('edits made before a new document has a place wait for its first save, and only those it does not hold are written', () => {
  const store = memory();
  const journal = new EditJournal(store, S1, 'page');
  journal.add(1, type('a'));
  journal.add(2, type('b'));
  assert.equal(store.map.size, 0);
  journal.saved(DOC, 100, 1);
  assert.deepEqual(texts(readJournals(store, DOC)[0]), ['b']);
});

test('a barrier stops replay there, and no later edit is kept until a save passes it', () => {
  const store = memory();
  const journal = new EditJournal(store, S1, 'page');
  journal.attach(DOC, 100);
  journal.add(1, type('a'));
  journal.barrier(2);
  assert.equal(journal.add(3, type('c')), false);
  let [kept] = readJournals(store, DOC);
  assert.deepEqual(texts(kept), ['a']);
  assert.equal(kept.cut, true);
  journal.saved(DOC, 200, 3);
  assert.equal(journal.blocked, false);
  assert.equal(journal.add(4, type('d')), true);
  [kept] = readJournals(store, DOC);
  assert.deepEqual(texts(kept), ['d']);
  assert.equal(kept.cut, false);
});

test('a save that passes a barrier but not the edits dropped after it does not let replay skip them', () => {
  const store = memory();
  const journal = new EditJournal(store, S1, 'page');
  journal.attach(DOC, 100);
  journal.barrier(1);
  journal.add(2, type('in the save'));
  journal.add(3, type('dropped, and not in the save'));
  journal.saved(DOC, 200, 2);
  assert.equal(journal.blocked, true);
  assert.equal(journal.add(4, type('after the gap')), false);
  const [kept] = readJournals(store, DOC);
  assert.deepEqual(kept.batches, []);
  assert.equal(kept.cut, true);
  journal.saved(DOC, 300, 4);
  assert.equal(journal.blocked, false);
  assert.equal(journal.add(5, type('fine now')), true);
  assert.deepEqual(texts(readJournals(store, DOC)[0]), ['fine now']);
});

test('an edit too big to keep, a journal grown too big, and a full store each stop it, without throwing', () => {
  const big = memory();
  const huge = new EditJournal(big, S1, 'page');
  huge.attach(DOC, 100);
  assert.equal(huge.add(1, type('x'.repeat(MAX_ENTRY_CHARS))), false);
  assert.equal(huge.blocked, true);

  const long = new EditJournal(memory(), S1, 'page');
  long.attach(DOC, 100);
  let n = 0;
  while (long.add(++n, type('x'.repeat(MAX_ENTRY_CHARS / 2))));
  assert.ok(n * (MAX_ENTRY_CHARS / 2) >= MAX_JOURNAL_CHARS);

  const full = memory(400);
  const journal = new EditJournal(full, S1, 'page');
  journal.attach(DOC, 100);
  assert.equal(journal.add(1, type('fits')), true);
  assert.equal(journal.add(2, type('x'.repeat(1000))), false);
  assert.deepEqual(texts(readJournals(full, DOC)[0]), ['fits']);
});

test('clear leaves nothing behind; removeJournal takes one session and leaves the other', () => {
  const store = memory();
  const a = new EditJournal(store, S1, 'page');
  a.attach(DOC, 100);
  a.add(1, type('a'));
  a.barrier(2);
  a.clear();
  assert.equal(store.map.size, 0);
  assert.equal(a.blocked, false);
  a.add(3, type('a'));
  const b = new EditJournal(store, S2, 'page');
  b.attach(DOC, 100);
  b.add(1, type('b'));
  removeJournal(store, DOC, S1);
  assert.deepEqual(readJournals(store, DOC).map((j) => j.session), [S2]);
  assert.deepEqual([...journalDocuments(store)], [DOC]);
});

test('an edit this version does not know stops the replay there, and it says so', () => {
  const store = memory();
  const journal = new EditJournal(store, S1, 'page');
  journal.attach(DOC, 100);
  journal.add(1, type('known'));
  journal.add(2, [{ type: 'fromTheFuture' } as unknown as Operation]);
  journal.add(3, type('after'));
  const [kept] = readJournals(store, DOC);
  assert.deepEqual(texts(kept), ['known']);
  assert.equal(kept.cut, true);
});

const stored = (over: Partial<StoredJournal>): StoredJournal => ({ session: S1, page: 'gone', startedAt: 1, base: 100, batches: [type('a'), type('b')], numbers: [1, 2], cut: false, ...over });
const NONE = new Set<string>();

test('open: another open page keeps its journal', () => {
  const plan = planRecovery({ updatedAt: 100 }, [stored({ page: 'alive' })], new Set(['alive']));
  assert.deepEqual(plan, { replay: [], absorb: [], conflict: [], conflicted: [], discard: [], cut: false });
});

test('open: the stored copy is the one the journal follows, so all of it goes back', () => {
  const plan = planRecovery({ updatedAt: 100 }, [stored({})], NONE);
  assert.deepEqual(plan.replay, [type('a'), type('b')]);
  assert.deepEqual(plan.absorb, [S1]);
});

test('open: the copy is this session\'s own, so only what lies past its marker goes back: nothing is applied twice', () => {
  const plan = planRecovery({ updatedAt: 999, journal: { session: S1, seq: 1 } }, [stored({})], NONE);
  assert.deepEqual(plan.replay, [type('b')]);
  const all = planRecovery({ updatedAt: 999, journal: { session: S1, seq: 2 } }, [stored({})], NONE);
  assert.deepEqual(all.replay, []);
  assert.deepEqual(all.discard, [S1]);
});

test('open: someone else wrote the copy since, so the edits go in a copy of their own and not over it', () => {
  for (const info of [{ updatedAt: 200 }, { updatedAt: 200, journal: { session: S2, seq: 9 } }]) {
    const plan = planRecovery(info, [stored({})], NONE);
    assert.deepEqual(plan.replay, []);
    assert.deepEqual(plan.conflict, [type('a'), type('b')]);
    assert.deepEqual(plan.conflicted, [S1]);
  }
});

test('open: a journal the copy already took in is done with, even if taking it out never happened', () => {
  const plan = planRecovery({ updatedAt: 200, journal: { session: S2, seq: 0, absorbed: [S1] } }, [stored({})], NONE);
  assert.deepEqual(plan.discard, [S1]);
  assert.deepEqual(plan.replay, []);
  assert.deepEqual(plan.conflict, []);
});

test('open: two journals on one copy go back oldest first (a reload after a reload, before a save)', () => {
  const plan = planRecovery({ updatedAt: 100 }, [stored({ startedAt: 1 }), stored({ session: S2, startedAt: 2, batches: [type('c')], numbers: [1] })], NONE);
  assert.deepEqual(plan.replay, [type('a'), type('b'), type('c')]);
  assert.deepEqual(plan.absorb, [S1, S2]);
});

test('open: a cut is only reported when it is past what the copy holds', () => {
  const past = planRecovery({ updatedAt: 100 }, [stored({ batches: [], numbers: [1], cut: true })], NONE);
  assert.equal(past.cut, true);
  assert.deepEqual(past.discard, [S1]);
  const held = planRecovery({ updatedAt: 200, journal: { session: S1, seq: 5 } }, [stored({ batches: [], numbers: [1], cut: true })], NONE);
  assert.equal(held.cut, false);
});
