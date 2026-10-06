// A document's history in this browser (src/storage/local.ts, "History"): a save keeps the version it replaces when the shared rules
// say one is due, a version of a big document holds its chunks instead of copying them, and deleting the document lets everything go.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { fakeIndexedDB } from './fakeIndexedDB.ts';

(globalThis as { indexedDB: unknown }).indexedDB = fakeIndexedDB();
const local = await import('../src/storage/local.ts');

const MIN = 60_000;
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
const bytesOf = (b: ArrayBuffer | Uint8Array | null) => (b === null ? null : [...new Set(new Uint8Array(b))]);

beforeEach(async () => {
  clock = realNow.call(Date);
  Date.now = () => clock;
  for (const d of await local.listSaved()) await local.deleteSaved(d.id);
});
afterEach(() => {
  Date.now = realNow;
});

/** Saves the next version of a document `after` ms on. */
async function save(id: string | undefined, data: Uint8Array, after = 0) {
  clock += after;
  return local.saveSaved({ ...(id ? { id } : {}), name: 'Doc.docx', bytes: data });
}

test('the first overwrite keeps the version it replaced, and saves of one burst keep nothing more', async () => {
  const first = await save(undefined, filled(1));
  await save(first.id, filled(2), MIN);
  await save(first.id, filled(3), MIN);
  await save(first.id, filled(4), MIN);
  const list = await local.listVersions(first.id);
  assert.deepEqual(list.map((v) => v.version), [first.updatedAt]);
  assert.deepEqual(bytesOf(await local.getVersion(first.id, first.updatedAt)), [1]);
  assert.deepEqual(bytesOf((await local.getSaved(first.id))!.bytes), [4], 'the document itself is the latest');
});

test('a save after a pause keeps the version the pause followed', async () => {
  const first = await save(undefined, filled(1));
  const second = await save(first.id, filled(2), MIN);
  const third = await save(first.id, filled(3), 2 * MIN);
  await save(first.id, filled(4), 30 * MIN);
  const list = await local.listVersions(first.id);
  assert.deepEqual(list.map((v) => v.version), [third.updatedAt, first.updatedAt]);
  assert.ok(second.updatedAt < third.updatedAt);
  assert.deepEqual(bytesOf(await local.getVersion(first.id, third.updatedAt)), [3]);
});

test('a version is kept on purpose, with a name, renamed and removed', async () => {
  const doc = await save(undefined, filled(1));
  const kept = await local.keepVersion(doc.id, 'Sent to Sam');
  assert.deepEqual(kept, { version: doc.updatedAt, size: 3000, name: 'Sent to Sam', chunked: false });
  assert.deepEqual(bytesOf(await local.getVersion(doc.id, doc.updatedAt)), [1]);
  await local.nameVersion(doc.id, doc.updatedAt, null);
  assert.equal((await local.listVersions(doc.id))[0]!.name, null);
  await local.deleteVersion(doc.id, doc.updatedAt);
  assert.deepEqual(await local.listVersions(doc.id), []);
  assert.equal(await local.getVersion(doc.id, doc.updatedAt), null);
  assert.equal(await local.keepVersion('nothing-here'), null);
});

test('keeping a version twice is one version', async () => {
  const doc = await save(undefined, filled(1));
  await local.keepVersion(doc.id);
  await local.keepVersion(doc.id, 'Named later');
  const list = await local.listVersions(doc.id);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.name, 'Named later');
});

test('deleting a document deletes its history', async () => {
  const doc = await save(undefined, filled(1));
  await save(doc.id, filled(2), MIN);
  assert.equal((await local.listVersions(doc.id)).length, 1);
  await local.deleteSaved(doc.id);
  assert.deepEqual(await local.listVersions(doc.id), []);
  assert.equal(await local.getVersion(doc.id, doc.updatedAt), null);
});

test('a version of a big document holds its chunks, a restore reads it whole, and letting it go frees what only it held', async () => {
  const original = random(6_000_000, 11);
  const first = await save(undefined, original);
  const before = (await local.getSavedManifest(first.id))!.manifest.hashes;
  const edited = random(6_000_000, 12); // unrelated bytes: every chunk changes
  await save(first.id, edited, MIN);
  const list = await local.listVersions(first.id);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.chunked, true);
  // The old chunks are still there, though the document no longer names them.
  assert.equal((await local.getChunks(before)).size, new Set(before).size);
  const old = await local.getVersion(first.id, first.updatedAt);
  assert.ok(old && Buffer.from(new Uint8Array(old)).equals(Buffer.from(original)));
  await local.deleteVersion(first.id, first.updatedAt);
  assert.equal((await local.getChunks(before)).size, 0, 'nothing holds them now');
  const now = await local.getSaved(first.id);
  assert.ok(now && Buffer.from(new Uint8Array(now.bytes)).equals(Buffer.from(edited)), 'the document is whole');
});

test('a big document made small keeps its big version, and deleting the document frees every chunk', async () => {
  const first = await save(undefined, random(6_000_000, 21));
  const hashes = (await local.getSavedManifest(first.id))!.manifest.hashes;
  await save(first.id, filled(5, 100), MIN); // whole now: the chunked one is held by its version alone
  assert.equal((await local.getSavedManifest(first.id)), null);
  assert.equal((await local.getChunks(hashes)).size, new Set(hashes).size);
  assert.equal((await local.getVersion(first.id, first.updatedAt))!.byteLength, 6_000_000);
  await local.deleteSaved(first.id);
  assert.equal((await local.getChunks(hashes)).size, 0);
});

test('chunks two versions share are freed only when both are gone', async () => {
  const bytes = random(6_000_000, 31);
  const first = await save(undefined, bytes);
  const hashes = [...new Set((await local.getSavedManifest(first.id))!.manifest.hashes)];
  const keptA = await local.keepVersion(first.id, 'A');
  await save(first.id, random(6_000_000, 32), MIN);
  await save(first.id, random(6_000_000, 33), 30 * MIN);
  assert.ok(keptA);
  assert.ok((await local.listVersions(first.id)).length >= 2);
  await local.deleteVersion(first.id, keptA.version);
  // The version just after A (kept by the pause) holds nothing of A's bytes, so none of A's chunks remain.
  assert.equal((await local.getChunks(hashes)).size, 0);
});
