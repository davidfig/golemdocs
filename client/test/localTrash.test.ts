// The trash in this browser (src/storage/local.ts, "Trash") and the one list the app makes of it and the account's (src/trash.ts).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { fakeIndexedDB } from './fakeIndexedDB.ts';
import { EMPTY_AT_ONCE, emptyTrash, loadTrash, TrashStore, trashKey, type TrashDeps, type TrashItem } from '../src/trash.ts';

(globalThis as { indexedDB: unknown }).indexedDB = fakeIndexedDB();
const local = await import('../src/storage/local.ts');

const DAY = 24 * 60 * 60 * 1000;
const realNow = Date.now;
let clock = 0;

function random(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}
const filled = (n: number, length = 3000) => new Uint8Array(length).fill(n);

beforeEach(async () => {
  clock = realNow.call(Date);
  Date.now = () => clock;
  await local.purgeTrashedSaved();
  for (const d of await local.listSaved()) await local.deleteSaved(d.id);
});
afterEach(() => {
  Date.now = realNow;
});

test('a trashed document leaves the list of documents and comes back as it was', async () => {
  const doc = await local.saveSaved({ name: 'A.docx', bytes: filled(1) });
  await local.trashSaved(doc.id);
  assert.deepEqual(await local.listSaved(), []);
  assert.equal(await local.getSaved(doc.id), null, 'it cannot be opened from the trash');
  const trashed = await local.listTrashedSaved();
  assert.deepEqual(trashed.map((r) => [r.info.id, r.info.name]), [[doc.id, 'A.docx']]);
  const back = await local.restoreTrashedSaved(doc.id);
  assert.equal(back?.updatedAt, doc.updatedAt);
  assert.deepEqual([...new Set(new Uint8Array((await local.getSaved(doc.id))!.bytes))], [1]);
  assert.deepEqual(await local.listTrashedSaved(), []);
  assert.equal(await local.restoreTrashedSaved(doc.id), null, 'once');
});

test('a trashed document can be read, whole or kept as chunks, to look at before it comes back', async () => {
  const small = await local.saveSaved({ name: 'A.docx', bytes: filled(7) });
  const big = await local.saveSaved({ name: 'Big.txt', bytes: random(6_000_000, 9) });
  assert.equal(await local.getTrashedSaved(small.id), null, 'not in the trash yet');
  await local.trashSaved(small.id);
  await local.trashSaved(big.id);
  const read = await local.getTrashedSaved(small.id);
  assert.equal(read?.info.name, 'A.docx');
  assert.deepEqual([...new Set(new Uint8Array(read!.bytes))], [7]);
  assert.deepEqual(new Uint8Array((await local.getTrashedSaved(big.id))!.bytes), random(6_000_000, 9));
  await local.purgeTrashedSaved(small.id);
  assert.equal(await local.getTrashedSaved(small.id), null, 'gone for good');
});

test('its history goes into the trash with it and returns with it', async () => {
  const doc = await local.saveSaved({ name: 'A.docx', bytes: filled(1) });
  clock += 60_000;
  await local.saveSaved({ id: doc.id, name: 'A.docx', bytes: filled(2) });
  assert.equal((await local.listVersions(doc.id)).length, 1);
  await local.trashSaved(doc.id);
  assert.equal((await local.listVersions(doc.id)).length, 1);
  await local.restoreTrashedSaved(doc.id);
  assert.equal((await local.listVersions(doc.id)).length, 1);
});

test('deleting for good removes the document, its history and its chunks', async () => {
  const doc = await local.saveSaved({ name: 'Big.txt', bytes: random(6_000_000, 5) });
  const hashes = (await local.getSavedManifest(doc.id))!.manifest.hashes;
  await local.trashSaved(doc.id);
  assert.equal((await local.getChunks(hashes)).size, new Set(hashes).size, 'kept in the trash');
  await local.purgeTrashedSaved(doc.id);
  assert.deepEqual(await local.listTrashedSaved(), []);
  assert.equal((await local.getChunks(hashes)).size, 0);
});

