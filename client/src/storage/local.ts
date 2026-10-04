// Documents saved in this browser (IndexedDB). Signed out, these are the user's documents and
// nothing leaves the device. Signed in, the account is where documents live and these are its
// cache: each is marked with the account it belongs to and linked to its cloud copy (../library.ts).
import type { DocIndex } from '@golemdocs/docx';
import type { Folder } from '../folders.ts';
import { t } from '../i18n/index.ts';
import { CHUNK_ALGO, CHUNK_MIN_FILE, assemble, chunkBytes } from './chunker.ts';
import type { Chunked } from './chunker.ts';

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
const SEARCH = 'search';
// A document of CHUNK_MIN_FILE bytes or more is kept as chunks (see chunker.ts) rather than as one value in BYTES: its manifest
// (the chunks in order), the chunks by hash, and how many documents hold each (so a chunk goes when the last one lets go).
const MANIFESTS = 'manifests';
const CHUNKS = 'chunks';
const CHUNK_REFS = 'chunkRefs';

/** What is stored of a document kept as chunks. */
export interface StoredManifest {
  algo: string;
  size: number;
  /** The chunks in order (a hash may repeat), and the length of each. */
  hashes: string[];
  lengths: number[];
  /** The chunks the cloud copy is known to have, as of the last upload or download (see library.ts). */
  syncedHashes?: string[];
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 5);
      request.onupgradeneeded = (event) => {
        const from = event?.oldVersion ?? 0;
        if (from < 1) {
          request.result.createObjectStore(META, { keyPath: 'id' });
          request.result.createObjectStore(BYTES);
        }
        if (from < 2) request.result.createObjectStore(THUMBS);
        if (from < 3) request.result.createObjectStore(FOLDERS, { keyPath: 'id' });
        if (from < 4) request.result.createObjectStore(SEARCH);
        if (from < 5) {
          request.result.createObjectStore(MANIFESTS);
          request.result.createObjectStore(CHUNKS);
          request.result.createObjectStore(CHUNK_REFS);
        }
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
  const tx = db.transaction([META, BYTES, MANIFESTS, CHUNKS]);
  const [info, bytes, manifest] = await Promise.all([
    done(tx.objectStore(META).get(id) as IDBRequest<SavedInfo | undefined>),
    done(tx.objectStore(BYTES).get(id) as IDBRequest<ArrayBuffer | undefined>),
    done(tx.objectStore(MANIFESTS).get(id) as IDBRequest<StoredManifest | undefined>),
  ]);
  if (!info) return null;
  if (!manifest) return bytes ? { info, bytes } : null;
  // Kept as chunks: put back together (a missing chunk means the copy is damaged, which reads as no copy).
  const chunks = tx.objectStore(CHUNKS);
  const found = await Promise.all([...new Set(manifest.hashes)].map(async (h) => [h, await done(chunks.get(h) as IDBRequest<ArrayBuffer | undefined>)] as const));
  const byHash = new Map(found.flatMap(([h, bytes]) => (bytes ? [[h, new Uint8Array(bytes)] as const] : [])));
  const whole = assemble({ algo: CHUNK_ALGO, size: manifest.size, chunks: manifest.hashes.map((h, i) => ({ h, n: manifest.lengths[i]! })) }, (h) => byHash.get(h));
  return whole ? { info, bytes: whole.buffer as ArrayBuffer } : null;
}

/** A document kept as chunks: what it is made of, without the chunks (null for one kept whole, or no document). */
export async function getSavedManifest(id: string): Promise<{ info: SavedInfo; manifest: StoredManifest } | null> {
  const db = await openDb();
  const tx = db.transaction([META, MANIFESTS]);
  const [info, manifest] = await Promise.all([done(tx.objectStore(META).get(id) as IDBRequest<SavedInfo | undefined>), done(tx.objectStore(MANIFESTS).get(id) as IDBRequest<StoredManifest | undefined>)]);
  return info && manifest ? { info, manifest } : null;
}

