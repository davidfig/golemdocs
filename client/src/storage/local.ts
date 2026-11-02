// Documents saved in this browser (IndexedDB). Signed out, these are the user's documents and
// nothing leaves the device. Signed in, the account is where documents live and these are its
// cache: each is marked with the account it belongs to and linked to its cloud copy (../library.ts).
import type { DocIndex } from '@golemdocs/docx';
import { LOCAL_LIMITS, TRASH_MS, byteBudget, shouldCheckpoint, versionsToDrop, type VersionStamp } from '@golemdocs/ops';
import type { Folder } from '../folders.ts';
import { t } from '../i18n/index.ts';
import { traced } from '../quietRunner.ts';
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
// A document's history in this browser (see "History" below): its checkpoints' details by document id, and what each one holds by `<id>/<version>`.
const HISTORY = 'history';
const HISTORY_DATA = 'historyData';
// Documents deleted from this browser, kept for 30 days (see "Trash" below): their catalogue records by document id. Everything else about them (bytes, chunks, history, thumbnail) stays where it was.
const TRASH = 'trash';
// The last version a document and its cloud copy agreed on (see "Synced base" below), by document id: what a merge starts from.
const BASES = 'bases';

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
      const request = indexedDB.open(DB_NAME, 8);
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
        if (from < 6) {
          request.result.createObjectStore(HISTORY);
          request.result.createObjectStore(HISTORY_DATA);
        }
        if (from < 7) request.result.createObjectStore(TRASH);
        if (from < 8) request.result.createObjectStore(BASES);
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
    plan = await traced('chunkBytes', () => chunkBytes(view, new Set(before?.hashes)));
  }
  // Does this save replace a version worth keeping? Decided before, while it can still be read (see "History").
  const previous = input.id ? await versionDue(db, input.id, view.length) : null;
  for (;;) {
    const info = await commit(db, id, input, view, plan, cloud, previous);
    if (info) {
      if (previous?.whole) await keepWhole(db, id, previous.info, previous.whole);
      return info;
    }
    // What was stored changed while this was being made ready (another tab saved it): everything is sent again, nothing assumed.
    plan = await traced('chunkBytes', () => chunkBytes(view, new Set()));
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
async function commit(db: IDBDatabase, id: string, input: WriteInput, view: Uint8Array, plan: Chunked | null, cloud?: { id: string; updatedAt?: number }, previous?: DueVersion | null): Promise<SavedInfo | null> {
  const tx = db.transaction([META, BYTES, MANIFESTS, CHUNKS, CHUNK_REFS, HISTORY, HISTORY_DATA, BASES], 'readwrite');
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
    // A checkpoint of the chunked version being replaced holds its chunks before the save lets go of the ones it drops.
    if (previous && old && existing?.updatedAt === previous.info.updatedAt) await holdChunked(tx, id, previous.info, old);
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
  } else if (old) {
    if (previous && existing?.updatedAt === previous.info.updatedAt) await holdChunked(tx, id, previous.info, old);
    await release(tx, id, old);
  }
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
  // A copy that has just come from the cloud is the cloud copy: what a later merge starts from.
  if (cloud) keepBase(tx, id, plan ? null : view, cloud.updatedAt);
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
export async function markSynced(id: string, sync: { cloudId: string; syncedAt: number; cloudUpdatedAt?: number; name?: string; syncedHashes?: readonly string[]; base?: Uint8Array }): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, MANIFESTS, BASES], 'readwrite');
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
    // The bytes the cloud copy now has (`base`: what was uploaded) are the next merge's starting point; without them the old one is out of date.
    if (sync.cloudUpdatedAt !== undefined) keepBase(tx, id, sync.base ?? null, sync.cloudUpdatedAt);
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

/** Gives a saved copy a new name, leaving its contents (and when they were saved) as they are. */
export async function setSavedName(id: string, name: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(META, 'readwrite');
  const info = (await done(tx.objectStore(META).get(id))) as SavedInfo | undefined;
  if (info) tx.objectStore(META).put({ ...info, name });
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
  // What the account deleted from this browser goes too: it is not the next person's to restore.
  for (const { info } of await trashedRecords()) if (info.owner === owner) await deleteSaved(info.id);
}

