// The trash in this browser (src/storage/local.ts, "Trash") and the one list the app makes of it and the account's (src/trash.ts).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { fakeIndexedDB } from './fakeIndexedDB.ts';
import { loadTrash, restoreById, type TrashDeps, type TrashItem } from '../src/trash.ts';

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

test('restoring by id finds which trash each is in and says which could not be', async () => {
  const d = deps([item('device', 'a', 1)], [item('account', 'b', 2)]);
  const result = await restoreById(d, ['a', 'b', 'zzz']);
  assert.deepEqual(result.restored, ['a', 'b']);
  assert.deepEqual(result.failed, ['zzz: not in the trash']);
  assert.deepEqual(d.restored, ['device:a', 'account:b']);
});
