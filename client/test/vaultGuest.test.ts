// The vault's signed-out side (src/desktop/vaultGuest.ts): the documents saved in this browser, kept in step with a folder.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { fakeIndexedDB } from './fakeIndexedDB.ts';
import { GUEST_ACCOUNT, syncVault, type VaultCodec, type VaultDisk, type VaultHost } from '../src/desktop/vaultSync.ts';

(globalThis as { indexedDB: unknown }).indexedDB = fakeIndexedDB();
const local = await import('../src/storage/local.ts');
const { guestCloud } = await import('../src/desktop/vaultGuest.ts');
const { vaultMemory } = await import('../src/desktop/vaultMemory.ts');

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array | ArrayBuffer) => new TextDecoder().decode(b);

const files = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
let clock = 5000;
const disk: VaultDisk = {
  async scan() {
    return [...files].filter(([p]) => !p.startsWith('.')).map(([path, f]) => ({ path, size: f.bytes.byteLength, mtimeMs: f.mtimeMs }));
  },
  async read(path) {
    const f = files.get(path);
    if (!f) throw new Error(`no ${path}`);
    return f.bytes;
  },
  async write(path, bytes) {
    files.set(path, { bytes, mtimeMs: ++clock });
    return clock;
  },
  async remove(path) {
    files.delete(path);
  },
};
const put = (path: string, content: string) => void files.set(path, { bytes: text(content), mtimeMs: ++clock });
const codec: VaultCodec = { toFile: async (b) => b, fromFile: async (b) => b, kept: () => true };
let root = '';
let roots = 0;
const host = (): VaultHost => ({ disk, memory: vaultMemory(root), cloud: guestCloud(), codec, hash: async (b) => createHash('sha256').update(b).digest('hex'), account: GUEST_ACCOUNT });
const names = async () => (await local.listSaved()).map((d) => d.name).sort();

beforeEach(async () => {
  files.clear();
  root = `/vault-${++roots}`; // a folder this computer has no memory of
  for (const d of await local.listSaved()) await local.deleteSaved(d.id);
  await local.purgeTrashedSaved();
  for (const f of await local.listLocalFolders()) await local.removeLocalFolderRecord(f.id);
});

test('documents saved in the browser come into the folder, folders included', async () => {
  const folder = { id: 'f1', name: 'Notes', parentId: null, createdAt: 1, updatedAt: 1 };
  await local.putLocalFolder(folder);
  await local.saveSaved({ name: 'one.md', bytes: text('# one'), folderId: 'f1' });
  await local.saveSaved({ name: 'two.txt', bytes: text('two') });
  const report = await syncVault(host());
  assert.deepEqual(report.errors, []);
  assert.equal(report.downloaded, 2);
  assert.deepEqual([...files.keys()].filter((p) => !p.startsWith('.')).sort(), ['Notes/one.md', 'two.txt']);
  assert.equal(read(files.get('Notes/one.md')!.bytes), '# one');
});

test('a file edited, added and deleted in the folder changes the saved documents', async () => {
  const kept = await local.saveSaved({ name: 'keep.md', bytes: text('old') });
  const gone = await local.saveSaved({ name: 'gone.md', bytes: text('bye') });
  await syncVault(host());

  put('keep.md', 'new words');
  put('Ideas/fresh.md', 'fresh');
  files.delete('gone.md');
  const report = await syncVault(host());
  assert.deepEqual(report.errors, []);
  assert.equal(`${report.uploaded},${report.created},${report.trashed}`, '1,1,1');

  assert.equal(read((await local.getSaved(kept.id))!.bytes), 'new words');
  assert.deepEqual(await names(), ['fresh.md', 'keep.md']);
  const fresh = (await local.listSaved()).find((d) => d.name === 'fresh.md')!;
  const ideas = (await local.listLocalFolders()).find((f) => f.name === 'Ideas')!;
  assert.equal(fresh.folderId, ideas.id);
  assert.deepEqual((await local.listTrashedSaved()).map((t) => t.info.id), [gone.id], 'a deleted file goes to the browser trash');
  assert.equal((await syncVault(host())).uploaded + (await syncVault(host())).downloaded, 0, 'and it settles');
});

test('a document changed in the app comes down to its file, and a rename follows', async () => {
  const doc = await local.saveSaved({ name: 'a.md', bytes: text('first') });
  await syncVault(host());
  await local.saveSaved({ id: doc.id, name: 'b.md', bytes: text('second') });
  const report = await syncVault(host());
  assert.deepEqual(report.errors, []);
  assert.deepEqual([...files.keys()].filter((p) => !p.startsWith('.')), ['b.md']);
  assert.equal(read(files.get('b.md')!.bytes), 'second');
});

test('a document an account owns is not in the folder', async () => {
  await local.saveSaved({ name: 'account.md', bytes: text('theirs'), owner: 'u1' });
  await local.saveSaved({ name: 'mine.md', bytes: text('mine') });
  await syncVault(host());
  assert.deepEqual([...files.keys()].filter((p) => !p.startsWith('.')), ['mine.md']);
});

test('when this browser no longer has any of the documents the vault linked, the files are taken in again, not deleted', async () => {
  for (const name of ['a.md', 'b.md']) await local.saveSaved({ name, bytes: text(name) });
  await syncVault(host());
  // The browser's storage was cleared: the vault's memory outlived the documents it names.
  for (const d of await local.listSaved()) await local.deleteSaved(d.id);
  const report = await syncVault(host());
  assert.deepEqual(report.errors, []);
  assert.equal(`${report.deletedHere},${report.created}`, '0,2');
  assert.deepEqual([...files.keys()].filter((p) => !p.startsWith('.')).sort(), ['a.md', 'b.md']);
  assert.deepEqual(await names(), ['a.md', 'b.md']);
});

test('the vault memory is kept in this browser, and the folder only says whose it is', async () => {
  await local.saveSaved({ name: 'a.md', bytes: text('a') });
  await syncVault(host());
  const remembered = JSON.parse((await vaultMemory(root).load())!);
  assert.equal(remembered.entries.length, 1);
  assert.deepEqual(JSON.parse(read(files.get('.golemdocs/state.json')!.bytes)), { version: 1, account: GUEST_ACCOUNT, entries: [] });
});