/** Chunks by hash (those that are stored). */
export async function getChunks(hashes: readonly string[]): Promise<Map<string, Uint8Array>> {
  const db = await openDb();
  const store = db.transaction(CHUNKS).objectStore(CHUNKS);
  const found = await Promise.all([...new Set(hashes)].map(async (h) => [h, await done(store.get(h) as IDBRequest<ArrayBuffer | undefined>)] as const));
  return new Map(found.flatMap(([h, bytes]) => (bytes ? [[h, new Uint8Array(bytes)] as const] : [])));
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

/** A copy of bytes that owns its buffer exactly (a view of a bigger buffer would take all of it into the database). */
const own = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

async function write(input: WriteInput, cloud?: { id: string; updatedAt?: number }): Promise<SavedInfo> {
  const db = await openDb();
  const view = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
  const id = input.id ?? crypto.randomUUID();
  // Chunking is done before the transaction (it is not database work, and a transaction ends when it waits for anything else).
  let plan: Chunked | null = null;
  if (view.length >= CHUNK_MIN_FILE) {
    const before = input.id ? await readManifest(db, input.id) : undefined;
    plan = await chunkBytes(view, new Set(before?.hashes));
  }
  for (;;) {
    const info = await commit(db, id, input, view, plan, cloud);
    if (info) return info;
    // What was stored changed while this was being made ready (another tab saved it): everything is sent again, nothing assumed.
    plan = await chunkBytes(view, new Set());
  }
}

async function readManifest(db: IDBDatabase, id: string): Promise<StoredManifest | undefined> {
  return (await done(db.transaction(MANIFESTS).objectStore(MANIFESTS).get(id))) as StoredManifest | undefined;
}

/** Lets go of the chunks a stored manifest holds (those nobody else holds are deleted), and forgets the manifest. */
async function release(tx: IDBTransaction, id: string, manifest?: StoredManifest): Promise<void> {
  const manifests = tx.objectStore(MANIFESTS);
  const stored = manifest ?? ((await done(manifests.get(id))) as StoredManifest | undefined);
  if (!stored) return;
  await letGo(tx, new Set(stored.hashes));
  manifests.delete(id);
}

/** One document's hold on each of these chunks ends. */
async function letGo(tx: IDBTransaction, hashes: Iterable<string>): Promise<void> {
  const refs = tx.objectStore(CHUNK_REFS);
  const chunks = tx.objectStore(CHUNKS);
  const list = [...hashes];
  const counts = await Promise.all(list.map(async (h) => ((await done(refs.get(h))) as number | undefined) ?? 1));
  list.forEach((h, i) => {
    if (counts[i]! <= 1) {
      refs.delete(h);
      chunks.delete(h);
    } else refs.put(counts[i]! - 1, h);
  });
}

/** Writes a document in one transaction: null (having written nothing) if a chunk the plan counted on is not there. */
async function commit(db: IDBDatabase, id: string, input: WriteInput, view: Uint8Array, plan: Chunked | null, cloud?: { id: string; updatedAt?: number }): Promise<SavedInfo | null> {
  const tx = db.transaction([META, BYTES, MANIFESTS, CHUNKS, CHUNK_REFS], 'readwrite');
  const meta = tx.objectStore(META);
  const manifests = tx.objectStore(MANIFESTS);
  const existing = input.id ? ((await done(meta.get(input.id))) as SavedInfo | undefined) : undefined;
  const old = input.id ? ((await done(manifests.get(input.id))) as StoredManifest | undefined) : undefined;
  let write: (() => void) | null = null;
  if (plan) {
    const wanted = new Set(plan.manifest.chunks.map((c) => c.h));
    const had = new Set(old?.hashes);
    const fresh = new Map(plan.fresh.map((f) => [f.hash, f.bytes]));
    const adds = [...wanted].filter((h) => !had.has(h));
    const drops = [...had].filter((h) => !wanted.has(h));
    const refs = tx.objectStore(CHUNK_REFS);
    const held = await Promise.all(adds.map(async (h) => ((await done(refs.get(h))) as number | undefined) ?? 0));
    // A chunk nobody holds and the plan did not bring: it was counted on from an earlier copy that has changed since.
    if (adds.some((h, i) => held[i] === 0 && !fresh.has(h))) {
      await finished(tx);
      return null;
    }
    // What was stored of the cloud copy still is; a copy that has just come from the cloud is the cloud copy.
    const synced = cloud ? [...wanted] : old?.syncedHashes;
    write = () => {
      adds.forEach((h, i) => {
        if (held[i] === 0) tx.objectStore(CHUNKS).put(own(fresh.get(h)!), h);
        refs.put(held[i]! + 1, h);
      });
      manifests.put(
        {
          algo: plan.manifest.algo,
          size: plan.manifest.size,
          hashes: plan.manifest.chunks.map((c) => c.h),
          lengths: plan.manifest.chunks.map((c) => c.n),
          ...(synced && { syncedHashes: synced }),
        } satisfies StoredManifest,
        id,
      );
      tx.objectStore(BYTES).delete(id);
    };
    if (drops.length) await letGo(tx, drops);
  } else if (old) await release(tx, id, old);
  const info: SavedInfo = {
    ...existing,
    id,
    ...(input.owner !== undefined && { owner: input.owner }),
    ...(input.folderId !== undefined && { folderId: input.folderId }),
    name: input.name,
    size: view.length,
    // Strictly increasing per document, so "saved after the last sync" is always decidable.
    updatedAt: Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1),
  };
  if (cloud) {
    info.cloudId = cloud.id;
    info.cloudSyncedAt = info.updatedAt;
    if (cloud.updatedAt !== undefined) info.cloudUpdatedAt = cloud.updatedAt;
  }
  meta.put(info);
  if (write) write();
  else tx.objectStore(BYTES).put(own(view), id);
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
export async function markSynced(id: string, sync: { cloudId: string; syncedAt: number; cloudUpdatedAt?: number; name?: string; syncedHashes?: readonly string[] }): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, MANIFESTS], 'readwrite');
  const info = (await done(tx.objectStore(META).get(id))) as SavedInfo | undefined;
  if (info) {
    // The chunks the cloud copy now has, for the next upload to leave out.
    const manifest = sync.syncedHashes ? ((await done(tx.objectStore(MANIFESTS).get(id))) as StoredManifest | undefined) : undefined;
    if (manifest) tx.objectStore(MANIFESTS).put({ ...manifest, syncedHashes: [...sync.syncedHashes!] }, id);
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
  const tx = db.transaction([META, BYTES, THUMBS, SEARCH, MANIFESTS, CHUNKS, CHUNK_REFS], 'readwrite');
  await release(tx, id);
  tx.objectStore(META).delete(id);
  tx.objectStore(BYTES).delete(id);
  tx.objectStore(THUMBS).delete(id);
  tx.objectStore(SEARCH).delete(id);
  await finished(tx);
}

