// Where this device keeps documents' word histories (wordHistory.ts): one record per document, by `cloud:<id>` or `local:<id>`,
// in a database of its own so it can never get in the way of the documents' own storage. For a guest, or a document not in
// the account, this is the only copy; for one in the account it is what the account has not taken yet, and a copy to show at
// once. Bounded: the documents written in longest ago are forgotten first.

import type { WordDay } from '../wordHistory.ts';

export interface WordRecord {
  days: WordDay[];
  /** Days the account has not taken yet. */
  pending: string[];
  /** Its days before the history began have been filled in from versions (once per device). */
  filled: boolean;
  /** When it was last kept (ms since 1970). */
  at: number;
}

export interface WordStore {
  get(key: string): Promise<WordRecord | null>;
  put(key: string, record: WordRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

const DB_NAME = 'golemdocs-words';
const STORE = 'documents';
/** Documents kept at most; past it, the one written in longest ago goes. */
export const MAX_DOCUMENTS = 500;
/** Days kept per document (the account keeps more). */
export const MAX_DAYS = 2000;

/** A record cut to the days kept: the latest ones, and every day still to send. */
export function trimRecord(record: WordRecord, max = MAX_DAYS): WordRecord {
  if (record.days.length <= max) return record;
  const pending = new Set(record.pending);
  const kept = record.days.slice(-max);
  const from = kept[0]!.day;
  return { ...record, days: record.days.filter((d) => d.day >= from || pending.has(d.day)) };
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('word history storage unavailable'));
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

let puts = 0;

/** This browser's store. */
export const browserWordStore: WordStore = {
  async get(key) {
    const db = await openDb();
    return ((await done(db.transaction(STORE).objectStore(STORE).get(key))) as WordRecord | undefined) ?? null;
  },
  async put(key, record) {
    const db = await openDb();
    await done(db.transaction(STORE, 'readwrite').objectStore(STORE).put(trimRecord(record), key));
    // Now and then, forget the documents written in longest ago.
    if (++puts % 50 === 1) await forgetOldest(db).catch(() => {});
  },
  async delete(key) {
    const db = await openDb();
    await done(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key));
  },
};

async function forgetOldest(db: IDBDatabase): Promise<void> {
  const store = db.transaction(STORE).objectStore(STORE);
  const [keys, records] = await Promise.all([done(store.getAllKeys()), done(store.getAll() as IDBRequest<WordRecord[]>)]);
  if (keys.length <= MAX_DOCUMENTS) return;
  const doomed = keys
    .map((key, i) => ({ key, at: records[i]?.at ?? 0 }))
    .sort((a, b) => a.at - b.at)
    .slice(0, keys.length - MAX_DOCUMENTS);
  const write = db.transaction(STORE, 'readwrite').objectStore(STORE);
  await Promise.all(doomed.map((d) => done(write.delete(d.key))));
}

/** A store in memory (tests, and a browser whose storage is blocked). */
export function memoryWordStore(): WordStore & { records: Map<string, WordRecord> } {
  const records = new Map<string, WordRecord>();
  return {
    records,
    async get(key) {
      return records.get(key) ?? null;
    },
    async put(key, record) {
      records.set(key, trimRecord(structuredClone(record)));
    },
    async delete(key) {
      records.delete(key);
    },
  };
}
