// Documents saved in this browser (IndexedDB). Signed out, these are the user's documents and
// nothing leaves the device. Signed in, the account is where documents live and these are its
// cache: each is marked with the account it belongs to and linked to its cloud copy (../library.ts).
import type { Folder } from '../folders.ts';
import { t } from '../i18n/index.ts';

export interface SavedInfo {
  id: string;
  name: string;
  size: number;
  updatedAt: number;
  /** The account (user id) this is a copy for; absent for a document made while signed out. */
  owner?: string;
  /** The cloud document this is a copy of, once it has been saved to (or opened from) the cloud. */
  cloudId?: string;
  /** `updatedAt` as of the last time this copy and the cloud copy were identical. */
  cloudSyncedAt?: number;
  /** The cloud copy's `updatedAt` as of that sync (the server's clock), to tell whether it has changed since. */
  cloudUpdatedAt?: number;
  /** The folder it is in (see ../folders.ts); absent at the top level. */
  folderId?: string;
  /** The account it was a copy for, until that account lost sync (see `releaseToGuest`); its cloud link is that account's. */
  releasedFrom?: string;
}

/** A first-page thumbnail, and which save of the document it shows. */
export interface Thumbnail {
  blob: Blob;
  /** The `updatedAt` of the saved copy it was rendered from. */
  forUpdatedAt: number;
}

const DB_NAME = 'word';
const META = 'meta';
const BYTES = 'bytes';
const THUMBS = 'thumbs';
const FOLDERS = 'folders';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 3);
      request.onupgradeneeded = (event) => {
        const from = event?.oldVersion ?? 0;
        if (from < 1) {
          request.result.createObjectStore(META, { keyPath: 'id' });
          request.result.createObjectStore(BYTES);
        }
        if (from < 2) request.result.createObjectStore(THUMBS);
        if (from < 3) request.result.createObjectStore(FOLDERS, { keyPath: 'id' });
      };
      request.onsuccess = () => {
        // Let another tab delete (or upgrade) the database instead of blocking it.
        request.result.onversionchange = () => {
          request.result.close();
          dbPromise = null;
        };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error(t('app.storageOpenFailed')));
    }).catch((error) => {
      dbPromise = null; // storage can be blocked (private windows, policies); try again next time
      throw error;
    });
  }
  return dbPromise;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error(t('app.storageAborted')));
  });
}

/** Saved documents, most recently saved first. */
export async function listSaved(): Promise<SavedInfo[]> {
  const db = await openDb();
  const all = await done(db.transaction(META).objectStore(META).getAll() as IDBRequest<SavedInfo[]>);
  return all.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function getSaved(id: string): Promise<{ info: SavedInfo; bytes: ArrayBuffer } | null> {
  const db = await openDb();
  const tx = db.transaction([META, BYTES]);
  const [info, bytes] = await Promise.all([
    done(tx.objectStore(META).get(id) as IDBRequest<SavedInfo | undefined>),
    done(tx.objectStore(BYTES).get(id) as IDBRequest<ArrayBuffer | undefined>),
  ]);
  return info && bytes ? { info, bytes } : null;
}

interface WriteInput {
  id?: string;
  name: string;
  bytes: Uint8Array | ArrayBuffer;
  /** The account it belongs to; kept from the saved copy when absent. */
  owner?: string;
  /** The folder it goes in; kept from the saved copy when absent. */
  folderId?: string;
}

async function write(input: WriteInput, cloud?: { id: string; updatedAt?: number }): Promise<SavedInfo> {
  const db = await openDb();
  const tx = db.transaction([META, BYTES], 'readwrite');
  const meta = tx.objectStore(META);
  const existing = input.id ? ((await done(meta.get(input.id))) as SavedInfo | undefined) : undefined;
  const buffer = input.bytes instanceof Uint8Array ? input.bytes.slice().buffer : input.bytes.slice(0);
  const info: SavedInfo = {
    ...existing,
    id: input.id ?? crypto.randomUUID(),
    ...(input.owner !== undefined && { owner: input.owner }),
    ...(input.folderId !== undefined && { folderId: input.folderId }),
    name: input.name,
    size: buffer.byteLength,
    // Strictly increasing per document, so "saved after the last sync" is always decidable.
    updatedAt: Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1),
  };
  if (cloud) {
    info.cloudId = cloud.id;
    info.cloudSyncedAt = info.updatedAt;
    if (cloud.updatedAt !== undefined) info.cloudUpdatedAt = cloud.updatedAt;
  }
  meta.put(info);
  tx.objectStore(BYTES).put(buffer, info.id);
  await finished(tx);
  return info;
}

