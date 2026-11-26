// Where sounds too big for memory are kept while they are edited, and the unsaved edits of a lossy file (a draft): a database of their
// own in this browser, never uploaded. What a window leaves behind, and no draft uses, is cleared by the next to open an editor.

import type { PageStore } from './sound.ts';

const NAME = 'golemdocs-audio';
const PAGES = 'pages';
const DRAFTS = 'drafts';

/** A list's pieces, with their sounds by number (-1: silence). */
export interface StoredList {
  pieces: { sound: number; from: number; length: number }[];
}

/** Unsaved edits. Sound 0 is the file's own, decoded again when it is opened. */
export interface Draft extends StoredList {
  /** The document it is of, and a digest of the file that was edited. */
  key: string;
  digest: string;
  sounds: { id: string; channelCount: number; length: number }[];
  labels: unknown;
  at: number;
  /** The document's name, and whose it is (a user id), to say what signing out would lose. */
  name: string;
  owner?: string;
}

let opening: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(PAGES);
      request.result.createObjectStore(DRAFTS, { keyPath: 'key' });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        opening = null;
      };
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('audio storage'));
  }).catch((e) => {
    opening = null;
    throw e;
  });
  return opening;
}

const done = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('audio storage'));
  });

async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await database()).transaction(name, mode).objectStore(name);
}

/** Every page of a sound: its keys are [window, sound, page]. */
const pagesOf = (window: string, sound: string): IDBKeyRange => IDBKeyRange.bound([window, sound], [window, sound, []]);

function storeFor(window: string): PageStore {
  return {
    put: async (sound, page, samples) => void (await done((await store(PAGES, 'readwrite')).put(samples, [window, sound, page]))),
    get: async (sound, page) => ((await done((await store(PAGES, 'readonly')).get([window, sound, page]))) as Float32Array[] | undefined) ?? null,
    remove: async (sound) => void (await done((await store(PAGES, 'readwrite')).delete(pagesOf(window, sound)))),
  };
}

let mine: PageStore | null = null;

/** This window's pages. Held open by a lock, so that another window knows they are in use; null where that can't be had. */
export function windowPages(): PageStore | null {
  if (mine || typeof indexedDB === 'undefined' || !navigator.locks) return mine;
  const id = crypto.randomUUID();
  void navigator.locks.request(`golem-audio-${id}`, () => new Promise<void>(() => {}));
  mine = storeFor(id);
  void sweep(id).catch(() => undefined);
  return mine;
}

/** A draft's pages, kept till it is saved or thrown away. */
export const draftPages = (key: string): PageStore => storeFor(`draft:${key}`);

/** Deletes the pages of windows that are gone, and drafts long left. */
async function sweep(own: string): Promise<void> {
  for (const draft of (await done((await store(DRAFTS, 'readonly')).getAll())) as Draft[]) if (draft.at < Date.now() - DRAFT_DAYS * 86_400_000) await removeDraft(draft.key);
  const held = new Set(((await navigator.locks.query()).held ?? []).map((lock) => lock.name));
  const pages = await store(PAGES, 'readwrite');
  let after: IDBKeyRange | null = null;
  for (;;) {
    const key = (await done(pages.getKey(after ?? IDBKeyRange.lowerBound([])))) as [string] | undefined;
    if (!key) return;
    const window = key[0];
    if (window !== own && !window.startsWith('draft:') && !held.has(`golem-audio-${window}`)) pages.delete(IDBKeyRange.bound([window], [window, []]));
    after = IDBKeyRange.lowerBound([window, []]);
  }
}

export async function getDraft(key: string): Promise<Draft | null> {
  return ((await done((await store(DRAFTS, 'readonly')).get(key))) as Draft | undefined) ?? null;
}

/** Set while there are drafts, so that signing out needn't load the editor to know (see main.ts). */
export const DRAFTS_FLAG = 'golem.audioDrafts';

export async function putDraft(draft: Draft): Promise<void> {
  try {
    localStorage.setItem(DRAFTS_FLAG, '1');
  } catch {
    // signing out won't ask about it
  }
  await done((await store(DRAFTS, 'readwrite')).put(draft));
}

export async function removeDraft(key: string): Promise<void> {
  const tx = (await database()).transaction([DRAFTS, PAGES], 'readwrite');
  tx.objectStore(DRAFTS).delete(key);
  tx.objectStore(PAGES).delete(IDBKeyRange.bound([`draft:${key}`], [`draft:${key}`, []]));
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error ?? new Error('audio storage'));
  });
}

export async function draftsOf(owner: string | undefined): Promise<Draft[]> {
  return ((await done((await store(DRAFTS, 'readonly')).getAll())) as Draft[]).filter((draft) => draft.owner === owner);
}

/** Drafts this old are of files that are gone, or forgotten. */
const DRAFT_DAYS = 60;

/** A digest of a file, to tell whether a draft is of it. */
export async function digestOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}