test('emptying the trash deletes everything in it and leaves the documents', async () => {
  const keep = await local.saveSaved({ name: 'Keep.docx', bytes: filled(1) });
  const a = await local.saveSaved({ name: 'A.docx', bytes: filled(2) });
  const b = await local.saveSaved({ name: 'B.docx', bytes: filled(3) });
  await local.trashSaved(a.id);
  await local.trashSaved(b.id);
  await local.purgeTrashedSaved();
  assert.deepEqual(await local.listTrashedSaved(), []);
  assert.deepEqual((await local.listSaved()).map((d) => d.id), [keep.id]);
});

test('what has been in the trash for 30 days is deleted the next time it is listed', async () => {
  const old = await local.saveSaved({ name: 'Old.docx', bytes: filled(1) });
  const recent = await local.saveSaved({ name: 'Recent.docx', bytes: filled(2) });
  await local.trashSaved(old.id);
  clock += 20 * DAY;
  await local.trashSaved(recent.id);
  clock += 11 * DAY;
  assert.deepEqual((await local.listTrashedSaved()).map((r) => r.info.id), [recent.id]);
  assert.equal(await local.getSaved(old.id), null);
  assert.equal(await local.restoreTrashedSaved(old.id), null, 'gone for good');
});

test('a document made while signed out comes back as the signed-in person’s, and one an account deleted goes when it signs out', async () => {
  const guest = await local.saveSaved({ name: 'Guest.docx', bytes: filled(1) });
  const mine = await local.saveSaved({ name: 'Mine.docx', bytes: filled(2), owner: 'u1' });
  await local.trashSaved(guest.id);
  await local.trashSaved(mine.id);
  assert.equal((await local.restoreTrashedSaved(guest.id, 'u2'))?.owner, 'u2');
  await local.deleteOwnedBy('u1');
  assert.deepEqual(await local.listTrashedSaved(), []);
});

// --- the one list ----------------------------------------------------------------------------------------------------------

const item = (source: 'device' | 'account', id: string, deletedAt: number): TrashItem => ({ source, id, name: id, size: 1, deletedAt, purgeAt: deletedAt + 1 });
function deps(device: TrashItem[], account: TrashItem[] | Error, hasAccount = true): TrashDeps & { restored: string[] } {
  const restored: string[] = [];
  return {
    restored,
    hasAccount: () => hasAccount,
    listDevice: async () => device,
    listAccount: async () => {
      if (account instanceof Error) throw account;
      return account;
    },
    restore: async (i) => void restored.push(`${i.source}:${i.id}`),
    purge: async () => {},
    read: async () => new ArrayBuffer(0),
  };
}

test('this browser’s trash and the account’s are one list, newest first', async () => {
  const { items, accountError } = await loadTrash(deps([item('device', 'a', 10), item('device', 'c', 30)], [item('account', 'b', 20)]));
  assert.deepEqual(items.map((i) => i.id), ['c', 'b', 'a']);
  assert.equal(accountError, null);
});

test('the account’s trash failing does not hide this browser’s, and no account is not asked', async () => {
  const failing = await loadTrash(deps([item('device', 'a', 1)], new Error('offline')));
  assert.deepEqual(failing.items.map((i) => i.id), ['a']);
  assert.equal(failing.accountError, 'offline');
  const noAccount = await loadTrash(deps([item('device', 'a', 1)], new Error('never asked'), false));
  assert.equal(noAccount.accountError, null);
});

const trashItem = (id: string): TrashItem => ({ source: 'account', id, name: id, size: 1, deletedAt: 0, purgeAt: 0 });

test('emptying the trash deletes each item once, a few at a time, and reports each one', async () => {
  const items = Array.from({ length: 10 }, (_, i) => trashItem(`d${i}`));
  const purged: string[] = [];
  let running = 0;
  let most = 0;
  const done: string[] = [];
  await emptyTrash(
    {
      purge: async (item) => {
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running--;
        purged.push(item!.id);
      },
    },
    items,
    { onDone: (item, error) => (assert.equal(error, null), done.push(item.id)) },
  );
  assert.deepEqual([...purged].sort(), items.map((i) => i.id).sort());
  assert.deepEqual([...done].sort(), [...purged].sort());
  assert.equal(most, EMPTY_AT_ONCE);
});