export async function deleteSaved(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, BYTES, THUMBS, SEARCH, MANIFESTS, CHUNKS, CHUNK_REFS, HISTORY, HISTORY_DATA, TRASH, BASES], 'readwrite');
  tx.objectStore(TRASH).delete(id);
  tx.objectStore(BASES).delete(id);
  await forgetHistory(tx, id);
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
  const tx = db.transaction([META, BYTES, THUMBS, SEARCH, MANIFESTS, CHUNKS, CHUNK_REFS, HISTORY, HISTORY_DATA, BASES], 'readwrite');
  const now = (await done(tx.objectStore(META).get(seen.id))) as SavedInfo | undefined;
  const unchanged = now !== undefined && now.updatedAt === seen.updatedAt && now.updatedAt <= (now.cloudSyncedAt ?? 0);
  if (unchanged) {
    await forgetHistory(tx, seen.id);
    await release(tx, seen.id);
    tx.objectStore(META).delete(seen.id);
    tx.objectStore(BYTES).delete(seen.id);
    tx.objectStore(THUMBS).delete(seen.id);
    tx.objectStore(SEARCH).delete(seen.id);
    tx.objectStore(BASES).delete(seen.id);
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

// --- History ---------------------------------------------------------------------------------------------------------------
// A document's earlier versions, kept in this browser whether or not it is signed in (the cloud keeps its own, for paying accounts:
// server/src/versions.ts). A save keeps the version it replaces when the shared rules say one is due (`shouldCheckpoint` in
// @golemdocs/ops), and the same rules thin them. A version of a document kept as chunks holds its chunks by reference (CHUNK_REFS),
// so it costs only what changed; a small one is a copy of its bytes. History never makes a save fail: a copy that cannot be stored
// (the browser's quota) is skipped, and a chunked version's hold is just a few counters.

/** One kept version (what the dialog lists). */
export interface LocalVersion {
  /** The `updatedAt` of the document as it was; also its identity. */
  version: number;
  size: number;
  /** Set when the person saved it on purpose; those are kept longer. */
  name: string | null;
  /** Kept as a hold on the document's chunks rather than a copy. */
  chunked: boolean;
}

/** What a chunked version's data is: the manifest without the chunks. */
interface HeldManifest {
  hashes: string[];
  lengths: number[];
}

/** A version a save is about to replace and should keep; `whole` is its bytes when it is not chunked. */
interface DueVersion {
  info: SavedInfo;
  whole?: ArrayBuffer;
}

const dataKey = (id: string, version: number): string => `${id}/${version}`;
const stampOf = (v: LocalVersion): VersionStamp => ({ at: v.version, size: v.chunked ? Math.ceil(v.size / 10) : v.size, ...(v.name !== null ? { named: true } : {}) });

/** The saved copy as it is now, if replacing it with `nextSize` bytes should keep it as a version. */
async function versionDue(db: IDBDatabase, id: string, nextSize: number): Promise<DueVersion | null> {
  try {
    const tx = db.transaction([META, HISTORY, MANIFESTS, BYTES]);
    const [info, list, manifest] = await Promise.all([
      done(tx.objectStore(META).get(id)) as Promise<SavedInfo | undefined>,
      done(tx.objectStore(HISTORY).get(id)) as Promise<LocalVersion[] | undefined>,
      done(tx.objectStore(MANIFESTS).get(id)) as Promise<StoredManifest | undefined>,
    ]);
    if (!info) return null;
    const kept = list ?? [];
    if (kept.some((v) => v.version === info.updatedAt)) return null;
    const lastAt = kept.length ? Math.max(...kept.map((v) => v.version)) : null;
    if (!shouldCheckpoint({ lastAt, replacedAt: info.updatedAt, replacedSize: info.size, nextSize, now: Date.now() })) return null;
    if (manifest) return { info };
    const whole = (await done(tx.objectStore(BYTES).get(id))) as ArrayBuffer | undefined;
    return whole ? { info, whole } : null;
  } catch (error) {
    console.error('history: could not look at the saved copy', error);
    return null;
  }
}

/** Adds `entry` to the document's list and lets go of the versions the rules no longer keep. */
async function recordVersion(tx: IDBTransaction, id: string, entry: LocalVersion, liveSize: number, data: ArrayBuffer | HeldManifest): Promise<void> {
  const history = tx.objectStore(HISTORY);
  const list = (((await done(history.get(id))) as LocalVersion[] | undefined) ?? []).filter((v) => v.version !== entry.version);
  list.push(entry);
  list.sort((a, b) => b.version - a.version);
  tx.objectStore(HISTORY_DATA).put(data, dataKey(id, entry.version));
  const doomed = new Set(versionsToDrop(list.map(stampOf), Date.now(), { ...LOCAL_LIMITS, maxBytes: byteBudget(liveSize) }));
  const going = list.filter((v) => doomed.has(v.version));
  history.put(
    list.filter((v) => !doomed.has(v.version)),
    id,
  );
  for (const v of going) await dropData(tx, id, v);
}

/** Deletes what a version held: its copy, or its hold on the chunks. */
async function dropData(tx: IDBTransaction, id: string, v: LocalVersion): Promise<void> {
  const data = tx.objectStore(HISTORY_DATA);
  if (v.chunked) {
    const held = (await done(data.get(dataKey(id, v.version)))) as HeldManifest | undefined;
    if (held) await letGo(tx, new Set(held.hashes));
  }
  data.delete(dataKey(id, v.version));
}

/** Keeps the chunked version `old` (of the saved copy `info`) as a version: counts one more hold on each of its chunks. */
async function holdChunked(tx: IDBTransaction, id: string, info: SavedInfo, old: StoredManifest, name: string | null = null): Promise<void> {
  const refs = tx.objectStore(CHUNK_REFS);
  const distinct = [...new Set(old.hashes)];
  const counts = await Promise.all(distinct.map(async (h) => ((await done(refs.get(h))) as number | undefined) ?? 0));
  distinct.forEach((h, i) => refs.put(counts[i]! + 1, h));
  await recordVersion(tx, id, { version: info.updatedAt, size: info.size, name, chunked: true }, info.size, { hashes: old.hashes, lengths: old.lengths });
}

/** Keeps a small version as a copy of its bytes, after the save that replaced it went through (a failure costs the version, not the save). */
async function keepWhole(db: IDBDatabase, id: string, info: SavedInfo, bytes: ArrayBuffer, name: string | null = null): Promise<void> {
  try {
    const tx = db.transaction([META, HISTORY, HISTORY_DATA, CHUNK_REFS, CHUNKS], 'readwrite');
    const live = (await done(tx.objectStore(META).get(id))) as SavedInfo | undefined;
    if (!live) return; // deleted meanwhile
    await recordVersion(tx, id, { version: info.updatedAt, size: info.size, name, chunked: false }, live.size, bytes);
    await finished(tx);
  } catch (error) {
    console.error('history: could not keep a version', error);
  }
}

/** Forgets all of a document's history (the document is deleted). */
async function forgetHistory(tx: IDBTransaction, id: string): Promise<void> {
  const list = ((await done(tx.objectStore(HISTORY).get(id))) as LocalVersion[] | undefined) ?? [];
  for (const v of list) await dropData(tx, id, v);
  tx.objectStore(HISTORY).delete(id);
}

/** A document's kept versions, newest first. */
export async function listVersions(id: string): Promise<LocalVersion[]> {
  const db = await openDb();
  const list = (await done(db.transaction(HISTORY).objectStore(HISTORY).get(id))) as LocalVersion[] | undefined;
  return list ? [...list].sort((a, b) => b.version - a.version) : [];
}

/** The bytes of a kept version (null if it is gone, or a chunk of it is). */
export async function getVersion(id: string, version: number): Promise<ArrayBuffer | null> {
  const db = await openDb();
  const tx = db.transaction([HISTORY_DATA, CHUNKS, HISTORY]);
  const data = (await done(tx.objectStore(HISTORY_DATA).get(dataKey(id, version)))) as ArrayBuffer | HeldManifest | undefined;
  if (!data) return null;
  if (!('hashes' in data)) return data;
  const list = (await done(tx.objectStore(HISTORY).get(id))) as LocalVersion[] | undefined;
  const size = list?.find((v) => v.version === version)?.size ?? data.lengths.reduce((a, b) => a + b, 0);
  const chunks = tx.objectStore(CHUNKS);
  const found = await Promise.all([...new Set(data.hashes)].map(async (h) => [h, await done(chunks.get(h) as IDBRequest<ArrayBuffer | undefined>)] as const));
  const byHash = new Map(found.flatMap(([h, bytes]) => (bytes ? [[h, new Uint8Array(bytes)] as const] : [])));
  const whole = assemble({ algo: CHUNK_ALGO, size, chunks: data.hashes.map((h, i) => ({ h, n: data.lengths[i]! })) }, (h) => byHash.get(h));
  return whole ? (whole.buffer as ArrayBuffer) : null;
}

/** Keeps the document as it is now as a version (named if `name` is given), whatever the rules say. Null if there is no such document. */
export async function keepVersion(id: string, name: string | null = null): Promise<LocalVersion | null> {
  const db = await openDb();
  const tx = db.transaction([META, BYTES, MANIFESTS, CHUNKS, CHUNK_REFS, HISTORY, HISTORY_DATA], 'readwrite');
  const info = (await done(tx.objectStore(META).get(id))) as SavedInfo | undefined;
  if (!info) {
    await finished(tx);
    return null;
  }
  const list = ((await done(tx.objectStore(HISTORY).get(id))) as LocalVersion[] | undefined) ?? [];
  const existing = list.find((v) => v.version === info.updatedAt);
  let entry: LocalVersion;
  if (existing) {
    // Already kept: a name goes on it.
    entry = { ...existing, name: name ?? existing.name };
    tx.objectStore(HISTORY).put(list.map((v) => (v.version === entry.version ? entry : v)), id);
  } else {
    const manifest = (await done(tx.objectStore(MANIFESTS).get(id))) as StoredManifest | undefined;
    entry = { version: info.updatedAt, size: info.size, name, chunked: manifest !== undefined };
    if (manifest) await holdChunked(tx, id, info, manifest, name);
    else {
      const bytes = (await done(tx.objectStore(BYTES).get(id))) as ArrayBuffer | undefined;
      if (!bytes) {
        await finished(tx);
        return null;
      }
      await recordVersion(tx, id, entry, info.size, bytes);
    }
  }
  await finished(tx);
  return entry;
}

/** Names a kept version, or (null) lets it be thinned like the others. */
export async function nameVersion(id: string, version: number, name: string | null): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(HISTORY, 'readwrite');
  const list = (await done(tx.objectStore(HISTORY).get(id))) as LocalVersion[] | undefined;
  if (list) tx.objectStore(HISTORY).put(list.map((v) => (v.version === version ? { ...v, name } : v)), id);
  await finished(tx);
}

