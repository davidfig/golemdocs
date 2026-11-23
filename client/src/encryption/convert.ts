// Encrypting and decrypting what a person already has (docs/encrypted-folders.md): a document's file, name and every version it keeps, in
// the account and in this browser; a folder's subfolders and documents.
//
// A document is converted in the account first, so this browser's copy never becomes something the account's is not: the save that converts
// it there keeps no version of what it replaces, then each version is replaced in place. A conversion cut short leaves versions in the
// old form; `finishVersions` completes them the next time the document is opened with its key.

import { isSealed } from '@golemdocs/ops';
import { convertCloudDocument, downloadCloudVersion, listCloudVersions, listDocuments, listFolders, listTrash, purgeTrash, putFolders, replaceCloudVersion, throwIfFailed, type CloudDocument } from '../cloud.ts';
import type { Folder } from '../folders.ts';
import { openFromCloud } from '../library.ts';
import { convertLocalVersions, deleteSearchIndexes, getSaved, listLocalFolders, listSaved, listTrashedSaved, purgeTrashedSaved, saveFromCloud, saveSaved, updateLocalFolder, type SavedInfo } from '../storage/local.ts';
import type { LibraryEntry } from '../sync.ts';
import { addFoldersToCatalogue, putDocInCatalogue } from '../sync.ts';
import { opensFromCloud } from '../ui/dashboardFormat.ts';
import { isEncryptedFolder, isUnlocked, knowDocuments, knowFolders, knowKey, newKey, noteFolder, openSealedFile, openSealedName, sealFileWith, sealNameWith } from './session.ts';

/** What a conversion needs from the app. */
export interface ConvertHost {
  /** Who is signed in (with sync: the account's documents and folders), or undefined for a guest. */
  owner: string | undefined;
  /** Whether folders are the account's (signed in with sync) rather than this browser's. */
  cloud: boolean;
}

/** The document as it is now, readable: this browser's copy if it is the newer, else the account's. */
async function current(entry: LibraryEntry, host: ConvertHost): Promise<{ info: SavedInfo; bytes: Uint8Array; base?: number }> {
  if (entry.cloud && opensFromCloud(entry)) {
    const found = await openFromCloud(entry.cloud, host.owner);
    return { info: found.info, bytes: new Uint8Array(found.bytes), base: entry.cloud.updatedAt };
  }
  const saved = entry.local ? await getSaved(entry.local.id) : null;
  if (!saved) throw new Error('the document is not here');
  return { info: saved.info, bytes: new Uint8Array(saved.bytes), ...(saved.info.cloudUpdatedAt !== undefined ? { base: saved.info.cloudUpdatedAt } : {}) };
}

const cloudIdOf = (entry: LibraryEntry, info: SavedInfo): string | undefined => entry.cloud?.id ?? info.cloudId;

/** Encrypts a document: its file, name and every version, in the account and here. Returns its new key (null if it was encrypted already). */
export async function encryptDocument(entry: LibraryEntry, host: ConvertHost): Promise<string | null> {
  if (entry.encrypted || entry.local?.encrypted || entry.cloud?.encrypted) return null;
  const { info, bytes, base } = await current(entry, host);
  const key = await newKey();
  const name = info.name;
  const cloudId = cloudIdOf(entry, info);
  let cloudUpdatedAt: number | undefined;
  if (cloudId) {
    const versions = await listCloudVersions(cloudId);
    const doc = await convertCloudDocument(cloudId, await sealFileWith(key, bytes), { encrypt: key, name: await sealNameWith(key, name) }, base);
    putDocInCatalogue(doc);
    cloudUpdatedAt = doc.updatedAt;
    for (const v of versions) {
      const old = new Uint8Array(await downloadCloudVersion(cloudId, v.version));
      await replaceCloudVersion(cloudId, v.version, await sealFileWith(key, old), v.name === null ? undefined : await sealNameWith(key, v.name));
    }
  }
  const input = { id: info.id, name, bytes, wrappedKey: key, noVersion: true as const };
  if (cloudId) await saveFromCloud({ ...input, cloudId, ...(cloudUpdatedAt !== undefined ? { cloudUpdatedAt } : {}) });
  else await saveSaved(input);
  await convertLocalVersions(info.id, async (old, versionName) => ({
    bytes: await sealFileWith(key, old),
    name: versionName === null ? null : await sealNameWith(key, versionName),
  }));
  // Its search index holds its text: the copy's went with the save above; one kept under the account's id goes too.
  await deleteSearchIndexes([...new Set([entry.key, ...(cloudId ? [cloudId] : [])])]);
  return key;
}

