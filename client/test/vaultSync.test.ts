// One sync of the desktop vault (src/desktop/vaultSync.ts), against a folder and an account kept in memory.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { FontSet } from '@golemdocs/layout';
import { PageDrawing, PdfDocument, readAnnotations } from '../../pdf/src/index.ts';
import { fromVaultFile, toVaultFile, vaultFormat } from '../src/desktop/vaultCodec.ts';
import { GUEST_ACCOUNT, STATE_PATH, syncVault, type SyncReport, type VaultCloud, type VaultCodec, type VaultDisk, type VaultHost, type VaultMemory } from '../src/desktop/vaultSync.ts';
import { delimitedWdoc, readWdoc, writeWdoc, WDOC_VERSION } from '../src/formats/wdoc.ts';
import { installFakeCanvas } from './fakeCanvas.ts';

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array) => new TextDecoder().decode(b);

interface Doc {
  id: string;
  name: string;
  dir: string[];
  bytes: Uint8Array;
  updatedAt: number;
  createdAt: number;
}

/** An account in memory. Stored bytes are "wdoc:" + the file, so the codec is visible in the assertions. A folder, once
 * made, stays until it is removed, as the account's do; its id is its path. */
function fakeCloud() {
  let clock = 100;
  let ids = 0;
  const docs = new Map<string, Doc>();
  const folders = new Map<string, { id: string; name: string; parentId: string | null }>();
  const calls: string[] = [];
  const folderFor = (dir: string[]): string | null => {
    let parent: string | null = null;
    for (const name of dir) {
      const id: string = parent ? `${parent}/${name}` : name;
      if (!folders.has(id)) folders.set(id, { id, name, parentId: parent });
      parent = id;
    }
    return parent;
  };
  const cloud: VaultCloud = {
    async list() {
      const placed = [...docs.values()].map((d) => ({ id: d.id, name: d.name, folderId: folderFor(d.dir), createdAt: d.createdAt, updatedAt: d.updatedAt }));
      return { docs: placed, folders: [...folders.values()] };
    },
    async download(id) {
      calls.push(`download ${id}`);
      return docs.get(id)!.bytes;
    },
    async replace(id, bytes) {
      calls.push(`replace ${id}`);
      const d = docs.get(id)!;
      d.bytes = bytes;
      d.updatedAt = ++clock;
      return { updatedAt: d.updatedAt };
    },
    async create(dir, name, bytes) {
      calls.push(`create ${[...dir, name].join('/')}`);
      const d: Doc = { id: `c${++ids}`, name, dir, bytes, updatedAt: ++clock, createdAt: clock };
      docs.set(d.id, d);
      return { id: d.id, updatedAt: d.updatedAt };
    },
    async place(id, dir, name) {
      calls.push(`place ${id} ${[...dir, name].join('/')}`);
      const d = docs.get(id)!;
      Object.assign(d, { dir, name, updatedAt: ++clock });
    },
    async keepVersion(id) {
      calls.push(`keep ${id}`);
    },
    async trash(id) {
      calls.push(`trash ${id}`);
      docs.delete(id);
    },
    async removeFolder(id) {
      calls.push(`rmdir ${id}`);
      folders.delete(id);
    },
    async makeFolder(dir) {
      calls.push(`mkdir ${dir.join('/')}`);
      folderFor(dir);
    },
  };
  const add = (path: string, content: string, id = `a${++ids}`) => {
    const parts = path.split('/');
    docs.set(id, { id, name: parts.pop()!, dir: parts, bytes: text(`wdoc:${content}`), updatedAt: ++clock, createdAt: clock });
    return id;
  };
  const edit = (id: string, content: string) => {
    const d = docs.get(id)!;
    d.bytes = text(`wdoc:${content}`);
    d.updatedAt = ++clock;
  };
  return { cloud, docs, folders, calls, add, edit, folderFor };
}

/**
 * A folder in memory that behaves like the native side: hidden names are not listed, every write has a new time, a file
 * rewritten keeps its creation date, and a creation date set later only moves earlier. With
 * `folders` it is today's shell, which lists folders, empty ones too (those that hold a file, and those made in `dirs`), and
 * removes the folders a deleted file leaves empty; without, a shell too old to list folders.
 */
