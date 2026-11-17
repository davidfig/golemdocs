// Copies of folders shared with this account in the desktop vault (src/desktop/vaultShared.ts), against a folder, an account and
// the shared folders kept in memory: where they go and stay, both ways within the role, and what goes when the share ends.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { newLabel, outsideDisk, relocated, syncShared, type MemoryFor, type SharedApi, type ShareTree, type VaultShare } from '../src/desktop/vaultShared.ts';
import type { LocalFile } from '../src/desktop/vaultPlan.ts';
import type { VaultCodec, VaultDisk, VaultMemory } from '../src/desktop/vaultSync.ts';

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array) => new TextDecoder().decode(b);

/** A folder in memory: every write has a new time, and folders are the ones files are in plus those made. */
function fakeDisk() {
  let clock = 5000;
  const files = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
  const dirs = new Set<string>();
  const allDirs = () => {
    const out = new Set(dirs);
    for (const path of files.keys()) for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) out.add(path.slice(0, at));
    return [...out].filter((p) => !p.split('/').some((s) => s.startsWith('.'))).sort();
  };
  const disk: VaultDisk = {
    scan: async () => [...files].filter(([p]) => !p.split('/').some((s) => s.startsWith('.'))).map(([path, f]): LocalFile => ({ path, size: f.bytes.byteLength, mtimeMs: f.mtimeMs })),
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
    folders: async () => allDirs(),
    async makeFolder(path) {
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    },
    async removeFolder(path) {
      if ([...files.keys(), ...dirs].some((p) => p.startsWith(`${path}/`))) return false;
      dirs.delete(path);
      return true;
    },
  };
  /** A change made by the person (or an agent) in the folder. */
  const put = (path: string, content: string) => void files.set(path, { bytes: text(content), mtimeMs: ++clock });
  const move = (from: string, to: string) => {
    files.set(to, { ...files.get(from)!, mtimeMs: files.get(from)!.mtimeMs });
    files.delete(from);
  };
  const content = (path: string) => (files.has(path) ? read(files.get(path)!.bytes) : undefined);
  const paths = () => [...files.keys()].sort();
  return { disk, files, dirs, put, move, content, paths };
}

interface Doc {
  id: string;
  name: string;
  folderId: string;
  bytes: Uint8Array;
  createdAt: number;
  updatedAt: number;
  createdByYou: boolean;
}

