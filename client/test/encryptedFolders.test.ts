// Encrypted documents and folders in this browser (docs/encrypted-folders.md): the session's keys (src/encryption/session.ts), what storage
// keeps (sealed, src/storage/local.ts), converting what a person has (src/encryption/convert.ts) and what the library shows
// (src/encryption/present.ts).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { isSealed, isSealedName, sealedKeyId, wrappedKeyId } from '@golemdocs/ops';
import { fakeIndexedDB } from './fakeIndexedDB.ts';
import type { Folder } from '../src/folders.ts';
import type { LibraryEntry } from '../src/sync.ts';

(globalThis as { indexedDB: unknown }).indexedDB = fakeIndexedDB();
const local = await import('../src/storage/local.ts');
const session = await import('../src/encryption/session.ts');
const { presentSealed } = await import('../src/encryption/present.ts');
const convert = await import('../src/encryption/convert.ts');
const { newPersonalKey, newItemKey } = await import('../src/encryption/crypto.ts');

const now = 1_700_000_000_000;
const folder = (id: string, extra: Partial<Folder> = {}): Folder => ({ id, name: id, parentId: null, createdAt: now, updatedAt: now, ...extra });
const bytes = (n: number, length = 3000) => new Uint8Array(length).fill(n);
const uuid = () => crypto.randomUUID();
const guest = { owner: undefined, cloud: false };
const entryOf = (info: Awaited<ReturnType<typeof local.saveSaved>>): LibraryEntry => ({
  key: info.id,
  name: info.name,
  size: info.size,
  updatedAt: info.updatedAt,
  local: info,
  cloud: null,
  state: 'local-only',
  folderId: info.folderId ?? null,
  ...(info.encrypted ? { encrypted: true } : {}),
});

/** An encrypted folder made with a fresh personal key, known to the session, which is then locked: the key's text to unlock it with. */
async function encryptedFolder(): Promise<{ taxes: Folder; key: string }> {
  session.lock();
  const personal = await newPersonalKey();
  const { wrapped } = await newItemKey(personal);
  const taxes = folder(uuid(), { name: 'Taxes', encrypted: true, wrappedKey: wrapped });
  session.knowFolders([taxes, folder(uuid())]);
  return { taxes, key: personal.text };
}

beforeEach(async () => {
  session.lock();
  session.knowFolders([]);
  session.knowDocuments([]);
  for (const d of await local.listSaved()) await local.deleteSaved(d.id);
});
afterEach(() => session.lock());

test('a key unlocks what it encrypted, and only that; a wrong key unlocks nothing and is not kept', async () => {
  const { taxes, key } = await encryptedFolder();
  assert.equal(session.isEncryptedFolder(taxes.id), true);
  assert.equal(session.anyLocked(), true);
  assert.equal(await session.unlock((await newPersonalKey()).text), 0);
  assert.equal(session.isUnlocked(), false);
  assert.ok((await session.unlock(key)) > 0);
  assert.equal(await session.opens(taxes.wrappedKey), true);
  assert.equal(session.anyLocked(), false);
  session.lock();
  assert.equal(await session.opens(taxes.wrappedKey), false, 'locking forgets the keys');
});

test('a document saved into an encrypted folder gets a key of its own, and is kept sealed, file and name', async () => {
  const { taxes, key } = await encryptedFolder();
  await assert.rejects(local.saveSaved({ name: 'Plan.docx', bytes: bytes(1), folderId: taxes.id }), session.LockedError, 'nothing is saved readable while locked');
  await session.unlock(key);
  const info = await local.saveSaved({ name: 'Plan.docx', bytes: bytes(1), folderId: taxes.id, undo: '{"steps":[]}' });
  const other = await local.saveSaved({ name: 'Other.docx', bytes: bytes(2), folderId: taxes.id });
  assert.equal(info.encrypted, true);
  assert.ok(info.wrappedKey && other.wrappedKey && wrappedKeyId(info.wrappedKey) !== wrappedKeyId(other.wrappedKey), 'each document its own key');
  assert.ok(isSealedName(info.name));
  const raw = (await local.getSaved(info.id, { sealed: true }))!;
  assert.ok(isSealed(new Uint8Array(raw.bytes)));
  assert.equal(sealedKeyId(new Uint8Array(raw.bytes)), wrappedKeyId(info.wrappedKey!));
  const opened = (await local.getSaved(info.id))!;
  assert.equal(opened.info.name, 'Plan.docx');
  assert.deepEqual(new Uint8Array(opened.bytes), bytes(1));
  assert.equal(await local.getUndo(info), null, 'no undo steps are kept for it');
  // Saved again under its open name (as the editor does): still sealed, with the same key.
  const again = await local.saveSaved({ id: info.id, name: 'Plan.docx', bytes: bytes(3) });
  assert.equal(again.wrappedKey, info.wrappedKey);
  assert.ok(isSealedName(again.name));
  await local.setSavedName(info.id, 'Renamed.docx');
  assert.equal((await local.getSaved(info.id))!.info.name, 'Renamed.docx');
  session.lock();
  await assert.rejects(local.getSaved(info.id), session.LockedError);
  assert.ok(await local.getSaved(info.id, { sealed: true }), 'the sealed copy can still be read, to be uploaded');
});

