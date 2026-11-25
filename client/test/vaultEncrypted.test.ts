// Encrypted documents and folders and the desktop vault (src/desktop/vaultEncrypted.ts, vaultSync.ts; docs/encrypted-folders.md): never
// written to it, a file it had for a document encrypted since taken out (an edit to it saved into the document first, never made a readable
// document again), and a note in place of each encrypted folder.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutEncrypted } from '../src/desktop/vaultEncrypted.ts';
import { syncVault, type VaultCloud, type VaultCodec, type VaultDisk, type VaultHost } from '../src/desktop/vaultSync.ts';

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array) => new TextDecoder().decode(b);

test('an encrypted folder decrypted into the vault stays in the listing, folders and documents, with no note', () => {
  const folders = [
    { id: 'taxes', name: 'Taxes', parentId: null, encrypted: true },
    { id: 'y2027', name: 'gde1.sealed', parentId: 'taxes', encrypted: true },
    { id: 'other', name: 'Other', parentId: null, encrypted: true },
  ];
  const docs = [
    { id: 'in', name: 'gde1.a', folderId: 'y2027', encrypted: true },
    { id: 'away', name: 'gde1.b', folderId: 'other', encrypted: true },
    { id: 'loose', name: 'gde1.c', folderId: null, encrypted: true },
  ];
  const shown = withoutEncrypted(docs, folders, (top) => top === 'taxes');
  assert.deepEqual(shown.folders.map((f) => f.id), ['taxes', 'y2027']);
  assert.deepEqual(shown.docs.map((d) => d.id), ['in']);
  assert.deepEqual(shown.encrypted.sort(), ['away', 'loose'], 'a document encrypted on its own is never decrypted into the vault');
  assert.deepEqual(shown.notes.map((n) => n.path), ['Other (encrypted).md']);
  assert.deepEqual(shown.encryptedPaths, ['Other']);
});