function fakeDisk(options: { folders?: boolean } = {}) {
  let clock = 5000;
  const files = new Map<string, { bytes: Uint8Array; mtimeMs: number; created?: number }>();
  const dated: string[] = [];
  const dirs = new Set<string>();
  const hidden = (p: string) => p.split('/').some((s) => s.startsWith('.'));
  const under = (dir: string) => [...files.keys(), ...dirs].some((p) => p.startsWith(`${dir}/`));
  const allDirs = () => {
    const out = new Set(dirs);
    for (const path of files.keys()) for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) out.add(path.slice(0, at));
    return [...out].filter((p) => !hidden(p)).sort();
  };
  const folderOps: Pick<VaultDisk, 'folders' | 'makeFolder' | 'removeFolder'> = {
    folders: async () => allDirs(),
    async makeFolder(path) {
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    },
    async removeFolder(path) {
      if (under(path)) return false;
      dirs.delete(path);
      return true;
    },
  };
  const disk: VaultDisk = {
    async scan() {
      return [...files].filter(([p]) => !p.split('/').some((s) => s.startsWith('.'))).map(([path, f]) => ({ path, size: f.bytes.byteLength, mtimeMs: f.mtimeMs }));
    },
    async read(path) {
      const f = files.get(path);
      if (!f) throw new Error(`no ${path}`);
      return f.bytes;
    },
    async write(path, bytes) {
      files.set(path, { bytes, mtimeMs: ++clock, created: files.get(path)?.created ?? clock });
      return clock;
    },
    async remove(path) {
      files.delete(path);
      if (!options.folders) return;
      // Like the shell: the folders the file leaves empty go with it.
      const parts = path.split('/').slice(0, -1);
      for (; parts.length && !under(parts.join('/')); parts.pop()) dirs.delete(parts.join('/'));
    },
    async setTimes(path, { created, modified }) {
      const f = files.get(path);
      if (!f) throw new Error(`no ${path}`);
      dated.push(path);
      if (modified !== undefined) f.mtimeMs = modified;
      if (created !== undefined && created < (f.created ?? Infinity)) f.created = created;
      return f.mtimeMs;
    },
    ...(options.folders && folderOps),
  };
  const put = (path: string, content: string) => void files.set(path, { bytes: text(content), mtimeMs: ++clock, created: files.get(path)?.created ?? clock });
  const get = (path: string) => (files.has(path) ? read(files.get(path)!.bytes) : undefined);
  const paths = () => [...files.keys()].filter((p) => !p.startsWith('.')).sort();
  /** Deletes a folder with all that is in it, as Finder does. */
  const rmrf = (dir: string) => {
    for (const p of [...files.keys()]) if (p.startsWith(`${dir}/`)) files.delete(p);
    for (const p of [...dirs]) if (p === dir || p.startsWith(`${dir}/`)) dirs.delete(p);
  };
  return { disk, files, dirs, put, get, paths, rmrf, folders: allDirs, dated };
}

const codec: VaultCodec = {
  async toFile(stored) {
    return text(read(stored).replace(/^wdoc:/, ''));
  },
  async fromFile(file) {
    return text(`wdoc:${read(file)}`);
  },
  kept: (name) => !/\.zip$/i.test(name),
};

/** One computer's memory of the vault. */
function fakeMemory() {
  let text: string | null = null;
  const memory: VaultMemory = {
    load: async () => text,
    save: async (t) => void (text = t),
  };
  return memory;
}

function setup(account = 'u1', options: { folders?: boolean } = {}) {
  const account_ = fakeCloud();
  const folder = fakeDisk(options);
  const host: VaultHost = { disk: folder.disk, memory: fakeMemory(), cloud: account_.cloud, codec, hash: async (b) => createHash('sha256').update(b).digest('hex'), account };
  const sync = (options?: { allowMassDelete?: boolean }) => syncVault(host, options);
  return { ...account_, folder, host, sync };
}

const counts = (r: SyncReport) => [r.downloaded, r.uploaded, r.created, r.renamed, r.movedHere, r.deletedHere, r.trashed].join(',');
const quiet = '0,0,0,0,0,0,0';

test('the first sync brings the account into the vault, in its folders, and the next does nothing', async () => {
  const s = setup();
  s.add('Notes/one.md', '# one');
  s.add('two.txt', 'two');
  const first = await s.sync();
  assert.equal(counts(first), '2,0,0,0,0,0,0');
  assert.deepEqual(s.folder.paths(), ['Notes/one.md', 'two.txt']);
  assert.equal(s.folder.get('Notes/one.md'), '# one');
  assert.deepEqual(first.errors, []);
  const again = await s.sync();
  assert.equal(counts(again), quiet);
  assert.equal(s.calls.filter((c) => c.startsWith('download')).length, 2, 'nothing was downloaded twice');
});

test('a sync reports what it found and each step as it goes', async () => {
  const s = setup();
  s.add('Notes/one.md', '# one');
  s.add('two.txt', 'two');
  const steps: string[] = [];
  const report = await syncVault(s.host, { progress: (p) => steps.push(`${p.phase}${p.total ? ` ${p.done}/${p.total}` : ''}${p.path ? ` ${p.path}` : ''}`) });
  assert.deepEqual([report.accountDocs, report.folderFiles], [2, 0]);
  assert.deepEqual(steps, ['account', 'folder', 'compare', 'apply 0/2 Notes/one.md', 'apply 1/2 two.txt']);
});

test('a sync that fails five files in a row gives up and says so', async () => {
  const s = setup();
  for (let i = 0; i < 12; i++) s.add(`f${i}.txt`, 'x');
  const write = s.folder.disk.write;
  s.folder.disk.write = async (path, bytes) => {
    if (!path.startsWith('.golemdocs/')) throw new Error('denied');
    return write(path, bytes);
  };
  const report = await s.sync();
  assert.equal(report.errors.length, 5);
  assert.equal(report.gaveUp, 5);
});

