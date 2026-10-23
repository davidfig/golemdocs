// One sync of the desktop vault (src/desktop/vaultSync.ts), against a folder and an account kept in memory.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { FontSet } from '@golemdocs/layout';
import { PageDrawing, PdfDocument, readAnnotations } from '../../pdf/src/index.ts';
import { fromVaultFile, toVaultFile, vaultFormat } from '../src/desktop/vaultCodec.ts';
import { GUEST_ACCOUNT, STATE_PATH, syncVault, type SyncReport, type VaultCloud, type VaultCodec, type VaultDisk, type VaultHost } from '../src/desktop/vaultSync.ts';
import { readWdoc, writeWdoc, WDOC_VERSION } from '../src/formats/wdoc.ts';
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

/** An account in memory. Stored bytes are "wdoc:" + the file, so the codec is visible in the assertions. */
function fakeCloud() {
  let clock = 100;
  let ids = 0;
  const docs = new Map<string, Doc>();
  const calls: string[] = [];
  const cloud: VaultCloud = {
    async list() {
      const folders = new Map<string, { id: string; name: string; parentId: string | null }>();
      const placed = [...docs.values()].map((d) => {
        let parent: string | null = null;
        for (const name of d.dir) {
          const key = `${parent}/${name}`;
          if (!folders.has(key)) folders.set(key, { id: key, name, parentId: parent });
          parent = key;
        }
        return { id: d.id, name: d.name, folderId: parent, createdAt: d.createdAt, updatedAt: d.updatedAt };
      });
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
  return { cloud, docs, calls, add, edit };
}

/** A folder in memory that behaves like the native side: hidden names are not listed, and every write has a new time. */
function fakeDisk() {
  let clock = 5000;
  const files = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
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
      files.set(path, { bytes, mtimeMs: ++clock });
      return clock;
    },
    async remove(path) {
      files.delete(path);
    },
  };
  const put = (path: string, content: string) => void files.set(path, { bytes: text(content), mtimeMs: ++clock });
  const get = (path: string) => (files.has(path) ? read(files.get(path)!.bytes) : undefined);
  const paths = () => [...files.keys()].filter((p) => !p.startsWith('.')).sort();
  return { disk, files, put, get, paths };
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

function setup(account = 'u1') {
  const account_ = fakeCloud();
  const folder = fakeDisk();
  const host: VaultHost = { disk: folder.disk, cloud: account_.cloud, codec, hash: async (b) => createHash('sha256').update(b).digest('hex'), account };
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

test('the sync state is kept in the hidden state file', async () => {
  const s = setup();
  s.add('one.md', 'x');
  await s.sync();
  const state = JSON.parse(s.folder.get(STATE_PATH)!);
  assert.equal(state.account, 'u1');
  assert.equal(state.entries.length, 1);
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