/** Saves (creating or replacing) a document in this browser. Keeps any cloud link, now out of sync. */
export function saveSaved(input: WriteInput): Promise<SavedInfo> {
  return write(input);
}

/** Saves bytes that came from the cloud, and marks this copy as identical to it. */
export function saveFromCloud(input: WriteInput & { cloudId: string; cloudUpdatedAt?: number }): Promise<SavedInfo> {
  return write(input, { id: input.cloudId, updatedAt: input.cloudUpdatedAt });
}

/**
 * Records that the saved copy as of `syncedAt` (its `updatedAt` when it was read for upload) is
 * what's in the cloud. Saves made while it was uploading stay out of sync. A `name` renames it.
 */
export async function markSynced(id: string, sync: { cloudId: string; syncedAt: number; cloudUpdatedAt?: number; name?: string }): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(META, 'readwrite');
  const info = (await done(tx.objectStore(META).get(id))) as SavedInfo | undefined;
  if (info) {
    tx.objectStore(META).put({
      ...info,
      ...(sync.name !== undefined && { name: sync.name }),
      cloudId: sync.cloudId,
      cloudSyncedAt: sync.syncedAt,
      ...(sync.cloudUpdatedAt !== undefined && { cloudUpdatedAt: sync.cloudUpdatedAt }),
    });
  }
  await finished(tx);
}

/** Puts a saved document in a folder (null: the top level). Not an edit: its dates stay as they were. */
export async function setSavedFolder(id: string, folderId: string | null): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(META, 'readwrite');
  const info = (await done(tx.objectStore(META).get(id))) as SavedInfo | undefined;
  if (info) {
    const { folderId: _was, ...rest } = info;
    tx.objectStore(META).put(folderId === null ? rest : { ...rest, folderId });
  }
  await finished(tx);
}

/** The folders kept in this browser: those of someone not signed in (an account's are in the cloud). */
export async function listLocalFolders(): Promise<Folder[]> {
  const db = await openDb();
  return done(db.transaction(FOLDERS).objectStore(FOLDERS).getAll() as IDBRequest<Folder[]>);
}

/** Creates or replaces a folder kept in this browser. */
export async function putLocalFolder(folder: Folder): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(FOLDERS, 'readwrite');
  tx.objectStore(FOLDERS).put(folder);
  await finished(tx);
}

/**
 * Renames and/or moves a folder kept in this browser, keeping what is stored for whatever `change`
 * leaves out (a list shown elsewhere may be behind it). Returns the folder as saved, or null if it is gone.
 */
export async function updateLocalFolder(id: string, change: { name?: string; parentId?: string | null }, updatedAt: number): Promise<Folder | null> {
  const db = await openDb();
  const tx = db.transaction(FOLDERS, 'readwrite');
  const store = tx.objectStore(FOLDERS);
  const stored = (await done(store.get(id))) as Folder | undefined;
  if (!stored) return null;
  const next: Folder = { ...stored, name: change.name ?? stored.name, parentId: change.parentId === undefined ? stored.parentId : change.parentId, updatedAt };
  store.put(next);
  await finished(tx);
  return next;
}

/** Forgets a folder record only, leaving the documents and folders that refer to it as they are. */
export async function removeLocalFolderRecord(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(FOLDERS, 'readwrite');
  tx.objectStore(FOLDERS).delete(id);
  await finished(tx);
}

/**
 * Removes a folder kept in this browser, if it is one; what was in it (folders and saved
 * documents) moves to `parentId`, the folder's own parent, so nothing is lost.
 */
export async function deleteLocalFolder(id: string, parentId: string | null): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([FOLDERS, META], 'readwrite');
  const folders = tx.objectStore(FOLDERS);
  for (const f of (await done(folders.getAll())) as Folder[]) if (f.parentId === id) folders.put({ ...f, parentId });
  const meta = tx.objectStore(META);
  for (const info of (await done(meta.getAll())) as SavedInfo[]) {
    if (info.folderId !== id) continue;
    const { folderId: _was, ...rest } = info;
    meta.put(parentId === null ? rest : { ...rest, folderId: parentId });
  }
  folders.delete(id);
  await finished(tx);
}