/**
 * Encrypts an account document known only from a listing, as `encryptDocument` does (with this browser's copy, if it has one): the vault
 * moving an ordinary document into an encrypted folder decrypted into it. Returns its new key.
 */
export async function encryptAccountDocument(cloud: CloudDocument, owner: string): Promise<string> {
  const local = (await listSaved()).find((d) => d.cloudId === cloud.id && (d.owner === undefined || d.owner === owner)) ?? null;
  // Read from the account (or this browser's copy, if it has changes the account hasn't yet), then converted in the account first.
  const entry: LibraryEntry = { key: local?.id ?? cloud.id, name: cloud.name, size: cloud.size, updatedAt: cloud.updatedAt, local, cloud, state: 'cloud-ahead', folderId: cloud.folderId ?? null };
  const key = await encryptDocument(entry, { owner, cloud: true });
  if (!key) throw new Error('it is encrypted already');
  return key;
}

/** Decrypts a document: its file, name and every version, in the account and here. The server can read it again. */
export async function decryptDocument(entry: LibraryEntry, host: ConvertHost): Promise<void> {
  if (!entry.local?.encrypted && !entry.cloud?.encrypted) return;
  const { info, bytes, base } = await current(entry, host);
  const name = info.name; // opened by getSaved / openFromCloud
  const cloudId = cloudIdOf(entry, info);
  let cloudUpdatedAt: number | undefined;
  if (cloudId) {
    const versions = await listCloudVersions(cloudId);
    const doc = await convertCloudDocument(cloudId, bytes, { decrypt: true, name }, base);
    putDocInCatalogue(doc);
    cloudUpdatedAt = doc.updatedAt;
    for (const v of versions) {
      const old = new Uint8Array(await downloadCloudVersion(cloudId, v.version));
      await replaceCloudVersion(cloudId, v.version, isSealed(old) ? await openSealedFile(old) : old, v.name === null ? undefined : await openSealedName(v.name));
    }
  }
  const input = { id: info.id, name, bytes, decrypt: true as const, noVersion: true as const };
  if (cloudId) await saveFromCloud({ ...input, cloudId, ...(cloudUpdatedAt !== undefined ? { cloudUpdatedAt } : {}) });
  else await saveSaved(input);
  await convertLocalVersions(info.id, async (old, versionName) => ({
    bytes: isSealed(old) ? await openSealedFile(old) : old,
    name: versionName === null ? null : await openSealedName(versionName),
  }));
}

/**
 * Finishes converting the account's versions of a document whose conversion was cut short: the ones not yet in its form now (sealed for an
 * encrypted document, readable for an ordinary one). Quietly does nothing it cannot do now (locked, offline).
 */
export async function finishVersions(cloudId: string, key: string | null): Promise<void> {
  const versions = await listCloudVersions(cloudId).catch(() => []);
  for (const v of versions) {
    if (!!v.sealed === !!key) continue;
    const old = new Uint8Array(await downloadCloudVersion(cloudId, v.version));
    const bytes = key ? await sealFileWith(key, old) : isSealed(old) ? await openSealedFile(old) : old;
    const name = v.name === null ? undefined : key ? await sealNameWith(key, v.name) : await openSealedName(v.name);
    await replaceCloudVersion(cloudId, v.version, bytes, name);
  }
}