test('an encrypted document moves anywhere; an ordinary one is encrypted before it goes into an encrypted folder', async () => {
  const { taxes, key } = await encryptedFolder();
  await session.unlock(key);
  const secret = await local.saveSaved({ name: 'Secret.docx', bytes: bytes(1), folderId: taxes.id });
  await local.setSavedFolder(secret.id, null);
  assert.equal((await local.getSaved(secret.id))!.info.encrypted, true, 'still encrypted outside');
  const plain = await local.saveSaved({ name: 'Open.docx', bytes: bytes(2) });
  await assert.rejects(local.setSavedFolder(plain.id, taxes.id));
  await assert.rejects(local.saveSaved({ id: plain.id, name: 'Open.docx', bytes: bytes(2), folderId: taxes.id }));
});

test('a sealed file from the account is stored as it came, with its key', async () => {
  const personal = await newPersonalKey();
  const { wrapped } = await newItemKey(personal);
  session.knowKey(wrapped);
  await session.unlock(personal.text);
  const sealed = await session.sealFileWith(wrapped, bytes(5));
  const name = await session.sealNameWith(wrapped, 'From the cloud.docx');
  session.lock();
  const info = await local.saveFromCloud({ name, bytes: sealed, cloudId: uuid(), cloudUpdatedAt: 1, wrappedKey: wrapped });
  assert.equal(info.encrypted, true);
  assert.equal(info.wrappedKey, wrapped);
  assert.equal(info.name, name);
  assert.equal(session.isSealedCopy(info.id), true);
  await session.unlock(personal.text);
  assert.deepEqual(new Uint8Array((await local.getSaved(info.id))!.bytes), bytes(5), 'opened with the key the file names');
});

test('encrypting a document seals it and every version it keeps, without keeping a readable one; decrypting turns it back', async () => {
  await session.createKey();
  let info = await local.saveSaved({ name: 'Diary.docx', bytes: bytes(1) });
  await local.keepVersion(info.id, 'First draft');
  info = await local.saveSaved({ id: info.id, name: 'Diary.docx', bytes: bytes(2) });
  const before = await local.listVersions(info.id);
  assert.ok(before.length >= 1);
  await convert.encryptDocument(entryOf(info), guest);
  const sealedInfo = (await local.getSaved(info.id, { sealed: true }))!;
  assert.equal(sealedInfo.info.encrypted, true);
  assert.ok(isSealed(new Uint8Array(sealedInfo.bytes)));
  assert.ok(isSealedName(sealedInfo.info.name));
  const versions = await local.listVersions(info.id);
  assert.deepEqual(versions.map((v) => v.version), before.map((v) => v.version), 'no readable copy kept as a new version');
  assert.ok(versions.every((v) => v.name === null || isSealedName(v.name)), 'version names sealed');
  assert.deepEqual(new Uint8Array((await local.getVersion(info.id, before[0]!.version))!), bytes(1), 'versions open with the key');
  assert.equal((await local.getSaved(info.id))!.info.name, 'Diary.docx');
  // And back.
  const encryptedEntry = { ...entryOf(sealedInfo.info), encrypted: true };
  await convert.decryptDocument(encryptedEntry, guest);
  const back = (await local.getSaved(info.id, { sealed: true }))!;
  assert.equal(back.info.encrypted, undefined);
  assert.equal(back.info.wrappedKey, undefined);
  assert.equal(back.info.name, 'Diary.docx');
  assert.deepEqual(new Uint8Array(back.bytes), bytes(2));
  assert.ok((await local.listVersions(info.id)).some((v) => v.name === 'First draft'));
});

