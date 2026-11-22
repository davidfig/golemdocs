// Encrypted documents and folders and the desktop vault (src/desktop/vaultEncrypted.ts, vaultSync.ts; docs/encrypted-folders.md): never
// written to it, a file it had for a document encrypted since taken out (an edit to it saved into the document first, never made a readable
// document again), and a note in place of each encrypted folder.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutEncrypted } from '../src/desktop/vaultEncrypted.ts';
import { syncVault, type VaultCloud, type VaultCodec, type VaultDisk, type VaultHost } from '../src/desktop/vaultSync.ts';

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array) => new TextDecoder().decode(b);

test('the listing leaves encrypted documents and folders out, and says where the notes go', () => {
  const folders = [
    { id: 'work', name: 'Work', parentId: null },
    { id: 'taxes', name: 'Taxes', parentId: 'work', encrypted: true },
    { id: 'y2027', name: 'gde1.sealed', parentId: 'taxes', encrypted: true },
  ];
  const docs = [
    { id: 'open', name: 'Plan.md', folderId: 'work' },
    { id: 'sealed', name: 'gde1.x', folderId: null, encrypted: true },
    { id: 'inside', name: 'gde1.y', folderId: 'y2027', encrypted: true },
    { id: 'notYet', name: 'Old.md', folderId: 'taxes' }, // in an encrypted folder, not converted yet: left out all the same
  ];
  const shown = withoutEncrypted(docs, folders);
  assert.deepEqual(shown.docs.map((d) => d.id), ['open']);
  assert.deepEqual(shown.folders.map((f) => f.id), ['work']);
  assert.deepEqual(shown.encrypted.sort(), ['inside', 'notYet', 'sealed']);
  assert.deepEqual(shown.notes.map((n) => n.path), ['Work/Taxes (encrypted).md']);
  assert.match(shown.notes[0]!.text, /^# Taxes \(encrypted\)\n\nThe folder “Taxes” is encrypted/);
  assert.deepEqual(shown.encryptedPaths, ['Work/Taxes']);
});

/** An account in memory whose documents can be encrypted, which takes them out of its listing as the real hosts do. */
function world() {
  let clock = 100;
  let ids = 0;
  const docs = new Map<string, { id: string; name: string; bytes: Uint8Array; updatedAt: number; encrypted?: boolean }>();
  const calls: string[] = [];
  let locked = false;
  let notes: { path: string; text: string }[] = [];
  const cloud: VaultCloud = {
    async list() {
      const all = [...docs.values()];
      return {
        docs: all.filter((d) => !d.encrypted).map((d) => ({ id: d.id, name: d.name, folderId: null, createdAt: 1, updatedAt: d.updatedAt })),
        folders: [],
        encrypted: all.filter((d) => d.encrypted).map((d) => d.id),
        notes,
        encryptedPaths: [],
      };
    },
    download: async (id) => docs.get(id)!.bytes,
    async replace(id, bytes) {
      const d = docs.get(id)!;
      if (d.encrypted && locked) throw new Error('it is encrypted, and locked');
      calls.push(`replace ${id} ${read(bytes)}`);
      d.bytes = bytes;
      d.updatedAt = ++clock;
      return { updatedAt: d.updatedAt };
    },
    async create(dir, name, bytes) {
      calls.push(`create ${[...dir, name].join('/')}`);
      const id = `c${++ids}`;
      docs.set(id, { id, name, bytes, updatedAt: ++clock });
      return { id, updatedAt: clock };
    },
    place: async () => undefined,
    keepVersion: async () => undefined,
    async trash(id) {
      calls.push(`trash ${id}`);
      docs.delete(id);
    },
    removeFolder: async () => undefined,
    makeFolder: async () => undefined,
  };
  let diskClock = 5000;
  const files = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
  const disk: VaultDisk = {
    scan: async () => [...files].filter(([p]) => !p.startsWith('.')).map(([path, f]) => ({ path, size: f.bytes.byteLength, mtimeMs: f.mtimeMs })),
    async read(path) {
      const f = files.get(path);
      if (!f) throw new Error(`no ${path}`);
      return f.bytes;
    },
    async write(path, bytes) {
      files.set(path, { bytes, mtimeMs: ++diskClock });
      return diskClock;
    },
    remove: async (path) => void files.delete(path),
  };
  const codec: VaultCodec = { toFile: async (stored) => stored, fromFile: async (file) => file, kept: () => true };
  let memory: string | null = null;
  const host: VaultHost = {
    disk,
    memory: { load: async () => memory, save: async (t) => void (memory = t) },
    cloud,
    codec,
    hash: async (b) => read(b),
    account: 'u1',
  };
  const add = (name: string, content: string) => {
    const id = `a${++ids}`;
    docs.set(id, { id, name, bytes: text(content), updatedAt: ++clock });
    return id;
  };
  return {
    docs,
    files,
    calls,
    add,
    sync: (allowMassDelete = false) => syncVault(host, { allowMassDelete }),
    encrypt: (id: string) => void (docs.get(id)!.encrypted = true),
    setLocked: (value: boolean) => void (locked = value),
    setNotes: (next: { path: string; text: string }[]) => void (notes = next),
    put: (path: string, content: string) => void files.set(path, { bytes: text(content), mtimeMs: ++diskClock }),
    paths: () => [...files.keys()].filter((p) => !p.startsWith('.')).sort(),
  };
}

test('a document encrypted since the last sync loses its file in the vault, and is neither trashed nor made again', async () => {
  const w = world();
  const id = w.add('Diary.md', 'dear diary');
  await w.sync();
  assert.deepEqual(w.paths(), ['Diary.md']);
  w.encrypt(id);
  const report = await w.sync();
  assert.deepEqual(w.paths(), []);
  assert.equal(report.deletedHere, 1);
  assert.deepEqual(w.calls, [], 'nothing uploaded, created or trashed');
  assert.ok(w.docs.has(id));
  await w.sync();
  assert.deepEqual(w.calls, [], 'and stays that way');
});

test('an edit made in the vault to a document encrypted since is saved into it (sealed by the host), not made a readable document', async () => {
  const w = world();
  const id = w.add('Diary.md', 'dear diary');
  await w.sync();
  w.put('Diary.md', 'dear diary, an edit an agent made');
  w.encrypt(id);
  await w.sync();
  assert.deepEqual(w.calls, [`replace ${id} dear diary, an edit an agent made`]);
  assert.deepEqual(w.paths(), []);
});

test('while it is locked, the file and the memory of it are kept, out of the plan, until the edit can be saved', async () => {
  const w = world();
  const id = w.add('Diary.md', 'dear diary');
  await w.sync();
  w.put('Diary.md', 'edited');
  w.encrypt(id);
  w.setLocked(true);
  const report = await w.sync();
  assert.equal(report.errors.length, 1);
  assert.deepEqual(w.paths(), ['Diary.md'], 'kept, not lost');
  assert.ok(!w.calls.some((c) => c.startsWith('create')), 'never made a readable document');
  w.setLocked(false);
  await w.sync();
  assert.deepEqual(w.calls, [`replace ${id} edited`]);
  assert.deepEqual(w.paths(), []);
});

test('encrypting many documents at once takes their files out without the stop for many files vanishing', async () => {
  const w = world();
  const ids = Array.from({ length: 12 }, (_, i) => w.add(`Note ${i}.md`, `note ${i}`));
  w.add('Kept.md', 'kept');
  await w.sync();
  for (const id of ids) w.encrypt(id);
  const report = await w.sync();
  assert.equal(report.blocked, undefined);
  assert.deepEqual(w.paths(), ['Kept.md']);
});

test('a note stands in for an encrypted folder: written, kept up to date, removed when no longer wanted; a file of the person’s own is left alone', async () => {
  const w = world();
  w.add('Kept.md', 'kept');
  w.setNotes([{ path: 'Taxes (encrypted).md', text: 'first' }]);
  await w.sync();
  assert.equal(read(w.files.get('Taxes (encrypted).md')!.bytes), 'first');
  assert.deepEqual(w.calls, [], 'the note is not taken for a new document');
  w.setNotes([{ path: 'Taxes (encrypted).md', text: 'second' }]);
  await w.sync();
  assert.equal(read(w.files.get('Taxes (encrypted).md')!.bytes), 'second');
  w.setNotes([]);
  await w.sync();
  assert.deepEqual(w.paths(), ['Kept.md']);
  assert.deepEqual(w.calls, []);
  // A file of the person's own at a note's path is theirs.
  w.put('Taxes (encrypted).md', 'mine');
  await w.sync();
  w.setNotes([{ path: 'Taxes (encrypted).md', text: 'note' }]);
  await w.sync();
  assert.equal(read(w.files.get('Taxes (encrypted).md')!.bytes), 'mine');
});