test('a document with no file in the account is reported, and the others still come down', async () => {
  const s = setup();
  s.add('gone.md', 'x');
  s.add('here.md', 'y');
  const download = s.cloud.download;
  s.cloud.download = async (id) => {
    const bytes = await download(id);
    if (read(bytes) === 'wdoc:x') throw Object.assign(new Error('document file is missing'), { status: 404 });
    return bytes;
  };
  const report = await s.sync();
  assert.deepEqual(report.missing, ['gone.md']);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(s.folder.paths(), ['here.md']);
});

test('a file edited in the vault replaces the document, and settles', async () => {
  const s = setup();
  const id = s.add('one.md', 'old');
  await s.sync();
  s.folder.put('one.md', 'new words');
  const report = await s.sync();
  assert.equal(counts(report), '0,1,0,0,0,0,0');
  assert.deepEqual(report.touched, [id], 'an editor showing it is told it is out of date');
  assert.equal(read(s.docs.get(id)!.bytes), 'wdoc:new words');
  assert.equal(s.calls.includes(`keep ${id}`), false, 'the account had not changed, so there is nothing to keep');
  assert.equal(counts(await s.sync()), quiet);
});

test('a file touched without changing it is not uploaded', async () => {
  const s = setup();
  s.add('one.md', 'same');
  await s.sync();
  s.folder.put('one.md', 'same');
  assert.equal(counts(await s.sync()), quiet);
});

test('when both sides changed, the vault wins and the account version is kept first', async () => {
  const s = setup();
  const id = s.add('one.md', 'old');
  await s.sync();
  s.edit(id, 'changed in the account');
  s.folder.put('one.md', 'changed here');
  const report = await s.sync();
  assert.equal(counts(report), '0,1,0,0,0,0,0');
  assert.deepEqual(s.calls.slice(-2), [`keep ${id}`, `replace ${id}`]);
  assert.equal(read(s.docs.get(id)!.bytes), 'wdoc:changed here');
  assert.equal(counts(await s.sync()), quiet);
});

test('a change made in the account comes down', async () => {
  const s = setup();
  const id = s.add('one.md', 'old');
  await s.sync();
  s.edit(id, 'from elsewhere');
  assert.equal(counts(await s.sync()), '1,0,0,0,0,0,0');
  assert.equal(s.folder.get('one.md'), 'from elsewhere');
  assert.equal(counts(await s.sync()), quiet);
});

test('a new file, in a new folder, becomes a document', async () => {
  const s = setup();
  s.folder.put('Ideas/new.md', 'fresh');
  const report = await s.sync();
  assert.equal(counts(report), '0,0,1,0,0,0,0');
  assert.deepEqual(s.calls, ['create Ideas/new.md']);
  assert.equal(counts(await s.sync()), quiet);
});

test('a file deleted in the vault goes to the account trash, once', async () => {
  const s = setup();
  const id = s.add('one.md', 'x');
  await s.sync();
  s.folder.files.delete('one.md');
  assert.equal(counts(await s.sync()), '0,0,0,0,0,0,1');
  assert.equal(s.docs.has(id), false);
  assert.equal(counts(await s.sync()), quiet);
});

test('a document deleted in the account removes its untouched file', async () => {
  const s = setup();
  const id = s.add('one.md', 'x');
  await s.sync();
  s.docs.delete(id);
  assert.equal(counts(await s.sync()), '0,0,0,0,0,1,0');
  assert.deepEqual(s.folder.paths(), []);
});

test('a file moved in the vault renames the same document', async () => {
  const s = setup();
  const id = s.add('one.md', 'content');
  await s.sync();
  const file = s.folder.files.get('one.md')!;
  s.folder.files.delete('one.md');
  s.folder.files.set('Archive/uno.md', file);
  const report = await s.sync();
  assert.equal(counts(report), '0,0,0,1,0,0,0');
  assert.deepEqual(s.calls.slice(-1), [`place ${id} Archive/uno.md`]);
  assert.equal(s.docs.size, 1);
  assert.equal(counts(await s.sync()), quiet, 'the rename the account made to itself is not downloaded back');
});