test('encrypting a folder encrypts what is in it, seals the names of the folders inside, and keeps its own name', async () => {
  await session.createKey();
  const top = folder(uuid(), { name: 'Taxes' });
  const sub = folder(uuid(), { name: '2027', parentId: top.id });
  await local.putLocalFolder(top);
  await local.putLocalFolder(sub);
  session.knowFolders([top, sub]);
  const inTop = await local.saveSaved({ name: 'Return.pdf', bytes: bytes(1), folderId: top.id });
  const inSub = await local.saveSaved({ name: 'Receipts.docx', bytes: bytes(2), folderId: sub.id });
  const outside = await local.saveSaved({ name: 'Elsewhere.docx', bytes: bytes(3) });
  const steps: string[] = [];
  await convert.encryptFolder(top, [top, sub], [inTop, inSub, outside].map(entryOf), guest, (done, total) => steps.push(`${done}/${total}`));
  assert.deepEqual(steps, ['0/2', '1/2', '2/2']);
  const stored = await local.listLocalFolders();
  const storedTop = stored.find((f) => f.id === top.id)!;
  const storedSub = stored.find((f) => f.id === sub.id)!;
  assert.equal(storedTop.name, 'Taxes');
  assert.ok(storedTop.encrypted && storedTop.wrappedKey);
  assert.ok(storedSub.encrypted && storedSub.wrappedKey && isSealedName(storedSub.name));
  for (const id of [inTop.id, inSub.id]) assert.equal((await local.getSaved(id, { sealed: true }))!.info.encrypted, true);
  assert.equal((await local.getSaved(outside.id, { sealed: true }))!.info.encrypted, undefined, 'what is outside is left alone');
  // A new document saved into it later is encrypted on the way in.
  session.knowFolders(stored);
  assert.equal((await local.saveSaved({ name: 'Later.docx', bytes: bytes(4), folderId: sub.id })).encrypted, true);
});

test('no thumbnail is kept for an encrypted document', async () => {
  const { taxes, key } = await encryptedFolder();
  await session.unlock(key);
  const secret = await local.saveSaved({ name: 'Secret.docx', bytes: bytes(1), folderId: taxes.id });
  await local.saveThumbnail(secret.id, new Blob(['x']), secret.updatedAt);
  assert.equal(await local.getThumbnail(secret.id), null);
});

test('locking saves first: the work before locking runs while the keys are still there', async () => {
  const { taxes, key } = await encryptedFolder();
  await session.unlock(key);
  let sealedBeforeLock = false;
  const stop = session.onBeforeLock(async () => {
    sealedBeforeLock = isSealed(await session.sealFileWith(taxes.wrappedKey!, bytes(1)));
  });
  const seen: boolean[] = [];
  const unlisten = session.onSessionChange((open) => seen.push(open));
  await session.lockSession();
  stop();
  unlisten();
  assert.equal(sealedBeforeLock, true);
  assert.deepEqual(seen, [false]);
  assert.equal(session.isUnlocked(), false);
});

test('the idle lock: nothing done for the set time locks the session, and anything done starts the count again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { key } = await encryptedFolder();
  session.setIdleMinutes(1);
  await session.unlock(key);
  t.mock.timers.tick(50_000);
  session.touch();
  t.mock.timers.tick(50_000);
  assert.equal(session.isUnlocked(), true, 'touched 50 s ago');
  t.mock.timers.tick(11_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.isUnlocked(), false);
  session.setIdleMinutes(15);
});

test('the library shows encrypted things where they are: names opened while unlocked, placeholders with a padlock while locked', async () => {
  const personal = await newPersonalKey();
  const { wrapped: topKey } = await newItemKey(personal);
  const { wrapped: subKey } = await newItemKey(personal);
  const { wrapped: docKey } = await newItemKey(personal);
  for (const k of [topKey, subKey, docKey]) session.knowKey(k);
  await session.unlock(personal.text);
  const top = folder(uuid(), { name: 'Taxes', encrypted: true, wrappedKey: topKey });
  const sub = folder(uuid(), { name: await session.sealNameWith(subKey, '2027'), parentId: top.id, encrypted: true, wrappedKey: subKey });
  const docName = await session.sealNameWith(docKey, 'Return.pdf');
  session.lock();
  const cloud = { id: 'c1', name: docName, size: 1, createdAt: now, updatedAt: now, thumbAt: null, folderId: sub.id, encrypted: true, wrappedKey: docKey };
  const secret: LibraryEntry = { key: 'a', name: docName, size: 1, updatedAt: now, local: null, cloud, state: 'cloud-only', folderId: sub.id };
  const open: LibraryEntry = { key: 'b', name: 'Notes.md', size: 1, updatedAt: now, local: null, cloud: null, state: 'cloud-only', folderId: null };
  const listing = { entries: [secret, open], local: [], cloud: [cloud], folders: [top, sub, folder('plain', { name: 'Plain' })] };
  const locked = await presentSealed(listing);
  assert.deepEqual(
    locked.entries.map((e) => [e.name, e.locked ?? false]),
    [['Encrypted document', true], ['Notes.md', false]],
  );
  assert.deepEqual(locked.cloud, [], 'what is locked is left out of the copies');
  assert.deepEqual(
    locked.folders!.map((f) => [f.name, f.locked ?? false]),
    [['Taxes', true], ['Encrypted folder', true], ['Plain', false]],
  );
  await session.unlock(personal.text);
  const unlocked = await presentSealed(listing);
  assert.deepEqual(unlocked.entries.map((e) => e.name), ['Return.pdf', 'Notes.md']);
  assert.equal(unlocked.entries[0]!.cloud!.name, 'Return.pdf');
  assert.deepEqual(unlocked.folders!.map((f) => [f.name, f.locked ?? false]), [['Taxes', false], ['2027', false], ['Plain', false]]);
});

