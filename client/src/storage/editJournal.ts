// The edits since a document's last save, kept where a page that is going away can't lose them (docs/edit-journal.md).
//
// The document is in the layout worker, and a page can't wait for it while it unloads, so a last save on the way out
// never lands. Instead the worker tells the page of every edit as it happens, and the page writes it to `localStorage`,
// which is synchronous. A save says how far through the journal its bytes reach, in the same IndexedDB transaction as the
// bytes (`JournalMarker`), and opening the document replays whatever lies past that.
//
//   golemdocs.journal.<document>.<session>      { page, startedAt, base }
//   golemdocs.journal.<document>.<session>.<n>  the operations of edit n, or null for a barrier: what can't be replayed

import { isOperation, type Operation } from '@golemdocs/ops';

const PREFIX = 'golemdocs.journal.';
/** One edit bigger than this (a large paste) isn't kept: a barrier, and a save right away. */
export const MAX_ENTRY_CHARS = 64 * 1024;
/** Nor is anything once a session's journal holds this much. */
export const MAX_JOURNAL_CHARS = 512 * 1024;

/** How far through a session's journal a saved copy reaches. Kept with the copy, and written with its bytes. */
export interface JournalMarker {
  session: string;
  seq: number;
  /** Other sessions' journals that were replayed into this copy: they are done with, should they still be there. */
  absorbed?: string[];
}

/** What is stored for a session: what it stood on, and whose it is. */
interface Head {
  page: string;
  startedAt: number;
  /** The `updatedAt` of the saved copy its entries follow. */
  base: number;
}

export type JournalStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

const sessionKey = (doc: string, session: string): string => `${PREFIX}${doc}.${session}`;

/** Every key of the store, as a list that removing keys won't disturb. */
function allKeys(store: JournalStore): string[] {
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }
  return keys;
}

/**
 * One open document's journal. Before the document has a place in the browser (a new one, not saved yet) its edits wait
 * here, in memory, for `saved` to give it one.
 */
export class EditJournal {
  private doc: string | null = null;
  private base = 0;
  private headWritten = false;
  private readonly startedAt = Date.now();
  private entries: { n: number; json: string }[] = [];
  private chars = 0;
  /** A barrier has been written: nothing after it can be replayed, so nothing is kept until a save has passed it. */
  private barrierAt = 0;
  /** The last edit since the barrier, none of them kept: a save has to hold them all before anything can follow. */
  private droppedTo = 0;

  constructor(
    private readonly store: JournalStore,
    readonly session: string,
    private readonly page: string,
  ) {}

  /** The document has a saved copy, from `base`. */
  attach(doc: string, base: number): void {
    this.doc = doc;
    this.base = base;
    this.headWritten = false;
    // Edits made before it had a place, past whatever the save that gave it one held (see `saved`).
    for (const entry of this.entries) {
      if (entry.n < this.barrierAt || !this.barrierAt) {
        if (!this.put(entry.n, entry.json)) return void this.block(entry.n);
      }
    }
    if (this.barrierAt) this.put(this.barrierAt, 'null');
  }

  /** Nothing is being kept until a save has passed what couldn't be. */
  get blocked(): boolean {
    return this.barrierAt !== 0;
  }

  /** An edit. False when it can't be kept: the caller should save soon. */
  add(n: number, ops: readonly Operation[]): boolean {
    if (this.barrierAt) {
      this.droppedTo = n;
      return false;
    }
    const json = JSON.stringify(ops);
    if (json.length > MAX_ENTRY_CHARS || this.chars + json.length > MAX_JOURNAL_CHARS) {
      this.block(n);
      return false;
    }
    this.entries.push({ n, json });
    this.chars += json.length;
    if (this.doc !== null && !this.put(n, json)) {
      this.block(n);
      return false;
    }
    return true;
  }

  /** What was done at `n` can't be replayed (a picture added: its bytes aren't in the operation): replay stops here until a save passes it. */
  barrier(n: number): void {
    this.block(n);
  }

  private block(n: number): void {
    this.droppedTo = Math.max(this.droppedTo, n);
    if (this.barrierAt) return;
    this.barrierAt = n;
    if (this.doc !== null) this.put(n, 'null');
  }

  private put(n: number, json: string): boolean {
    const doc = this.doc!;
    try {
      if (!this.headWritten) {
        const head: Head = { page: this.page, startedAt: this.startedAt, base: this.base };
        this.store.setItem(sessionKey(doc, this.session), JSON.stringify(head));
        this.headWritten = true;
      }
      this.store.setItem(`${sessionKey(doc, this.session)}.${n}`, json);
      return true;
    } catch {
      // Storage full or blocked: as if there were no journal, until the save this asks for.
      return false;
    }
  }