/** The documents that belong in view: an account's, or (for null) those made while signed out. */
export function ownedBy(docs: readonly SavedInfo[], owner: string | null): SavedInfo[] {
  return docs.filter((d) => (d.owner ?? null) === owner);
}

/** Gives every document made while signed out to `owner` (they have just signed in). Returns their ids. */
export async function adoptGuestDocuments(owner: string): Promise<string[]> {
  const db = await openDb();
  const tx = db.transaction(META, 'readwrite');
  const store = tx.objectStore(META);
  const guests = ((await done(store.getAll())) as SavedInfo[]).filter((d) => d.owner === undefined);
  for (const { releasedFrom, ...info } of guests) {
    // A copy of another account's document is a new document for this one: linked to that one, it
    // would be taken for deleted (it isn't in this account's list) or saved over someone else's.
    if (releasedFrom !== undefined && releasedFrom !== owner) {
      const { cloudId: _id, cloudSyncedAt: _synced, cloudUpdatedAt: _updated, folderId: _folder, ...own } = info;
      store.put({ ...own, owner });
    } else store.put({ ...info, owner });
  }
  await finished(tx);
  return guests.map((d) => d.id);
}

/**
 * Makes an account's copies in this browser its own again, like a guest's (it has no sync any more),
 * so they stay in view. Their cloud copies are untouched; subscribing again moves them back.
 */
export async function releaseToGuest(owner: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(META, 'readwrite');
  const store = tx.objectStore(META);
  for (const info of ownedBy((await done(store.getAll())) as SavedInfo[], owner)) {
    const { owner: _gone, ...rest } = info;
    store.put({ ...rest, ...(rest.cloudId !== undefined && { releasedFrom: owner }) });
  }
  await finished(tx);
}

/** Deletes an account's copies from this browser (it signed out). Its cloud documents are untouched. */
export async function deleteOwnedBy(owner: string): Promise<void> {
  for (const info of ownedBy(await listSaved(), owner)) await deleteSaved(info.id);
}

export async function deleteSaved(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, BYTES, THUMBS], 'readwrite');
  tx.objectStore(META).delete(id);
  tx.objectStore(BYTES).delete(id);
  tx.objectStore(THUMBS).delete(id);
  await finished(tx);
}

/**
 * Deletes a saved copy only if it is still as `seen` (nothing saved to it since) and holds nothing
 * the account is missing; returns whether it did. For copies found to be deleted from the account
 * elsewhere: an edit saved here while the account was being asked keeps it, to be uploaded again.
 */
export async function deleteSavedIfUnchanged(seen: SavedInfo): Promise<boolean> {
  const db = await openDb();
  const tx = db.transaction([META, BYTES, THUMBS], 'readwrite');
  const now = (await done(tx.objectStore(META).get(seen.id))) as SavedInfo | undefined;
  const unchanged = now !== undefined && now.updatedAt === seen.updatedAt && now.updatedAt <= (now.cloudSyncedAt ?? 0);
  if (unchanged) {
    tx.objectStore(META).delete(seen.id);
    tx.objectStore(BYTES).delete(seen.id);
    tx.objectStore(THUMBS).delete(seen.id);
  }
  await finished(tx);
  return unchanged;
}

/** Keeps the thumbnail for a saved document (replacing any older one). */
export async function saveThumbnail(id: string, blob: Blob, forUpdatedAt: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, THUMBS], 'readwrite');
  // A document deleted while its thumbnail was being made must not leave an orphan behind.
  if ((await done(tx.objectStore(META).get(id))) !== undefined) tx.objectStore(THUMBS).put({ blob, forUpdatedAt } satisfies Thumbnail, id);
  await finished(tx);
}

export async function getThumbnail(id: string): Promise<Thumbnail | null> {
  const db = await openDb();
  return ((await done(db.transaction(THUMBS).objectStore(THUMBS).get(id))) as Thumbnail | undefined) ?? null;
}

/** Deletes every saved document and thumbnail in this browser. Cloud copies are untouched. */
export async function clearAllSaved(): Promise<void> {
  const open = dbPromise;
  dbPromise = null;
  (await open?.catch(() => null))?.close();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(t('app.storageClearFailed')));
  });
}