test('decrypting into the vault: only while unlocked, by the folder that was encrypted, and forgotten when the session locks', async () => {
  const personal = await newPersonalKey();
  const { wrapped: topKey } = await newItemKey(personal);
  const { wrapped: subKey } = await newItemKey(personal);
  const top = folder(uuid(), { name: 'Taxes', encrypted: true, wrappedKey: topKey });
  const sub = folder(uuid(), { name: 'gde1.x', parentId: top.id, encrypted: true, wrappedKey: subKey });
  const plain = folder(uuid(), { name: 'Plain' });
  session.knowFolders([top, sub, plain]);
  assert.equal(session.encryptedTopOf(sub.id), top.id);
  assert.equal(session.encryptedTopOf(plain.id), null);
  assert.throws(() => session.setDecryptedInVault(top.id, true), session.LockedError);
  await session.unlock(personal.text);
  let changes = 0;
  const stop = session.onVaultChange(() => changes++);
  session.setDecryptedInVault(sub.id, true);
  assert.deepEqual(session.foldersInVault(), [top.id], 'a subfolder stands for the folder that was encrypted');
  assert.equal(session.decryptedInVault(sub.id), true);
  assert.equal(session.decryptedInVault(plain.id), false);
  // A document written to the vault with that folder stays in it wherever it moves, until the folder stops.
  session.rememberInVault([{ id: 'doc', top: top.id }]);
  assert.equal(session.documentInVault('doc'), true);
  session.setDecryptedInVault(top.id, false);
  assert.equal(session.documentInVault('doc'), false);
  session.setDecryptedInVault(top.id, true);
  session.lock();
  assert.deepEqual(session.foldersInVault(), []);
  stop();
  assert.equal(changes, 3);
});

test('only what is sealed with the document’s own key is kept as it is: a readable file or name that only looks sealed is sealed', async () => {
  const { taxes, key } = await encryptedFolder();
  await session.unlock(key);
  // Starts like a sealed file (`GDE1`, long enough), and its name like a sealed name.
  const lookalike = new Uint8Array(200).fill(7);
  lookalike.set(new TextEncoder().encode('GDE1'), 0);
  assert.ok(isSealed(lookalike) && isSealedName('gde1.notes'));
  const info = await local.saveSaved({ name: 'gde1.notes', bytes: lookalike, folderId: taxes.id });
  const raw = (await local.getSaved(info.id, { sealed: true }))!;
  assert.equal(sealedKeyId(new Uint8Array(raw.bytes)), wrappedKeyId(info.wrappedKey!), 'sealed with its key, not kept as it came');
  assert.notEqual(raw.info.name, 'gde1.notes');
  const opened = (await local.getSaved(info.id))!;
  assert.deepEqual(new Uint8Array(opened.bytes), lookalike);
  assert.equal(opened.info.name, 'gde1.notes');
  // Sealed with another document's key: sealed again with this one's, so it opens with its own key.
  const other = await local.saveSaved({ name: 'Other.docx', bytes: bytes(2), folderId: taxes.id });
  const foreign = new Uint8Array((await local.getSaved(other.id, { sealed: true }))!.bytes);
  const resealed = await session.sealFileWith(info.wrappedKey!, foreign);
  assert.equal(sealedKeyId(resealed), wrappedKeyId(info.wrappedKey!));
  // Already sealed with its own key: kept as it is.
  assert.deepEqual(await session.sealFileWith(info.wrappedKey!, new Uint8Array(raw.bytes)), new Uint8Array(raw.bytes));
  // An ordinary document whose file starts like a sealed one is saved as it is, readable.
  const ordinary = await local.saveSaved({ name: 'gde1.txt', bytes: lookalike });
  assert.equal(ordinary.encrypted, undefined);
  assert.deepEqual(new Uint8Array((await local.getSaved(ordinary.id))!.bytes), lookalike);
});