test('emptying the trash goes on past a failure and reports it', async () => {
  const errors = new Map<string, string | null>();
  await emptyTrash(
    {
      purge: async (item) => {
        if (item!.id === 'bad') throw new Error('offline');
      },
    },
    ['a', 'bad', 'b'].map(trashItem),
    { onDone: (item, error) => errors.set(item.id, error?.message ?? null) },
  );
  assert.deepEqual(Object.fromEntries(errors), { a: null, bad: 'offline', b: null });
});

test('stopping the emptying starts no more deletes', async () => {
  const stop = new AbortController();
  const purged: string[] = [];
  await emptyTrash(
    {
      purge: async (item) => {
        purged.push(item!.id);
        stop.abort();
      },
    },
    Array.from({ length: 20 }, (_, i) => trashItem(`d${i}`)),
    { signal: stop.signal, onDone: () => {} },
  );
  // Only the ones that had already started.
  assert.ok(purged.length <= EMPTY_AT_ONCE);
});

// --- the store both panels show ---------------------------------------------------------------------------------------------

test('the trash store lists the trash, and a listing asked for during one is made after it', async () => {
  const device = [item('device', 'a', 1)];
  let lists = 0;
  const store = new TrashStore({ ...deps(device, []), listDevice: async () => (lists++, [...device]) });
  let changes = 0;
  store.subscribe(() => changes++);
  assert.equal(store.loaded, false);
  const first = store.refresh();
  device.push(item('device', 'b', 2));
  const second = store.refresh();
  await Promise.all([first, second]);
  assert.equal(store.loaded, true);
  assert.equal(lists, 2, 'the second listing sees the change');
  assert.deepEqual(store.items.map((i) => i.id), ['b', 'a']);
  assert.ok(changes >= 1);
});

test('restoring and deleting for good take an item off the list; a failure leaves it', async () => {
  const d = deps([item('device', 'a', 1), item('device', 'b', 2), item('device', 'c', 3)], []);
  let failNext = false;
  const store = new TrashStore({
    ...d,
    purge: async () => {
      if (failNext) throw new Error('offline');
    },
  });
  await store.refresh();
  const [c, b, a] = store.items as [TrashItem, TrashItem, TrashItem];
  await store.restore(a);
  assert.deepEqual(d.restored, ['device:a']);
  // Deleted: marked as going while it is, then gone.
  const purging = store.purge(b);
  assert.ok(store.going.has(trashKey(b)));
  await purging;
  assert.ok(!store.going.has(trashKey(b)));
  failNext = true;
  await assert.rejects(store.purge(c), /offline/);
  assert.ok(store.items.some((i) => i.id === 'c'), 'still there');
  assert.ok(!store.going.has(trashKey(c)));
});

test('emptying through the store counts the items off, drops each, and reports a failure', async () => {
  const items = Array.from({ length: 6 }, (_, i) => item('account', `d${i}`, i));
  const store = new TrashStore({
    ...deps([], items),
    listAccount: async () => items.filter((i) => i.id === 'd3'),
    purge: async (i) => {
      if (i.id === 'd3') throw new Error('refused');
    },
  });
  await store.refresh();
  store.items = [...items];
  const seen: number[] = [];
  store.subscribe(() => {
    if (store.emptying) seen.push(store.emptying.done);
  });
  const result = await store.empty(items);
  assert.equal(result.failed?.message, 'refused');
  assert.equal(result.stopped, false);
  assert.equal(store.emptying, null);
  assert.deepEqual(store.items.map((i) => i.id), ['d3'], 'only the one that failed is left');
  assert.equal(Math.max(...seen), items.length);
  assert.equal(store.going.size, 0);
});