/** Removes a kept version. */
export async function deleteVersion(id: string, version: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([HISTORY, HISTORY_DATA, CHUNK_REFS, CHUNKS], 'readwrite');
  const list = (await done(tx.objectStore(HISTORY).get(id))) as LocalVersion[] | undefined;
  const gone = list?.find((v) => v.version === version);
  if (list && gone) {
    tx.objectStore(HISTORY).put(
      list.filter((v) => v !== gone),
      id,
    );
    await dropData(tx, id, gone);
  }
  await finished(tx);
}

// --- Trash -----------------------------------------------------------------------------------------------------------------
// A document deleted from this browser by the person (not one an account removes when it signs out, or one found to be deleted
// elsewhere) is not deleted: its catalogue record moves from META to TRASH, so every list of documents stops showing it, and
// everything else about it stays put. Restoring moves the record back; deleting for good (or 30 days, `TRASH_MS`) does what
// `deleteSaved` always did. A document that has a copy in an account is deleted from the account's own trash instead (see the server),
// and only this browser's copy of it is deleted here.

/** A deleted document, as kept in the trash. */
export interface TrashedSaved {
  info: SavedInfo;
  /** When it was deleted. */
  deletedAt: number;
}

async function trashedRecords(): Promise<TrashedSaved[]> {
  const db = await openDb();
  return done(db.transaction(TRASH).objectStore(TRASH).getAll() as IDBRequest<TrashedSaved[]>);
}