test('encrypting a document drops its thumbnail, search index and memory image here', async () => {
  await session.createKey();
  const info = await local.saveSaved({ name: 'Diary.docx', bytes: bytes(1) });
  await local.saveThumbnail(info.id, new Blob(['page']), info.updatedAt);
  await local.putSearchIndex(info.id, { stamp: 's', index: { v: 1 } as never });
  await local.saveImage(info.id, bytes(9, 10));
  assert.ok((await local.getThumbnail(info.id)) && (await local.getSearchIndex(info.id)) && (await local.getImage(info.id)));
  await convert.encryptDocument(entryOf(info), guest);
  assert.equal(await local.getThumbnail(info.id), null);
  assert.equal(await local.getSearchIndex(info.id), null);
  assert.equal(await local.getImage(info.id), null);
  await local.saveImage(info.id, bytes(9, 10));
  assert.equal(await local.getImage(info.id), null, 'none is kept for it afterwards');
});

test('a folder whose encryption was cut short is finished: what was left readable in it is encrypted, folders inside too', async () => {
  await session.createKey();
  const top = folder(uuid(), { name: 'Taxes' });
  const sub = folder(uuid(), { name: '2027', parentId: top.id });
  await local.putLocalFolder(top);
  await local.putLocalFolder(sub);
  session.knowFolders([top, sub]);
  const done = await local.saveSaved({ name: 'Done.docx', bytes: bytes(1), folderId: top.id });
  const left = await local.saveSaved({ name: 'Left.docx', bytes: bytes(2), folderId: sub.id });
  // Cut short: the folder was marked encrypted, and one document converted, before the tab closed.
  const key = await session.newKey();
  const marked = { ...top, encrypted: true, wrappedKey: key };
  await local.updateLocalFolder(top.id, { encrypted: true, wrappedKey: key }, now);
  session.knowFolders([marked, sub]);
  await convert.encryptDocument(entryOf(done), guest);
  const entries = [entryOf((await local.getSaved(done.id))!.info), entryOf(left)];
  assert.equal(await convert.finishEncrypting([marked, sub], entries, guest), true);
  assert.equal((await local.getSaved(left.id, { sealed: true }))!.info.encrypted, true);
  const storedSub = (await local.listLocalFolders()).find((f) => f.id === sub.id)!;
  assert.ok(storedSub.encrypted && isSealedName(storedSub.name));
  // Nothing left to do, and nothing at all while locked.
  session.knowFolders(await local.listLocalFolders());
  const after = (await local.listSaved()).filter((d) => d.folderId).map(entryOf);
  assert.equal(await convert.finishEncrypting(await local.listLocalFolders().then((all) => all.map((f) => (f.id === sub.id ? { ...f, name: '2027' } : f))), after, guest), false);
  session.lock();
  assert.equal(await convert.finishEncrypting([marked, sub], entries, guest), false);
});

test('what was deleted from a folder before it was encrypted is found in the trash, still readable, and can be deleted for good', async () => {
  await session.createKey();
  const top = folder(uuid(), { name: 'Taxes' });
  const sub = folder(uuid(), { name: '2027', parentId: top.id });
  for (const f of [top, sub]) await local.putLocalFolder(f);
  session.knowFolders([top, sub]);
  const fromTop = await local.saveSaved({ name: 'Old.docx', bytes: bytes(1), folderId: top.id });
  const fromSub = await local.saveSaved({ name: 'Older.docx', bytes: bytes(2), folderId: sub.id });
  const elsewhere = await local.saveSaved({ name: 'Elsewhere.docx', bytes: bytes(3) });
  for (const d of [fromTop, fromSub, elsewhere]) await local.trashSaved(d.id);
  await convert.encryptFolder(top, [top, sub], [], guest);
  const found = await convert.readableTrashIn(top, [top, sub], guest);
  assert.deepEqual(found.cloud, []);
  assert.deepEqual(new Set(found.local), new Set([fromTop.id, fromSub.id]), 'what was in its tree, not what was elsewhere');
  await convert.purgeReadableTrash(found);
  const left = (await local.listTrashedSaved()).map((r) => r.info.id);
  assert.deepEqual(left, [elsewhere.id]);
});