  /** A save holding everything up to `seq` has landed, as `doc` at `updatedAt`. */
  saved(doc: string, updatedAt: number, seq: number): void {
    const first = this.doc === null;
    this.base = updatedAt;
    const keep = this.entries.filter((e) => e.n > seq);
    this.remove(this.entries.filter((e) => e.n <= seq));
    this.entries = keep;
    this.chars = keep.reduce((sum, e) => sum + e.json.length, 0);
    if (this.barrierAt && this.barrierAt <= seq) {
      if (this.doc !== null) this.store.removeItem(`${sessionKey(this.doc, this.session)}.${this.barrierAt}`);
      // Edits this save doesn't hold were dropped after it: the barrier moves up to them, so nothing is replayed over the gap.
      this.barrierAt = this.droppedTo > seq ? seq + 1 : 0;
      if (this.barrierAt && this.doc !== null) this.put(this.barrierAt, 'null');
    }
    if (first) this.attach(doc, updatedAt);
    this.writeOrDropHead();
  }

  /** The head says what the entries follow, and goes with the last of them. */
  private writeOrDropHead(): void {
    const doc = this.doc;
    if (doc === null) return;
    if (this.entries.length === 0 && !this.barrierAt) {
      this.store.removeItem(sessionKey(doc, this.session));
      this.headWritten = false;
      return;
    }
    try {
      const head: Head = { page: this.page, startedAt: this.startedAt, base: this.base };
      this.store.setItem(sessionKey(doc, this.session), JSON.stringify(head));
      this.headWritten = true;
    } catch {
      // Storage full: the marker in the saved copy still says which entries it holds.
    }
  }

  private remove(entries: readonly { n: number }[]): void {
    const doc = this.doc;
    if (doc === null) return;
    for (const { n } of entries) this.store.removeItem(`${sessionKey(doc, this.session)}.${n}`);
  }

  /** Others hold the edits from now on (the document is shared, and the room has them): none of it is needed. */
  clear(): void {
    this.remove(this.entries);
    this.entries = [];
    this.chars = 0;
    if (this.doc !== null && this.barrierAt) this.store.removeItem(`${sessionKey(this.doc, this.session)}.${this.barrierAt}`);
    this.barrierAt = 0;
    this.droppedTo = 0;
    this.writeOrDropHead();
  }
}

/** A session's journal of a document, as found in the store. */
export interface StoredJournal extends Head {
  session: string;
  /** In order, up to the first thing that can't be replayed. */
  batches: Operation[][];
  /** The last of them, if any, is not the end of what was edited (a barrier, or something unreadable). */
  cut: boolean;
  /** Past which edit `batches` starts: entries at or below a saved copy's marker are skipped (see `planRecovery`). */
  numbers: number[];
}

/** Whether there is anything kept for a document at all (the usual answer is no, and this doesn't parse anything). */
export function hasJournal(store: JournalStore, doc: string): boolean {
  const prefix = `${PREFIX}${doc}.`;
  return allKeys(store).some((key) => key.startsWith(prefix));
}

/** Every session's journal of a document, oldest first. */
export function readJournals(store: JournalStore, doc: string): StoredJournal[] {
  const prefix = `${PREFIX}${doc}.`;
  const bySession = new Map<string, { n: number; key: string }[]>();
  const heads = new Map<string, Head>();
  for (const key of allKeys(store)) {
    if (!key.startsWith(prefix)) continue;
    const [session, number] = key.slice(prefix.length).split('.');
    if (number === undefined) {
      try {
        heads.set(session, JSON.parse(store.getItem(key)!) as Head);
      } catch {
        // Unreadable: treated as no head, below.
      }
    } else {
      const list = bySession.get(session) ?? [];
      list.push({ n: Number(number), key });
      bySession.set(session, list);
    }
  }
  const journals: StoredJournal[] = [];
  for (const [session, head] of heads) {
    const batches: Operation[][] = [];
    const numbers: number[] = [];
    let cut = false;
    for (const { n, key } of (bySession.get(session) ?? []).sort((a, b) => a.n - b.n)) {
      let ops: unknown;
      try {
        ops = JSON.parse(store.getItem(key)!);
      } catch {
        ops = null;
      }
      // A barrier; or from a newer version of the app, an edit this one doesn't know.
      if (!Array.isArray(ops) || !ops.every(isOperation)) {
        cut = true;
        numbers.push(n);
        break;
      }
      batches.push(ops);
      numbers.push(n);
    }
    journals.push({ ...head, session, batches, cut, numbers });
  }
  return journals.sort((a, b) => a.startedAt - b.startedAt);
}

