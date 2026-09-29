// Documents saved in this browser (IndexedDB). No account is involved and nothing leaves the
// device. A saved document may also be linked to a copy in the cloud (see ../library.ts).

export interface SavedInfo {
  id: string;
  name: string;
  size: number;
  updatedAt: number;
  /** The cloud document this is a copy of, once it has been saved to (or opened from) the cloud. */
  cloudId?: string;
  /** `updatedAt` as of the last time this copy and the cloud copy were identical. */
  cloudSyncedAt?: number;
}

const DB_NAME = 'word';
const META = 'meta';
const BYTES = 'bytes';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(META, { keyPath: 'id' });
        request.result.createObjectStore(BYTES);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('could not open browser storage'));
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
    tx.onabort = () => reject(tx.error ?? new Error('storage transaction aborted'));
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

async function write(input: { id?: string; name: string; bytes: Uint8Array | ArrayBuffer }, cloudId?: string): Promise<SavedInfo> {
  const db = await openDb();
  const tx = db.transaction([META, BYTES], 'readwrite');
  const meta = tx.objectStore(META);
  const existing = input.id ? ((await done(meta.get(input.id))) as SavedInfo | undefined) : undefined;
  const buffer = input.bytes instanceof Uint8Array ? input.bytes.slice().buffer : input.bytes.slice(0);
  const info: SavedInfo = {
    ...existing,
    id: input.id ?? crypto.randomUUID(),
    name: input.name,
    size: buffer.byteLength,
    // Strictly increasing per document, so "saved after the last sync" is always decidable.
    updatedAt: Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1),
  };
  if (cloudId) {
    info.cloudId = cloudId;
    info.cloudSyncedAt = info.updatedAt;
  }
  meta.put(info);
  tx.objectStore(BYTES).put(buffer, info.id);
  await finished(tx);
  return info;
}

/** Saves (creating or replacing) a document in this browser. Keeps any cloud link, now out of sync. */
export function saveSaved(input: { id?: string; name: string; bytes: Uint8Array | ArrayBuffer }): Promise<SavedInfo> {
  return write(input);
}

/** Saves bytes that came from the cloud, and marks this copy as identical to it. */
export function saveFromCloud(input: { id?: string; name: string; bytes: ArrayBuffer; cloudId: string }): Promise<SavedInfo> {
  return write(input, input.cloudId);
}

/** Records that the current saved copy is what's in the cloud (after an upload). */
export async function markSynced(id: string, cloudId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(META, 'readwrite');
  const info = (await done(tx.objectStore(META).get(id))) as SavedInfo | undefined;
  if (info) tx.objectStore(META).put({ ...info, cloudId, cloudSyncedAt: info.updatedAt });
  await finished(tx);
}

export async function deleteSaved(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, BYTES], 'readwrite');
  tx.objectStore(META).delete(id);
  tx.objectStore(BYTES).delete(id);
  await finished(tx);
}