/** Moves a saved document to the trash. */
export async function trashSaved(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, TRASH], 'readwrite');
  const info = (await done(tx.objectStore(META).get(id))) as SavedInfo | undefined;
  if (info) {
    tx.objectStore(TRASH).put({ info, deletedAt: Date.now() } satisfies TrashedSaved, id);
    tx.objectStore(META).delete(id);
  }
  await finished(tx);
}

/** What is in the trash, newest first; what has been there for 30 days is deleted for good first. */
export async function listTrashedSaved(now = Date.now()): Promise<TrashedSaved[]> {
  const all = await trashedRecords();
  const expired = all.filter((r) => now - r.deletedAt >= TRASH_MS);
  for (const r of expired) await deleteSaved(r.info.id);
  return all.filter((r) => !expired.includes(r)).sort((a, b) => b.deletedAt - a.deletedAt);
}

/**
 * Puts a trashed document back. A document made while signed out comes back as `owner`'s when someone is signed in (as adopting
 * the guest documents does at sign-in), which the caller then uploads. Null if it is not in the trash.
 */
export async function restoreTrashedSaved(id: string, owner?: string): Promise<SavedInfo | null> {
  const db = await openDb();
  const tx = db.transaction([META, TRASH], 'readwrite');
  const record = (await done(tx.objectStore(TRASH).get(id))) as TrashedSaved | undefined;
  if (!record) {
    await finished(tx);
    return null;
  }
  const { releasedFrom: _from, ...rest } = record.info;
  const info: SavedInfo = record.info.owner === undefined && owner !== undefined ? { ...rest, owner } : record.info;
  tx.objectStore(META).put(info);
  tx.objectStore(TRASH).delete(id);
  await finished(tx);
  return info;
}