/** Takes a session's journal of a document out of the store, whichever keys it has left. */
export function removeJournal(store: JournalStore, doc: string, session: string): void {
  const key = sessionKey(doc, session);
  for (const k of allKeys(store)) if (k === key || k.startsWith(`${key}.`)) store.removeItem(k);
}

/** The documents anything is kept for. */
export function journalDocuments(store: JournalStore): Set<string> {
  const documents = new Set<string>();
  for (const key of allKeys(store)) {
    const doc = /^(.+)\.[0-9a-f-]{36}(?:\.\d+)?$/.exec(key.slice(PREFIX.length))?.[1];
    if (doc) documents.add(doc);
  }
  return documents;
}

/** What to do with what is kept for a document, on opening it. */
export interface RecoveryPlan {
  /** Put into the document being opened, in order. */
  replay: Operation[][];
  /** The sessions those came from: done with once a save holds them. */
  absorb: string[];
  /** Edits made on top of a copy that isn't the one stored any more: they go in a copy of their own. */
  conflict: Operation[][];
  /** The sessions those came from. */
  conflicted: string[];
  /** Already in the stored copy, or empty: to be taken out now. */
  discard: string[];
  /** Some edits couldn't be brought back. */
  cut: boolean;
}

/**
 * Decides, for the saved copy being opened, what each journal of it is. Pure, so that each case can be tested. `live`:
 * pages open now, whose journals are in use and are left alone.
 */
export function planRecovery(info: { updatedAt: number; journal?: JournalMarker }, journals: readonly StoredJournal[], live: ReadonlySet<string>): RecoveryPlan {
  const plan: RecoveryPlan = { replay: [], absorb: [], conflict: [], conflicted: [], discard: [], cut: false };
  const marker = info.journal;
  for (const journal of journals) {
    if (live.has(journal.page)) continue;
    if (marker?.absorbed?.includes(journal.session)) {
      plan.discard.push(journal.session);
      continue;
    }
    // The saved copy is this session's own: what it holds is known exactly, and only what lies past it is replayed.
    const ownSave = marker?.session === journal.session;
    const past = ownSave ? journal.batches.filter((_, i) => journal.numbers[i] > marker.seq) : journal.batches;
    const lastNumber = journal.numbers[journal.numbers.length - 1] ?? 0;
    const cut = journal.cut && (!ownSave || lastNumber > marker.seq);
    if (past.length === 0) {
      // Nothing to bring back, unless what stopped it was past the save: the edits are lost as they would have been, and the barrier goes too.
      plan.discard.push(journal.session);
      if (cut) plan.cut = true;
      continue;
    }
    if (ownSave || journal.base === info.updatedAt) {
      plan.replay.push(...past);
      plan.absorb.push(journal.session);
    } else {
      plan.conflict.push(...past);
      plan.conflicted.push(journal.session);
    }
    if (cut) plan.cut = true;
  }
  return plan;
}

// --- This page, as others see it ----------------------------------------------------------------

const LOCK_PREFIX = 'golemdocs.journal.page.';

/** Identifies this page among the browser's open pages. */
export const pageId: string = typeof crypto !== 'undefined' ? crypto.randomUUID() : 'test';

/** Web Locks tell an open page from one that is gone. Without them there is no telling whose journal is whose, so nothing is kept. */
export function journalsSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.locks && typeof localStorage !== 'undefined';
}

let release: (() => void) | null = null;

/** This page is open: its journals are in use until it isn't. */
export function holdPage(): void {
  if (!journalsSupported() || release) return;
  const held = new Promise<void>((resolve) => (release = resolve));
  void navigator.locks.request(`${LOCK_PREFIX}${pageId}`, () => held).catch(() => {});
}

/** The page is going away. A lock kept any longer would also keep it from the back/forward cache. */
export function letPageGo(): void {
  release?.();
  release = null;
}

/** The other pages open now. Null when that can't be found out: their journals may be in use, so they are left alone. */
export async function otherPages(): Promise<Set<string> | null> {
  try {
    const { held = [] } = await navigator.locks.query();
    const pages = new Set<string>();
    for (const lock of held) if (lock.name?.startsWith(LOCK_PREFIX)) pages.add(lock.name.slice(LOCK_PREFIX.length));
    pages.delete(pageId);
    return pages;
  } catch {
    return null;
  }
}