/** Alice's folder `Project` (with `Notes` in it), shared with this account, and the account's own top folders. */
function fakeAccount(role: 'editor' | 'viewer' = 'viewer') {
  let clock = 100;
  let ids = 0;
  const share: VaultShare = { ownerId: 'alice-0001', folderId: 'project', name: 'Project', role, owner: { name: 'Alice', email: 'alice@example.com' }, localName: null };
  const shares: VaultShare[] = [share];
  const folders = new Map<string, ShareTree['folders'][number]>([
    ['project', { id: 'project', name: 'Project', parentId: null, createdByYou: false }],
    ['notes', { id: 'notes', name: 'Notes', parentId: 'project', createdByYou: false }],
  ]);
  const docs = new Map<string, Doc>();
  const versions: { id: string; content: string }[] = [];
  const calls: string[] = [];
  const own: string[] = [];
  const add = (name: string, folderId: string, content: string, createdByYou = false) => {
    const id = `d${++ids}`;
    docs.set(id, { id, name, folderId, bytes: text(content), createdAt: ++clock, updatedAt: clock, createdByYou });
    return id;
  };
  const api: SharedApi = {
    shares: async () => shares.map((s) => ({ ...s })),
    async tree() {
      return { folders: [...folders.values()], documents: [...docs.values()].map(({ bytes: _, ...d }) => d), truncated: false };
    },
    download: async (id) => docs.get(id)!.bytes,
    async save(id, bytes) {
      calls.push(`save ${docs.get(id)!.name}`);
      const doc = docs.get(id)!;
      doc.bytes = bytes;
      doc.updatedAt = ++clock;
      return { updatedAt: clock };
    },
    async keepVersion(id) {
      versions.push({ id, content: read(docs.get(id)!.bytes) });
    },
    async create(_share, folderId, name, bytes) {
      calls.push(`create ${folders.get(folderId)!.name}/${name}`);
      const id = add(name, folderId, read(bytes), true);
      return { id, updatedAt: docs.get(id)!.updatedAt };
    },
    async rename(id, name) {
      calls.push(`rename ${docs.get(id)!.name} ${name}`);
      docs.get(id)!.name = name;
      docs.get(id)!.updatedAt = ++clock;
    },
    async trash(id) {
      calls.push(`trash ${docs.get(id)!.name}`);
      docs.delete(id);
    },
    async putFolder(_share, id, name, parentId) {
      calls.push(`folder ${name}`);
      folders.set(id, { id, name, parentId, createdByYou: true });
    },
    async deleteFolder(_share, id) {
      calls.push(`rmdir ${folders.get(id)!.name}`);
      folders.delete(id);
    },
    async setLabel(s, label) {
      calls.push(`label ${label}`);
      shares.find((x) => x.folderId === s.folderId)!.localName = label;
    },
    topFolders: async () => own,
  };
  const plan = add('Plan.md', 'project', 'the plan');
  const idea = add('Idea.md', 'notes', 'an idea');
  return { api, share, shares, docs, folders, versions, calls, own, add, plan, idea, edit: (id: string, content: string) => Object.assign(docs.get(id)!, { bytes: text(content), updatedAt: ++clock }) };
}

/** This computer's memories, by name. */
function fakeMemory(): MemoryFor & { store: Map<string, string> } {
  const store = new Map<string, string>();
  const memoryFor = ((name: string): VaultMemory => ({ load: async () => store.get(name) ?? null, save: async (value) => void store.set(name, value) })) as MemoryFor & { store: Map<string, string> };
  memoryFor.store = store;
  return memoryFor;
}