/**
 * Conversions one at a time (docs/encrypted-folders.md): what the person asks for and finishing one cut short (`finishEncrypting`) would
 * otherwise convert the same document twice.
 */
let queue: Promise<unknown> = Promise.resolve();
let queued = 0;
export function exclusive<T>(work: () => Promise<T>): Promise<T> {
  queued++;
  const run = queue.then(work).finally(() => queued--);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Finishes encrypting folders whose encryption was cut short (a tab closed, the network lost): an encrypted folder is marked first, then
 * what is in it is converted one at a time, so anything left readable in one is encrypted now, and the folders inside it too. Only while
 * unlocked (the server refuses readable saves to what is left meanwhile). Answers whether it did anything. `folders` and `entries` are the
 * library as shown.
 */
export async function finishEncrypting(folders: readonly Folder[], entries: readonly LibraryEntry[], host: ConvertHost): Promise<boolean> {
  if (!isUnlocked() || queued > 0) return false;
  const readable = (e: LibraryEntry) => !e.encrypted && !e.locked && !e.local?.encrypted && !e.cloud?.encrypted;
  const unfinished = folders.filter(
    (top) => top.encrypted && !top.locked && !isEncryptedFolder(top.parentId) && (foldersUnder(folders, top.id).some((f) => !f.encrypted) || entriesIn(top, folders, entries).some(readable)),
  );
  if (!unfinished.length) return false;
  await exclusive(async () => {
    for (const top of unfinished) await encryptFolder(top, folders, entries, host);
  });
  return true;
}

/**
 * Learns, for certain, what the person has encrypted: the account's documents, folders and trash (signed in with sync), and this browser's
 * copies, folders and trash. Before a key is made or first used to encrypt with (`ensureKey`, ui.ts), so a second key is never made beside
 * the first because the library had not been listed. Throws when the account can't be reached.
 */
export async function learnEncrypted(host: ConvertHost): Promise<void> {
  const [saved, trashed] = await Promise.all([listSaved(), listTrashedSaved()]);
  for (const t of trashed) knowKey(t.info.wrappedKey);
  for (const s of saved) knowKey(s.wrappedKey);
  if (!host.cloud) {
    knowFolders(await listLocalFolders());
    return;
  }
  const [docs, folders, trash] = await Promise.all([listDocuments(), listFolders(), listTrash()]);
  knowDocuments(docs);
  knowFolders(folders);
  for (const t of trash) knowKey(t.wrappedKey);
}

/** Documents in the trash that are still readable: in the account's (`cloud`), and in this browser's (`local`), by id. */
export interface ReadableTrash {
  cloud: string[];
  local: string[];
}

/**
 * What was deleted from a folder (or a folder inside it) before it was encrypted, and is still readable in the trash until it is deleted
 * for good: encrypting the folder doesn't reach it, so the person is offered to delete it now (docs/encrypted-folders.md).
 */
export async function readableTrashIn(folder: Folder, folders: readonly Folder[], host: ConvertHost): Promise<ReadableTrash> {
  const tree = new Set([folder.id, ...foldersUnder(folders, folder.id).map((f) => f.id)]);
  const inTree = (id: string | null | undefined) => !!id && tree.has(id);
  const local = (await listTrashedSaved()).filter((r) => !r.info.encrypted && inTree(r.info.folderId)).map((r) => r.info.id);
  const cloud = host.cloud ? (await listTrash()).filter((d) => !d.encrypted && inTree(d.folderId)).map((d) => d.id) : [];
  return { cloud, local };
}

/** Deletes those documents for good, in the account and here. */
export async function purgeReadableTrash(trash: ReadableTrash): Promise<void> {
  for (const id of trash.cloud) await purgeTrash(id);
  for (const id of trash.local) await purgeTrashedSaved(id);
}

/** The folders under `root` (not itself), parents before children. */
function foldersUnder(folders: readonly Folder[], root: string): Folder[] {
  const out: Folder[] = [];
  const walk = (parent: string) => {
    for (const f of folders) {
      if (f.parentId !== parent) continue;
      out.push(f);
      walk(f.id);
    }
  };
  walk(root);
  return out;
}

/** The documents in a folder and every folder inside it. */
export function entriesIn(folder: Folder, folders: readonly Folder[], entries: readonly LibraryEntry[]): LibraryEntry[] {
  const tree = new Set([folder.id, ...foldersUnder(folders, folder.id).map((f) => f.id)]);
  return entries.filter((e) => e.folderId !== null && tree.has(e.folderId));
}

/** Marks a folder encrypted (with its key, its name sealed inside an encrypted folder) or not, in the account or here. */
async function setFolder(folder: Folder, change: { encrypted: true; wrappedKey: string; name: string } | { encrypted: false; name: string }, host: ConvertHost): Promise<void> {
  noteFolder({ id: folder.id, parentId: folder.parentId, ...(change.encrypted ? { encrypted: true, wrappedKey: change.wrappedKey } : {}) });
  if (host.cloud) {
    const result = await putFolders([{ id: folder.id, name: change.name, encrypted: change.encrypted, ...(change.encrypted ? { wrappedKey: change.wrappedKey } : {}) }]);
    throwIfFailed(result);
    addFoldersToCatalogue(result.ok);
    return;
  }
  const inside = isEncryptedFolder(folder.parentId);
  const name = change.encrypted && inside ? await sealNameWith(change.wrappedKey, change.name) : change.name;
  await updateLocalFolder(folder.id, { ...change, name }, Date.now());
}

/** What a folder conversion reports as it goes: how many of its documents are done. */
export type Progress = (done: number, total: number) => void;

/**
 * Encrypts a folder: it is marked encrypted first (so whatever is added meanwhile is encrypted on the way in), then every folder inside it,
 * parents first, with sealed names, then every document in it. `folders` and `entries` are the library as shown (names opened).
 */
export async function encryptFolder(folder: Folder, folders: readonly Folder[], entries: readonly LibraryEntry[], host: ConvertHost, progress?: Progress): Promise<void> {
  if (!folder.encrypted) await setFolder(folder, { encrypted: true, wrappedKey: await newKey(), name: folder.name }, host);
  const inside = foldersUnder(folders, folder.id);
  for (const sub of inside) if (!sub.encrypted) await setFolder(sub, { encrypted: true, wrappedKey: await newKey(), name: sub.name }, host);
  const tree = new Set([folder.id, ...inside.map((f) => f.id)]);
  const docs = entries.filter((e) => e.folderId !== null && tree.has(e.folderId) && !e.encrypted && !e.local?.encrypted && !e.cloud?.encrypted);
  for (let i = 0; i < docs.length; i++) {
    progress?.(i, docs.length);
    await encryptDocument(docs[i]!, host);
  }
  progress?.(docs.length, docs.length);
}

/**
 * Decrypts a folder: it and every folder inside it stop being encrypted, parents first (a folder inside an encrypted one can't be), then
 * every document in them is decrypted.
 */
export async function decryptFolder(folder: Folder, folders: readonly Folder[], entries: readonly LibraryEntry[], host: ConvertHost, progress?: Progress): Promise<void> {
  const inside = foldersUnder(folders, folder.id);
  for (const f of [folder, ...inside]) if (f.encrypted) await setFolder(f, { encrypted: false, name: f.name }, host);
  const tree = new Set([folder.id, ...inside.map((f) => f.id)]);
  const docs = entries.filter((e) => e.folderId !== null && tree.has(e.folderId) && (e.local?.encrypted || e.cloud?.encrypted));
  for (let i = 0; i < docs.length; i++) {
    progress?.(i, docs.length);
    await decryptDocument(docs[i]!, host);
  }
  progress?.(docs.length, docs.length);
}