test('a folder whose files were moved up and which was then deleted in the vault goes from the account', async () => {
  const s = setup();
  const paper = s.add('Posts/Essay/Paper (2013)/Paper.md', 'notes');
  const pdf = s.add('Posts/Essay/Paper (2013)/Paper.txt', 'pdf');
  s.add('Posts/Essay/Essay.md', 'essay');
  await s.sync();
  // mv "Paper (2013)"/* .. && rmdir "Paper (2013)"
  for (const name of ['Paper.md', 'Paper.txt']) {
    s.folder.files.set(`Posts/Essay/${name}`, s.folder.files.get(`Posts/Essay/Paper (2013)/${name}`)!);
    s.folder.files.delete(`Posts/Essay/Paper (2013)/${name}`);
  }
  const report = await s.sync();
  assert.equal(counts(report), '0,0,0,2,0,0,0');
  assert.equal(report.foldersRemoved, 1);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(s.calls.slice(-3), [`place ${paper} Posts/Essay/Paper.md`, `place ${pdf} Posts/Essay/Paper.txt`, 'rmdir Posts/Essay/Paper (2013)']);
  assert.deepEqual([...s.folders.keys()].sort(), ['Posts', 'Posts/Essay']);
  const again = await s.sync();
  assert.equal(counts(again), quiet);
  assert.equal(again.foldersRemoved, 0);
});

test('a folder deleted in the vault with its files goes to the trash with them, nested folders too', async () => {
  const s = setup();
  const a = s.add('Old/a.md', 'a');
  const b = s.add('Old/Deeper/b.md', 'b');
  s.add('keep.md', 'k');
  s.add('one.md', '1');
  s.add('two.md', '2');
  await s.sync();
  s.folder.files.delete('Old/a.md');
  s.folder.files.delete('Old/Deeper/b.md');
  const report = await s.sync();
  assert.equal(report.trashed, 2);
  assert.equal(report.foldersRemoved, 2);
  assert.deepEqual(s.calls.slice(-4), [`trash ${a}`, `trash ${b}`, 'rmdir Old/Deeper', 'rmdir Old']);
  assert.deepEqual([...s.folders.keys()], []);
});

test('a folder renamed in the vault takes its documents to the new name and the old one goes', async () => {
  const s = setup();
  const id = s.add('Drafts/one.md', 'x');
  await s.sync();
  s.folder.files.set('Published/one.md', s.folder.files.get('Drafts/one.md')!);
  s.folder.files.delete('Drafts/one.md');
  const report = await s.sync();
  assert.equal(report.renamed, 1);
  assert.equal(report.foldersRemoved, 1);
  assert.deepEqual(s.docs.get(id)!.dir, ['Published']);
  assert.deepEqual([...s.folders.keys()], ['Published']);
});

test('folders the vault never had, or that were emptied in the account, are not removed', async () => {
  const s = setup();
  const id = s.add('Shelf/one.md', 'x');
  s.folderFor(['Empty']);
  await s.sync();
  Object.assign(s.docs.get(id)!, { dir: [], updatedAt: 9999 }); // moved out of Shelf in the app
  assert.equal(counts(await s.sync()), '1,0,0,0,1,0,0');
  assert.deepEqual(s.folder.paths(), ['one.md']);
  const again = await s.sync();
  assert.equal(again.foldersRemoved, 0);
  assert.deepEqual([...s.folders.keys()].sort(), ['Empty', 'Shelf']);
});

test('a folder gone from the vault stays while it holds a document the vault does not keep, and goes once it is empty', async () => {
  const s = setup();
  s.add('Box/one.md', 'x');
  const zip = s.add('Box/photos.zip', 'zip');
  await s.sync();
  s.folder.files.delete('Box/one.md');
  const report = await s.sync();
  assert.equal(report.trashed, 1);
  assert.equal(report.foldersRemoved, 0);
  assert.ok(s.folders.has('Box'));
  s.docs.delete(zip);
  assert.equal((await s.sync()).foldersRemoved, 1, 'it was remembered as gone from the vault');
  assert.equal(s.folders.has('Box'), false);
});

test('a vault synced before folders were remembered removes none on its first sync, with a shell too old to list folders', async () => {
  const s = setup();
  s.add('Notes/one.md', 'x');
  await s.sync();
  const memory = JSON.parse((await s.host.memory.load())!);
  assert.deepEqual(memory.folders, ['Notes']);
  delete memory.folders;
  await s.host.memory.save(JSON.stringify(memory));
  s.folder.files.set('one.md', s.folder.files.get('Notes/one.md')!);
  s.folder.files.delete('Notes/one.md');
  const report = await s.sync();
  assert.equal(report.renamed, 1);
  assert.equal(report.foldersRemoved, 0);
  assert.ok(s.folders.has('Notes'));
});

test('a document renamed in the account moves the file', async () => {
  const s = setup();
  const id = s.add('one.md', 'content');
  await s.sync();
  Object.assign(s.docs.get(id)!, { dir: ['Moved'], name: 'one.md', updatedAt: 9999 });
  assert.equal(counts(await s.sync()), '1,0,0,0,1,0,0');
  assert.deepEqual(s.folder.paths(), ['Moved/one.md']);
});

test('files the vault does not keep are left alone on both sides', async () => {
  const s = setup();
  s.add('photos.zip', 'zip bytes');
  s.folder.put('backup.zip', 'local zip');
  const report = await s.sync();
  assert.equal(counts(report), quiet);
  assert.equal(report.skipped, 1);
  assert.deepEqual(s.calls, []);
});