const codec: VaultCodec = { toFile: async (b) => b, fromFile: async (b) => b, kept: () => true };
const hash = async (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function setup(role: 'editor' | 'viewer' = 'viewer') {
  const disk = fakeDisk();
  const account = fakeAccount(role);
  const memory = fakeMemory();
  const wantedOff = new Set<string>();
  const sync = () => syncShared({ disk: disk.disk, memory, api: account.api, codec, hash, account: 'me', wanted: (s) => !wantedOff.has(s.folderId) });
  return { ...disk, ...account, memory, sync, wantedOff };
}

test('a shared folder is copied under Shared/<owner>/<folder>, and its label is kept in the account', async () => {
  const t = setup();
  const report = await t.sync();
  assert.equal(report.root, 'Shared');
  assert.deepEqual(t.paths(), ['Shared/Alice/Project/Notes/Idea.md', 'Shared/Alice/Project/Plan.md']);
  assert.equal(t.content('Shared/Alice/Project/Plan.md'), 'the plan');
  assert.deepEqual(t.calls, ['label Alice/Project']);
  // Changes in the account come down.
  t.edit(t.plan, 'the new plan');
  await t.sync();
  assert.equal(t.content('Shared/Alice/Project/Plan.md'), 'the new plan');
});

test('the label stays put when the owner’s name or the folder’s changes, and a new computer finds it in the account', async () => {
  const t = setup();
  await t.sync();
  t.shares[0]!.owner.name = 'Alice Liddell';
  t.shares[0]!.name = 'Renamed';
  t.folders.get('project')!.name = 'Renamed';
  await t.sync();
  assert.deepEqual(t.paths(), ['Shared/Alice/Project/Notes/Idea.md', 'Shared/Alice/Project/Plan.md']);

  // Another computer: no memory, the label from the account.
  const other = fakeDisk();
  await syncShared({ disk: other.disk, memory: fakeMemory(), api: t.api, codec, hash, account: 'me', wanted: () => true });
  assert.deepEqual(other.paths(), ['Shared/Alice/Project/Notes/Idea.md', 'Shared/Alice/Project/Plan.md']);
});

test('a viewer’s changes are put back, and their own files are left alone and never sent', async () => {
  const t = setup('viewer');
  await t.sync();
  t.calls.length = 0;
  t.put('Shared/Alice/Project/Plan.md', 'scribbled');
  t.files.delete('Shared/Alice/Project/Notes/Idea.md');
  t.put('Shared/Alice/Project/Mine.md', 'my own note');
  const report = await t.sync();
  assert.equal(t.content('Shared/Alice/Project/Plan.md'), 'the plan');
  assert.equal(t.content('Shared/Alice/Project/Notes/Idea.md'), 'an idea');
  assert.equal(t.content('Shared/Alice/Project/Mine.md'), 'my own note');
  assert.equal(report.kept, 1);
  assert.deepEqual(t.calls, []);
  assert.equal(read(t.docs.get(t.plan)!.bytes), 'the plan');

  // A rename or move is put back too.
  t.move('Shared/Alice/Project/Plan.md', 'Shared/Alice/Project/Notes/Plan.md');
  await t.sync();
  assert.equal(t.content('Shared/Alice/Project/Plan.md'), 'the plan');
  assert.equal(t.content('Shared/Alice/Project/Notes/Plan.md'), undefined);
  assert.deepEqual(t.calls, []);
});

test('an editor’s edits and new files go up as the owner’s; they rename and delete only what they added', async () => {
  const t = setup('editor');
  await t.sync();
  t.calls.length = 0;
  t.put('Shared/Alice/Project/Plan.md', 'a better plan');
  t.put('Shared/Alice/Project/Notes/Draft.md', 'a draft');
  await t.sync();
  assert.equal(read(t.docs.get(t.plan)!.bytes), 'a better plan');
  assert.deepEqual(t.calls, ['save Plan.md', 'create Notes/Draft.md']);
  const draft = [...t.docs.values()].find((d) => d.name === 'Draft.md')!;
  assert.equal(draft.createdByYou, true);

  // Their own addition: renamed, then deleted, in the account.
  t.calls.length = 0;
  t.move('Shared/Alice/Project/Notes/Draft.md', 'Shared/Alice/Project/Notes/Final.md');
  await t.sync();
  assert.deepEqual(t.calls, ['rename Draft.md Final.md']);
  t.files.delete('Shared/Alice/Project/Notes/Final.md');
  await t.sync();
  assert.deepEqual(t.calls, ['rename Draft.md Final.md', 'trash Final.md']);

  // The owner's: a delete and a move are put back, and nothing is sent.
  t.calls.length = 0;
  t.files.delete('Shared/Alice/Project/Notes/Idea.md');
  t.move('Shared/Alice/Project/Plan.md', 'Shared/Alice/Project/Notes/Plan.md');
  await t.sync();
  assert.deepEqual(t.calls, []);
  assert.deepEqual(t.paths(), ['Shared/Alice/Project/Notes/Idea.md', 'Shared/Alice/Project/Plan.md']);
  assert.ok(t.docs.has(t.idea));
});

test('with no memory the account wins: an editor’s different file is kept as a version, and the account’s copy is written', async () => {
  const t = setup('editor');
  t.put('Shared/Alice/Project/Plan.md', 'an old copy');
  await t.sync();
  assert.equal(t.content('Shared/Alice/Project/Plan.md'), 'the plan');
  assert.equal(read(t.docs.get(t.plan)!.bytes), 'the plan');
  assert.ok(t.versions.some((v) => v.id === t.plan && v.content === 'an old copy'));
});

test('a copy whose share ends is removed, edits and all, and files that never reached the account stay', async () => {
  const t = setup('viewer');
  await t.sync();
  t.put('Shared/Alice/Project/Plan.md', 'not sent yet');
  t.put('Shared/Alice/Project/Mine.md', 'my own note');
  t.shares.length = 0;
  const report = await t.sync();
  assert.deepEqual(report.removed, ['Alice/Project']);
  assert.deepEqual(t.paths(), ['Shared/Alice/Project/Mine.md']);
  assert.equal(report.kept, 1);
});

test('turning off "Keep a copy in my vault" removes the copy and keeps the share; turning it on brings it back', async () => {
  const t = setup('viewer');
  await t.sync();
  t.wantedOff.add('project');
  await t.sync();
  assert.deepEqual(t.paths(), []);
  t.wantedOff.clear();
  await t.sync();
  assert.deepEqual(t.paths(), ['Shared/Alice/Project/Notes/Idea.md', 'Shared/Alice/Project/Plan.md']);
});

test('a copy renamed on disk is followed, and the new name is kept in the account; nothing is deleted there', async () => {
  const t = setup('editor');
  await t.sync();
  t.calls.length = 0;
  for (const path of t.paths()) t.move(path, path.replace('Shared/Alice/Project/', 'Shared/Alice/Our project/'));
  await t.sync();
  assert.deepEqual(t.calls, ['label Alice/Our project']);
  assert.deepEqual(t.paths(), ['Shared/Alice/Our project/Notes/Idea.md', 'Shared/Alice/Our project/Plan.md']);
  // A copy deleted from disk altogether comes back, and the owner's documents stay.
  for (const path of t.paths()) t.files.delete(path);
  await t.sync();
  assert.deepEqual(t.paths(), ['Shared/Alice/Our project/Notes/Idea.md', 'Shared/Alice/Our project/Plan.md']);
  assert.equal(t.docs.size, 2);
});

test('an account with a Shared folder of its own keeps the copies in "Shared with me", and the vault’s own sync never sees them', async () => {
  const t = setup();
  t.own.push('Shared');
  const report = await t.sync();
  assert.equal(report.root, 'Shared with me');
  assert.deepEqual(t.paths(), ['Shared with me/Alice/Project/Notes/Idea.md', 'Shared with me/Alice/Project/Plan.md']);
  t.put('Shared/Mine.md', 'mine');
  const outside = outsideDisk(t.disk, 'Shared with me');
  assert.deepEqual((await outside.scan()).map((f) => f.path), ['Shared/Mine.md']);
  assert.deepEqual(await outside.folders!(), ['Shared']);
});

test('labels: two owners of one name, and two folders of one name, are told apart', () => {
  const share = (ownerId: string, name: string): VaultShare => ({ ownerId, folderId: name, name, role: 'viewer', owner: { name: 'Sam', email: null }, localName: null });
  assert.equal(newLabel(share('a', 'Notes'), []), 'Sam/Notes');
  assert.equal(newLabel(share('b', 'Notes'), [{ ownerId: 'a', label: 'Sam/Notes' }]), 'Sam (2)/Notes');
  assert.equal(newLabel(share('a', 'Notes'), [{ ownerId: 'a', label: 'Sam/Notes' }]), 'Sam/Notes (2)');
  assert.equal(newLabel({ ...share('c', 'a:b'), owner: { name: null, email: 'kim@example.com' } }, []), 'kim/a_b');
});

test('a moved copy is found by its files', () => {
  const files = [{ path: 'Shared/A/New/x.md', size: 1, mtimeMs: 1 }, { path: 'Shared/A/New/n/y.md', size: 1, mtimeMs: 1 }, { path: 'Shared/B/Other/z.md', size: 1, mtimeMs: 1 }];
  assert.equal(relocated(files, [{ path: 'x.md' }, { path: 'n/y.md' }], 'Shared', () => true), 'A/New');
  assert.equal(relocated(files, [{ path: 'q.md' }], 'Shared', () => true), null);
});
