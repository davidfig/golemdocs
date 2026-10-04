// Documents kept in this browser as chunks (src/storage/local.ts, chunker.ts): a big document is stored as the chunks it is made
// of, a save writes only the ones that changed, and a chunk goes when the last document holding it lets go. Small documents stay whole.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { fakeIndexedDB } from './fakeIndexedDB.ts';

(globalThis as { indexedDB: unknown }).indexedDB = fakeIndexedDB();
const local = await import('../src/storage/local.ts');

function random(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

beforeEach(async () => {
  for (const d of await local.listSaved()) await local.deleteSaved(d.id);
});

const same = (a: ArrayBuffer | Uint8Array, b: Uint8Array): boolean => Buffer.from(a instanceof Uint8Array ? a : new Uint8Array(a)).equals(Buffer.from(b));

test('a small document is kept whole, as it always was', async () => {
  const bytes = random(100_000, 1);
  const info = await local.saveSaved({ name: 'small.docx', bytes });
  assert.equal(info.size, 100_000);
  assert.equal(await local.getSavedManifest(info.id), null);
  const saved = await local.getSaved(info.id);
  assert.ok(saved && same(saved.bytes, bytes));
});

test('a big document is kept as chunks and read back as the same bytes', async () => {
  const bytes = random(6_000_000, 2);
  const info = await local.saveSaved({ name: 'big.txt', bytes });
  assert.equal(info.size, 6_000_000);
  const stored = await local.getSavedManifest(info.id);
  assert.ok(stored);
  assert.equal(stored.manifest.size, 6_000_000);
  assert.equal(stored.manifest.lengths.reduce((a, b) => a + b, 0), 6_000_000);
  assert.ok(stored.manifest.hashes.length >= 2);
  const saved = await local.getSaved(info.id);
  assert.ok(saved && same(saved.bytes, bytes));
  assert.equal(saved.info.size, 6_000_000);
});

test('saving an edit stores only the chunks that changed, and lets go of the ones it replaced', async () => {
  const bytes = random(12_000_000, 3);
  const first = await local.saveSaved({ name: 'big.txt', bytes });
  const before = (await local.getSavedManifest(first.id))!.manifest.hashes;
  const edited = bytes.slice();
  edited[6_000_000] ^= 0xff;
  await local.saveSaved({ id: first.id, name: 'big.txt', bytes: edited });
  const after = (await local.getSavedManifest(first.id))!.manifest.hashes;
  const added = after.filter((h) => !before.includes(h));
  const dropped = before.filter((h) => !after.includes(h));
  assert.ok(added.length >= 1 && added.length <= 2, `${added.length} chunks changed`);
  assert.equal(added.length, dropped.length);
  // The replaced chunks are gone; every chunk of the new copy is there.
  assert.equal((await local.getChunks(dropped)).size, 0);
  assert.equal((await local.getChunks(after)).size, new Set(after).size);
  const saved = await local.getSaved(first.id);
  assert.ok(saved && same(saved.bytes, edited));
});

test('two documents with the same chunks share them, and the last to go takes them', async () => {
  const bytes = random(5_000_000, 4);
  const a = await local.saveSaved({ name: 'a.txt', bytes });
  const b = await local.saveSaved({ name: 'b.txt', bytes });
  const hashes = (await local.getSavedManifest(a.id))!.manifest.hashes;
  await local.deleteSaved(a.id);
  assert.equal((await local.getChunks(hashes)).size, new Set(hashes).size);
  const saved = await local.getSaved(b.id);
  assert.ok(saved && same(saved.bytes, bytes));
  await local.deleteSaved(b.id);
  assert.equal((await local.getChunks(hashes)).size, 0);
});

test('a document that grows past the size is converted when saved, and one that shrinks goes back to whole', async () => {
  const small = random(50_000, 5);
  const big = random(4_000_000, 6);
  const first = await local.saveSaved({ name: 'x.txt', bytes: small });
  assert.equal(await local.getSavedManifest(first.id), null);
  await local.saveSaved({ id: first.id, name: 'x.txt', bytes: big });
  const hashes = (await local.getSavedManifest(first.id))!.manifest.hashes;
  assert.ok(same((await local.getSaved(first.id))!.bytes, big));
  await local.saveSaved({ id: first.id, name: 'x.txt', bytes: small });
  assert.equal(await local.getSavedManifest(first.id), null);
  assert.ok(same((await local.getSaved(first.id))!.bytes, small));
  assert.equal((await local.getChunks(hashes)).size, 0);
});

test('the same chunk twice in one document is held once, and let go of once', async () => {
  const block = random(1_000_000, 7);
  const bytes = new Uint8Array(block.length * 4);
  for (let i = 0; i < 4; i++) bytes.set(block, i * block.length);
  const info = await local.saveSaved({ name: 'repeats.bin', bytes });
  const { manifest } = (await local.getSavedManifest(info.id))!;
  assert.ok(new Set(manifest.hashes).size < manifest.hashes.length);
  assert.ok(same((await local.getSaved(info.id))!.bytes, bytes));
  await local.deleteSaved(info.id);
  assert.equal((await local.getChunks(manifest.hashes)).size, 0);
});

test('what the cloud is known to have is kept with the document: set by a download or an upload, and kept through a save', async () => {
  const bytes = random(5_000_000, 8);
  const down = await local.saveFromCloud({ name: 'c.txt', bytes, cloudId: 'cloud-1', cloudUpdatedAt: 5 });
  const afterDownload = (await local.getSavedManifest(down.id))!.manifest;
  assert.deepEqual(afterDownload.syncedHashes, afterDownload.hashes);
  const edited = bytes.slice();
  edited[2_000_000] ^= 1;
  await local.saveSaved({ id: down.id, name: 'c.txt', bytes: edited });
  const afterEdit = (await local.getSavedManifest(down.id))!.manifest;
  assert.deepEqual(afterEdit.syncedHashes, afterDownload.hashes, 'the cloud still has what it had');
  assert.notDeepEqual(afterEdit.hashes, afterEdit.syncedHashes);
  await local.markSynced(down.id, { cloudId: 'cloud-1', syncedAt: 99, syncedHashes: afterEdit.hashes });
  assert.deepEqual((await local.getSavedManifest(down.id))!.manifest.syncedHashes, afterEdit.hashes);
});

test('a document not seen to change is deleted with its chunks, and one that changed is kept', async () => {
  const bytes = random(4_000_000, 9);
  const info = await local.saveFromCloud({ name: 'd.txt', bytes, cloudId: 'cloud-2' });
  const hashes = (await local.getSavedManifest(info.id))!.manifest.hashes;
  assert.equal(await local.deleteSavedIfUnchanged(info), true);
  assert.equal((await local.getChunks(hashes)).size, 0);
  const kept = await local.saveFromCloud({ name: 'e.txt', bytes, cloudId: 'cloud-3' });
  await local.saveSaved({ id: kept.id, name: 'e.txt', bytes: random(4_000_000, 10) });
  assert.equal(await local.deleteSavedIfUnchanged(kept), false);
  assert.ok(await local.getSaved(kept.id));
});

test('bytes handed over as a view of a bigger buffer are stored as only those bytes', async () => {
  const outer = random(9_000_000, 11);
  const view = outer.subarray(1_000_000, 6_000_000);
  const info = await local.saveSaved({ name: 'view.bin', bytes: view });
  assert.equal(info.size, 5_000_000);
  const saved = await local.getSaved(info.id);
  assert.ok(saved && saved.bytes.byteLength === 5_000_000 && same(saved.bytes, view));
});