test('one action failing does not stop the rest, and is tried again next time', async () => {
  const s = setup();
  s.add('good.md', 'good');
  const bad = s.add('bad.md', 'bad');
  const download = s.cloud.download;
  let failing = true;
  s.cloud.download = async (id) => {
    if (failing && id === bad) throw new Error('offline');
    return download(id);
  };
  const first = await s.sync();
  assert.equal(first.downloaded, 1);
  assert.equal(first.errors.length, 1);
  assert.equal(first.errors[0]!.message, 'offline');
  failing = false;
  assert.equal(counts(await s.sync()), '1,0,0,0,0,0,0');
  assert.deepEqual(s.folder.paths(), ['bad.md', 'good.md']);
});

test('a vault never takes another account in', async () => {
  const s = setup('u1');
  s.add('one.md', 'x');
  await s.sync();
  const other = { ...s.host, account: 'u2' };
  const report = await syncVault(other);
  assert.equal(report.wrongAccount, true);
  assert.equal(s.calls.filter((c) => c.startsWith('trash')).length, 0);
});

test('a vault kept while signed out joins the account that signs in, matching files to documents by path', async () => {
  const s = setup(GUEST_ACCOUNT);
  s.add('one.md', 'kept here');
  await s.sync();
  s.folder.put('one.md', 'edited while signed out');
  s.folder.put('two.md', 'only a file');
  s.calls.length = 0;
  // Signing in adopts the browser's documents into a fresh account: same names, new ids.
  s.docs.clear();
  s.add('one.md', 'kept here', 'acct1');
  const report = await syncVault({ ...s.host, account: 'u1' });
  assert.equal(report.wrongAccount, undefined);
  assert.deepEqual(report.errors, []);
  assert.equal(counts(report), '0,1,1,0,0,0,0', 'one.md replaces the document, two.md becomes one');
  assert.equal(read(s.docs.get('acct1')!.bytes), 'wdoc:edited while signed out');
  assert.equal(s.docs.size, 2, 'no duplicate of one.md');
  assert.equal(s.calls.filter((c) => c.startsWith('trash')).length, 0);
});

test('a file found by path that is already its document is linked, with no upload and no version', async () => {
  const s = setup(GUEST_ACCOUNT);
  s.add('same.md', 'unchanged');
  s.add('changed.md', 'before');
  await s.sync();
  s.folder.put('changed.md', 'edited while signed out');
  s.calls.length = 0;
  s.docs.clear();
  s.add('same.md', 'unchanged', 'acct1');
  s.add('changed.md', 'before', 'acct2');
  const report = await syncVault({ ...s.host, account: 'u1' });
  assert.deepEqual(report.errors, []);
  assert.equal(report.linked, 1);
  assert.equal(counts(report), '0,1,0,0,0,0,0', 'only the edited file is uploaded');
  assert.deepEqual(s.calls.filter((c) => !c.startsWith('download')), ['keep acct2', 'replace acct2']);
  s.calls.length = 0;
  assert.equal(counts(await syncVault({ ...s.host, account: 'u1' })), quiet, 'and both stay linked');
  assert.deepEqual(s.calls, []);
});

test('a vault linked to an account is not used while signed out', async () => {
  const s = setup('u1');
  s.add('one.md', 'x');
  await s.sync();
  const report = await syncVault({ ...s.host, account: GUEST_ACCOUNT });
  assert.equal(report.wrongAccount, true);
  assert.equal(s.calls.filter((c) => c.startsWith('trash')).length, 0);
});

test('an emptied vault is not copied to the account until confirmed', async () => {
  const s = setup();
  for (let i = 0; i < 12; i++) s.add(`n${i}.md`, `note ${i}`);
  await s.sync();
  for (const path of s.folder.paths()) s.folder.files.delete(path);
  const held = await s.sync();
  assert.equal(held.blocked?.count, 12);
  assert.equal(s.docs.size, 12);
  const confirmed = await s.sync({ allowMassDelete: true });
  assert.equal(confirmed.trashed, 12);
  assert.equal(s.docs.size, 0);
});

const accountFolders = (s: ReturnType<typeof setup>) => [...s.folders.keys()].sort();

test('an empty folder in the account is made in the vault, and goes from the account once deleted there', async () => {
  const s = setup('u1', { folders: true });
  s.add('Notes/one.md', 'x');
  s.folderFor(['Notes', 'Empty']);
  s.folderFor(['Later']);
  const first = await s.sync();
  assert.deepEqual(first.errors, []);
  assert.deepEqual(s.folder.folders(), ['Later', 'Notes', 'Notes/Empty']);
  assert.equal(counts(await s.sync()), quiet);
  s.folder.rmrf('Notes/Empty');
  const report = await s.sync();
  assert.equal(report.foldersRemoved, 1);
  assert.deepEqual(accountFolders(s), ['Later', 'Notes']);
  assert.deepEqual(s.folder.folders(), ['Later', 'Notes'], 'not made again');
});

