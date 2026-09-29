// Documents saved in this browser (IndexedDB). Signed out, these are the user's documents and
// nothing leaves the device. Signed in, the account is where documents live and these are its
// cache: each is marked with the account it belongs to and linked to its cloud copy (../library.ts).
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

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 2);
      request.onupgradeneeded = (event) => {
        const from = event?.oldVersion ?? 0;
        if (from < 1) {
          request.result.createObjectStore(META, { keyPath: 'id' });
          request.result.createObjectStore(BYTES);
        }
        if (from < 2) request.result.createObjectStore(THUMBS);
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
  for (const info of guests) store.put({ ...info, owner });
  await finished(tx);
  return guests.map((d) => d.id);
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
