// What this computer remembers of a vault between syncs (the manifest that `syncVault` keeps), in this browser's own storage
// rather than in the folder. A vault folder may be shared with other computers by iCloud Drive, Dropbox, OneDrive and the like,
// and each of them links the files to its own documents: a manifest kept in the folder would reach the others and tell them
// their files were deleted. One record per vault folder, by its path.

import { t } from '../i18n/index.ts';
import type { VaultMemory } from './vaultSync.ts';

const DB_NAME = 'golemdocs-vault';
const STORE = 'state';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(t('app.storageOpenFailed')));
  }).catch((error) => {
    dbPromise = null; // storage can be blocked; try again next time
    throw error;
  });
  return dbPromise;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** The memory of the vault at `root`. Reading fails (rather than answering "nothing") when storage can't be opened, so a sync never mistakes a blocked store for a vault it has never seen. */
export function vaultMemory(root: string): VaultMemory {
  return {
    async load() {
      const db = await openDb();
      return (await done(db.transaction(STORE).objectStore(STORE).get(root) as IDBRequest<string | undefined>)) ?? null;
    },
    async save(text) {
      const db = await openDb();
      await done(db.transaction(STORE, 'readwrite').objectStore(STORE).put(text, root));
    },
  };
}