test('an empty folder made in the vault is made in the account, and goes from the vault once removed there', async () => {
  const s = setup('u1', { folders: true });
  s.add('one.md', 'x');
  await s.sync();
  await s.folder.disk.makeFolder!('Projects/Ideas');
  const report = await s.sync();
  assert.equal(report.foldersMade, 2);
  assert.deepEqual(accountFolders(s), ['Projects', 'Projects/Ideas']);
  assert.equal((await s.sync()).foldersMade, 0);
  s.folders.delete('Projects/Ideas'); // deleted in the app
  await s.sync();
  assert.deepEqual(s.folder.folders(), ['Projects']);
  assert.deepEqual(accountFolders(s), ['Projects'], 'not made again');
});

test('a document moved out of its folder in the app leaves the folder on both sides', async () => {
  const s = setup('u1', { folders: true });
  const id = s.add('Shelf/one.md', 'x');
  await s.sync();
  Object.assign(s.docs.get(id)!, { dir: [], updatedAt: 9999 });
  const report = await s.sync();
  assert.equal(report.movedHere, 1);
  assert.deepEqual(s.folder.paths(), ['one.md']);
  assert.deepEqual(s.folder.folders(), ['Shelf'], 'made again after the move emptied it');
  assert.equal((await s.sync()).foldersRemoved, 0);
  assert.deepEqual(accountFolders(s), ['Shelf']);
});

test('a folder removed in the app that still holds a file the vault does not keep stays in the vault, and is not made again in the account', async () => {
  const s = setup('u1', { folders: true });
  s.add('Box/one.md', 'x');
  await s.sync();
  s.folder.put('Box/photos.zip', 'zip');
  await s.sync();
  const id = [...s.docs.values()].find((d) => d.name === 'one.md')!.id;
  Object.assign(s.docs.get(id)!, { dir: [], updatedAt: 9999 }); // the folder is removed in the app: what was in it moves up
  s.folders.delete('Box');
  await s.sync();
  assert.deepEqual(s.folder.paths(), ['Box/photos.zip', 'one.md']);
  assert.deepEqual(accountFolders(s), []);
  await s.sync();
  assert.deepEqual(accountFolders(s), [], 'not made again while it is left here');
  assert.deepEqual(s.folder.folders(), ['Box']);
  s.folder.files.delete('Box/photos.zip');
  await s.folder.disk.makeFolder!('Box');
  await s.sync();
  assert.deepEqual(s.folder.folders(), [], 'once empty it goes');
  assert.deepEqual(accountFolders(s), []);
});

test('the first sync that lists folders removes the empty folders a vault synced before had lost, and brings the rest here', async () => {
  const s = setup('u1', { folders: true });
  s.add('Posts/Essay/Paper (2013)/Paper.md', 'notes');
  s.add('Posts/Essay/Essay.md', 'essay');
  s.add('Archive/old.zip', 'zip');
  await s.sync();
  // As a shell too old to list folders left it: the folders that held files, and a folder whose files were moved up since.
  const memory = JSON.parse((await s.host.memory.load())!);
  delete memory.mirrored;
  memory.folders = ['Posts', 'Posts/Essay'];
  await s.host.memory.save(JSON.stringify(memory));
  s.folderFor(['Posts', 'Essay', 'Paper (2013)', 'Figures']);
  s.folder.files.set('Posts/Essay/Paper.md', s.folder.files.get('Posts/Essay/Paper (2013)/Paper.md')!);
  s.folder.rmrf('Posts/Essay/Paper (2013)');
  s.folder.rmrf('Archive');
  s.folder.dirs.clear();
  const report = await s.sync();
  assert.deepEqual(report.errors, []);
  assert.equal(report.foldersRemoved, 2);
  assert.deepEqual(accountFolders(s), ['Archive', 'Posts', 'Posts/Essay'], 'a folder holding a document the vault does not keep stays');
  assert.deepEqual(s.folder.folders(), ['Archive', 'Posts', 'Posts/Essay'], 'and is brought here');
});

test('a vault linked for the first time gets the account\'s empty folders and removes none', async () => {
  const s = setup('u1', { folders: true });
  s.folderFor(['Empty']);
  const report = await s.sync();
  assert.equal(report.foldersRemoved, 0);
  assert.deepEqual(s.folder.folders(), ['Empty']);
});

test('a folder whose name the account spells differently is not made there', async () => {
  const s = setup('u1', { folders: true });
  await s.folder.disk.makeFolder!('a:b');
  const report = await s.sync();
  assert.equal(report.foldersMade, 0);
  assert.deepEqual(accountFolders(s), []);
});

test('the sync state is kept in this computer\'s memory, and the folder only says whose it is', async () => {
  const s = setup();
  s.add('one.md', 'x');
  await s.sync();
  assert.equal(JSON.parse((await s.host.memory.load())!).entries.length, 1);
  assert.deepEqual(JSON.parse(s.folder.get(STATE_PATH)!), { version: 1, account: 'u1', entries: [] });
});