/** Deletes trashed documents for good: one, or (without an id) all of them. */
export async function purgeTrashedSaved(id?: string): Promise<void> {
  const ids = id !== undefined ? [id] : (await trashedRecords()).map((r) => r.info.id);
  for (const one of ids) await deleteSaved(one);
}

// --- Synced base ----------------------------------------------------------------------------------------------------------
// The bytes of the last version a document and its cloud copy agreed on (downloaded, or uploaded), and that version's `updatedAt` in
// the cloud. When an upload finds the cloud copy changed elsewhere, a merge starts from these (see ../formats/merge.ts, ../library.ts):
// without them the two versions can only be kept apart. Kept only for documents not kept as chunks, so it costs at most one copy of
// each small document.

export interface SyncedBase {
  cloudUpdatedAt: number;
  bytes: ArrayBuffer;
}

/** Records (or, with no bytes, forgets) a document's synced base, in a transaction that has BASES. */
function keepBase(tx: IDBTransaction, id: string, bytes: Uint8Array | null, cloudUpdatedAt: number | undefined): void {
  const store = tx.objectStore(BASES);
  if (bytes && cloudUpdatedAt !== undefined && bytes.byteLength < CHUNK_MIN_FILE) store.put({ cloudUpdatedAt, bytes: own(bytes) } satisfies SyncedBase, id);
  else store.delete(id);
}

export async function getSyncedBase(id: string): Promise<SyncedBase | null> {
  const db = await openDb();
  return ((await done(db.transaction(BASES).objectStore(BASES).get(id))) as SyncedBase | undefined) ?? null;
}

/**
 * Replaces a document's copy here with `bytes` (a merge of it and the cloud copy), now based on the cloud copy at `cloudUpdatedAt`
 * whose bytes are `base`: the next upload sends it on top of that version. Only if the copy is still the one the merge was made from
 * (`seenUpdatedAt`) and is small enough not to be kept as chunks; false, having changed nothing, otherwise. What it replaces is kept in
 * the document's history first, so a merge can always be undone.
 */
export async function rebaseSaved(id: string, change: { seenUpdatedAt: number; bytes: Uint8Array; base: Uint8Array; cloudUpdatedAt: number }): Promise<boolean> {
  if (change.bytes.byteLength >= CHUNK_MIN_FILE) return false;
  const db = await openDb();
  const before = await getSaved(id);
  if (!before || before.info.updatedAt !== change.seenUpdatedAt) return false;
  await keepWhole(db, id, before.info, before.bytes);
  const tx = db.transaction([META, BYTES, MANIFESTS, BASES], 'readwrite');
  const info = (await done(tx.objectStore(META).get(id))) as SavedInfo | undefined;
  const chunked = (await done(tx.objectStore(MANIFESTS).get(id))) !== undefined;
  if (!info || info.updatedAt !== change.seenUpdatedAt || chunked) {
    await finished(tx);
    return false;
  }
  tx.objectStore(META).put({ ...info, size: change.bytes.byteLength, updatedAt: Math.max(Date.now(), info.updatedAt + 1), cloudUpdatedAt: change.cloudUpdatedAt } satisfies SavedInfo);
  tx.objectStore(BYTES).put(own(change.bytes), id);
  keepBase(tx, id, change.base, change.cloudUpdatedAt);
  await finished(tx);
  return true;
}