test('a document decrypted into the vault with its folder stays in when moved out of it; the listing says which paths are decrypted', () => {
  const folders = [
    { id: 'taxes', name: 'Taxes', parentId: null, encrypted: true },
    { id: 'plain', name: 'Plain', parentId: null },
  ];
  const docs = [
    { id: 'in', name: 'gde1.a', folderId: 'taxes', encrypted: true },
    { id: 'movedOut', name: 'gde1.b', folderId: 'plain', encrypted: true },
    { id: 'other', name: 'gde1.c', folderId: null, encrypted: true },
  ];
  const shown = withoutEncrypted(docs, folders, (top) => top === 'taxes', (id) => id === 'movedOut');
  assert.deepEqual(shown.docs.map((d) => d.id), ['in', 'movedOut']);
  assert.deepEqual(shown.encrypted, ['other']);
  assert.deepEqual(shown.decryptedPaths, ['Taxes']);
  assert.deepEqual(shown.decryptedDocs, [{ id: 'in', top: 'taxes' }]);
  const later = withoutEncrypted(docs, folders);
  assert.deepEqual(later.decryptedPaths, []);
  assert.deepEqual(later.encrypted.sort(), ['in', 'movedOut', 'other'], 'once the session ends, all of them are left out again');
});

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
  /** Whether the encrypted documents are decrypted into the vault (as an encrypted folder decrypted into it for the session is). */
  let shown = false;
  let notes: { path: string; text: string }[] = [];
  let paths: { encryptedPaths: string[]; decryptedPaths: string[] } = { encryptedPaths: [], decryptedPaths: [] };
  const cloud: VaultCloud = {
    async list() {
      const all = [...docs.values()];
      return {
        docs: all.filter((d) => !d.encrypted || shown).map((d) => ({ id: d.id, name: d.name, folderId: null, createdAt: 1, updatedAt: d.updatedAt })),
        folders: [],
        encrypted: all.filter((d) => d.encrypted && !shown).map((d) => d.id),
        notes,
        ...paths,
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
  const codec: VaultCodec = { toFile: async (stored) => stored, fromFile: async (file) => file, kept: (name) => !name.endsWith('.zip') };
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
    setShown: (value: boolean) => void (shown = value),
    setNotes: (next: { path: string; text: string }[]) => void (notes = next),
    setPaths: (next: { encryptedPaths: string[]; decryptedPaths: string[] }) => void (paths = next),
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

test('decrypted into the vault: the file is there, changes made to it go back (sealed by the host), and stopping takes it out', async () => {
  const w = world();
  const id = w.add('Diary.md', 'dear diary');
  w.encrypt(id);
  await w.sync();
  assert.deepEqual(w.paths(), [], 'not there while it is not decrypted into the vault');
  w.setShown(true);
  await w.sync();
  assert.deepEqual(w.paths(), ['Diary.md']);
  assert.equal(read(w.files.get('Diary.md')!.bytes), 'dear diary');
  w.put('Diary.md', 'an agent wrote this');
  await w.sync();
  assert.deepEqual(w.calls, [`replace ${id} an agent wrote this`]);
  // An edit made just before it stops is saved before the file is taken out.
  w.put('Diary.md', 'one more line');
  w.setShown(false);
  await w.sync();
  assert.deepEqual(w.calls, [`replace ${id} an agent wrote this`, `replace ${id} one more line`]);
  assert.deepEqual(w.paths(), []);
  assert.ok(!w.calls.some((c) => c.startsWith('create') || c.startsWith('trash')));
});

test('when a folder stops being decrypted into the vault, files the vault does not sync go too; a new file there is never made readable', async () => {
  const w = world();
  w.add('Kept.md', 'kept');
  w.setPaths({ encryptedPaths: [], decryptedPaths: ['Taxes'] });
  await w.sync();
  // An agent leaves a file the vault doesn't sync, and makes a document after the last sync, just before the session ends.
  w.put('Taxes/data.zip', 'binary');
  w.put('Taxes/Late.md', 'written just before locking');
  w.setPaths({ encryptedPaths: ['Taxes'], decryptedPaths: [] });
  await w.sync();
  assert.deepEqual(w.paths(), ['Kept.md', 'Taxes/Late.md'], 'the zip is removed; the document is kept (not lost), not uploaded');
  assert.ok(!w.calls.some((c) => c.startsWith('create')), 'nothing under an encrypted folder is made a readable document');
  await w.sync();
  assert.ok(!w.calls.some((c) => c.startsWith('create')));
  // When the folder is decrypted into the vault again, it is taken in (encrypted, by the host).
  w.setPaths({ encryptedPaths: [], decryptedPaths: ['Taxes'] });
  await w.sync();
  assert.deepEqual(w.calls.filter((c) => c.startsWith('create')), ['create Taxes/Late.md']);
});

test('audio and video too big for the account are kept when their folder stops being decrypted into the vault, and not listed while it is locked', async () => {
  const w = world();
  w.add('Kept.md', 'kept');
  w.setPaths({ encryptedPaths: [], decryptedPaths: ['Taxes'] });
  w.files.set('Taxes/call.mp4', { bytes: new Uint8Array(51 * 1024 * 1024), mtimeMs: 1 });
  w.put('Taxes/data.zip', 'binary');
  assert.deepEqual((await w.sync()).inPlace?.map((f) => f.path), ['Taxes/call.mp4']);
  w.setPaths({ encryptedPaths: ['Taxes'], decryptedPaths: [] });
  for (let i = 0; i < 2; i++) {
    const report = await w.sync();
    assert.deepEqual(report.inPlace, [], 'what a locked folder holds is not shown');
    assert.deepEqual(w.paths(), ['Kept.md', 'Taxes/call.mp4'], 'the only copy of the recording stays; the zip goes');
  }
  w.setPaths({ encryptedPaths: [], decryptedPaths: ['Taxes'] });
  assert.deepEqual((await w.sync()).inPlace?.map((f) => f.path), ['Taxes/call.mp4']);
  assert.deepEqual(w.calls, [], 'never uploaded');
});