test('a sync state an older version kept in the folder is taken over once, so nothing is synced again', async () => {
  const s = setup();
  s.add('one.md', 'x');
  s.add('two.md', 'y');
  await s.sync();
  // As an older version left it: the whole manifest in the folder, and no memory on this computer.
  s.folder.put(STATE_PATH, (await s.host.memory.load())!);
  s.calls.length = 0;
  const report = await syncVault({ ...s.host, memory: fakeMemory() });
  assert.equal(counts(report), quiet);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(JSON.parse(s.folder.get(STATE_PATH)!).entries, [], 'and the folder keeps only the owner from then on');
});

test('two signed-out computers sharing a folder (iCloud Drive, Dropbox) each take its files in, and neither deletes them', async () => {
  const a = setup(GUEST_ACCOUNT);
  for (let i = 0; i < 3; i++) a.add(`n${i}.md`, `note ${i}`);
  await a.sync();
  // An older version's manifest in the folder names computer A's documents, which computer B has never had.
  a.folder.put(STATE_PATH, (await a.host.memory.load())!);
  const b = fakeCloud();
  const onB: VaultHost = { ...a.host, cloud: b.cloud, memory: fakeMemory() };
  const first = await syncVault(onB);
  assert.deepEqual(first.errors, []);
  assert.equal(`${first.deletedHere},${first.created}`, '0,3');
  assert.deepEqual(a.folder.paths(), ['n0.md', 'n1.md', 'n2.md']);
  // An edit on B reaches A through the folder, and A's next sync deletes nothing either.
  const id = [...b.docs.values()].find((d) => d.name === 'n1.md')!.id;
  b.edit(id, 'changed on B');
  await syncVault(onB);
  const back = await a.sync();
  assert.equal(`${back.uploaded},${back.deletedHere},${back.trashed}`, '1,0,0');
  assert.equal(read([...a.docs.values()].find((d) => d.name === 'n1.md')!.bytes), 'wdoc:changed on B');
});

test('a folder that belongs to an account is not used signed out on another computer either', async () => {
  const s = setup('u1');
  s.add('one.md', 'x');
  await s.sync();
  const report = await syncVault({ ...s.host, account: GUEST_ACCOUNT, cloud: fakeCloud().cloud, memory: fakeMemory() });
  assert.equal(report.wrongAccount, true);
  assert.deepEqual(s.folder.paths(), ['one.md']);
});

test('a CSV edited in the vault keeps its layout, and a layout changed in the account leaves the file alone', async () => {
  const fonts = { fonts: async () => ({}) as FontSet, file: () => Promise.reject(new Error('no fonts needed')) };
  const s = setup();
  s.host.codec = { toFile: (stored, name) => toVaultFile(stored, name, fonts), fromFile: fromVaultFile, keepsLayout: (name) => name.endsWith('.csv'), kept: (name) => vaultFormat(name) !== null };
  const id = s.add('sales.csv', '');
  s.docs.get(id)!.bytes = await delimitedWdoc(text('a,b\n'), 'csv', { columns: [[0, 200]] });
  await s.sync();
  assert.equal(s.folder.get('sales.csv'), 'a,b\n');
  const written = s.folder.files.get('sales.csv')!.mtimeMs;

  // Only the widths change in the account: the file is not written again.
  s.docs.get(id)!.bytes = await delimitedWdoc(text('a,b\n'), 'csv', { columns: [[0, 300]] });
  s.docs.get(id)!.updatedAt++;
  assert.deepEqual((await s.sync()).errors, []);
  assert.equal(s.folder.files.get('sales.csv')!.mtimeMs, written);
  assert.equal(counts(await s.sync()), quiet, 'and the sync settles');

  // An agent changes the file: the account gets the new file, with the widths.
  s.folder.put('sales.csv', 'a,b\n1,2\n');
  assert.equal((await s.sync()).uploaded, 1);
  const wdoc = await readWdoc(s.docs.get(id)!.bytes);
  assert.equal(read(wdoc.delimited!), 'a,b\n1,2\n');
  assert.deepEqual(wdoc.extensions.csv?.layout, { columns: [[0, 300]] });
});