/**
 * Deletes a saved copy only if it is still as `seen` (nothing saved to it since) and holds nothing
 * the account is missing; returns whether it did. For copies found to be deleted from the account
 * elsewhere: an edit saved here while the account was being asked keeps it, to be uploaded again.
 */
export async function deleteSavedIfUnchanged(seen: SavedInfo): Promise<boolean> {
  const db = await openDb();
  const tx = db.transaction([META, BYTES, THUMBS, SEARCH, MANIFESTS, CHUNKS, CHUNK_REFS], 'readwrite');
  const now = (await done(tx.objectStore(META).get(seen.id))) as SavedInfo | undefined;
  const unchanged = now !== undefined && now.updatedAt === seen.updatedAt && now.updatedAt <= (now.cloudSyncedAt ?? 0);
  if (unchanged) {
    await release(tx, seen.id);
    tx.objectStore(META).delete(seen.id);
    tx.objectStore(BYTES).delete(seen.id);
    tx.objectStore(THUMBS).delete(seen.id);
    tx.objectStore(SEARCH).delete(seen.id);
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

/** A document's search index, and which version of the document it was made from. */
export interface StoredIndex {
  /** The version of the document it describes (see ../search/searchLibrary.ts). */
  stamp: string;
  index: DocIndex;
}

/** The search index kept for a document (null if none): `key` is the library entry's. */
export async function getSearchIndex(key: string): Promise<StoredIndex | null> {
  const db = await openDb();
  return ((await done(db.transaction(SEARCH).objectStore(SEARCH).get(key))) as StoredIndex | undefined) ?? null;
}

/** Every kept index with its stamp, to see which documents need indexing again. */
export async function listSearchIndexes(): Promise<Map<string, StoredIndex>> {
  const db = await openDb();
  const store = db.transaction(SEARCH).objectStore(SEARCH);
  const [keys, values] = await Promise.all([done(store.getAllKeys() as IDBRequest<IDBValidKey[]>), done(store.getAll() as IDBRequest<StoredIndex[]>)]);
  return new Map(keys.map((k, i) => [String(k), values[i]!]));
}

export async function putSearchIndex(key: string, stored: StoredIndex): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(SEARCH, 'readwrite');
  tx.objectStore(SEARCH).put(stored, key);
  await finished(tx);
}

/** Forgets the indexes of documents that are gone. */
export async function deleteSearchIndexes(keys: readonly string[]): Promise<void> {
  if (!keys.length) return;
  const db = await openDb();
  const tx = db.transaction(SEARCH, 'readwrite');
  for (const key of keys) tx.objectStore(SEARCH).delete(key);
  await finished(tx);
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