test('with the real converters, PDFs and pictures go out as the files they are and a changed one comes back in place of the document', async () => {
  const canvas = installFakeCanvas(() => ({ width: 1, height: 1 }));
  try {
    // A picture's and a PDF's own pages need no fonts: a FontSet that is never read.
    const fonts = { fonts: async () => ({}) as FontSet, file: () => Promise.reject(new Error('no fonts needed')) };
    const real: VaultCodec = { toFile: (stored, name) => toVaultFile(stored, name, fonts), fromFile: fromVaultFile, kept: (name) => vaultFormat(name) !== null };
    const s = setup();
    s.host.codec = real;
    const page = PdfDocument.create();
    const d = new PageDrawing(page.addPage([300, 200]), { origin: 'top-left' });
    d.text('Signed copy', 20, 40, { font: page.standardFont('Courier'), size: 12 });
    d.finish();
    const original = await page.save();
    const note = { id: 'n', page: 0, kind: 'note' as const, rect: [5, 5, 20, 20] as [number, number, number, number], quads: [], color: [1, 1, 0] as [number, number, number], contents: 'Looks good' };
    const pdfId = s.add('Contract.pdf', '');
    s.docs.get(pdfId)!.bytes = await writeWdoc({ manifest: { version: WDOC_VERSION, lens: 'pdf', origin: 'pdf', pagesCurrent: true }, document: null, original, extensions: { pdf: { annotations: [note] } } });
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    const picture = await readWdoc(await fromVaultFile(png, 'dot.png'));
    const pictureId = s.add('dot.png', '');
    s.docs.get(pictureId)!.bytes = await writeWdoc({ ...picture, extensions: { img: { shapes: [{ id: 's', tool: 'rectangle', color: '#f00', width: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] } } });

    const first = await s.sync();
    assert.deepEqual(first.errors, []);
    assert.equal(first.downloaded, 2);
    assert.equal(first.skipped, 0, 'nothing is left to the account');
    const onDisk = s.folder.files.get('Contract.pdf')!.bytes;
    assert.deepEqual(readAnnotations(PdfDocument.load(onDisk)).map((a) => a.contents), ['Looks good'], 'the note is in the file');
    assert.equal(s.folder.get('dot.png'), 'encoded:image/png', 'the layers are drawn in');

    // Another program signs the PDF: the file replaces the document, which is now just that file.
    const signed = await PdfDocument.create().save();
    s.folder.files.set('Contract.pdf', { bytes: signed, mtimeMs: 99_999 });
    const second = await s.sync();
    assert.deepEqual(second.errors, []);
    assert.equal(second.uploaded, 1);
    const back = await readWdoc(s.docs.get(pdfId)!.bytes);
    assert.deepEqual(back.original, signed);
    assert.deepEqual(back.extensions, {}, 'the old annotations are gone with the old original');
    assert.equal(counts(await s.sync()), quiet);
  } finally {
    canvas.restore();
  }
});

test('a file that comes down has its document\'s dates, and a move in the account keeps them', async () => {
  const s = setup();
  const id = s.add('one.md', 'x');
  const made = s.docs.get(id)!.createdAt;
  await s.sync();
  assert.deepEqual([s.folder.files.get('one.md')!.created, s.folder.files.get('one.md')!.mtimeMs], [made, s.docs.get(id)!.updatedAt]);
  assert.equal(counts(await s.sync()), quiet, 'the dates the sync gave are not mistaken for an edit');

  const before = s.folder.files.get('one.md')!.mtimeMs;
  await s.cloud.place(id, ['Moved'], 'two.md'); // the account's time moves with a rename
  await s.sync();
  const moved = s.folder.files.get('Moved/two.md')!;
  assert.deepEqual([moved.created, moved.mtimeMs], [made, before], 'neither date changes with the move');
  assert.equal(counts(await s.sync()), quiet);

  s.edit(id, 'new words');
  await s.sync();
  assert.deepEqual([s.folder.files.get('Moved/two.md')!.created, s.folder.files.get('Moved/two.md')!.mtimeMs], [made, s.docs.get(id)!.updatedAt]);
  assert.equal(counts(await s.sync()), quiet);
});

test('a file made in the vault keeps its own creation date', async () => {
  const s = setup();
  s.folder.put('mine.md', 'mine');
  s.folder.files.get('mine.md')!.created = 7; // earlier than the account's
  await s.sync();
  assert.equal(s.folder.files.get('mine.md')!.created, 7);
});

test('files a shell could not date get their creation date once it can', async () => {
  const s = setup();
  const id = s.add('one.md', 'x');
  const setTimes = s.folder.disk.setTimes!;
  s.folder.disk.setTimes = async () => null; // an older shell
  await s.sync();
  const file = s.folder.files.get('one.md')!;
  assert.notEqual(file.created, s.docs.get(id)!.createdAt);
  const mtime = file.mtimeMs;

  s.folder.disk.setTimes = setTimes;
  assert.equal(counts(await s.sync()), quiet);
  assert.equal(file.created, s.docs.get(id)!.createdAt);
  assert.equal(file.mtimeMs, mtime, 'only the creation date: the modification time is the file\'s own');
  s.folder.dated.length = 0;
  await s.sync();
  assert.deepEqual(s.folder.dated, [], 'once');
});

test('a document with no creation time (saved in this browser) leaves the file\'s creation date alone', async () => {
  const s = setup();
  s.folder.put('mine.md', 'mine');
  s.folder.files.get('mine.md')!.created = 7;
  const list = s.cloud.list;
  s.cloud.list = async () => {
    const listed = await list();
    return { ...listed, docs: listed.docs.map((d) => ({ ...d, createdAt: 0 })) };
  };
  await s.sync();
  await s.sync();
  assert.equal(s.folder.files.get('mine.md')!.created, 7);
});
