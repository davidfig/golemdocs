// Whether a page is the person's own or came from elsewhere (docs/html-pages.md §1), and what this device remembers about
// pages: the ones that came in from outside (opened from the computer, dropped, uploaded), the ones marked as the person's
// own, and the folders a foreign page was allowed to read. Kept per device, like a script's grant.

import type { PageTrust } from './compose.ts';

/** What is known of where a page's bytes came from. */
export interface PageOrigin {
  /** The account's role for it: 'owner' for the person's own; another for one shared with them. Absent with no account copy. */
  role?: 'owner' | 'editor' | 'viewer';
  /** Another account made it, or saved it last (a shared folder's editor). */
  byOther?: boolean;
  /** It came in on this device from outside the vault (File › Open, a drop, an upload, an attachment). */
  imported?: boolean;
  /** The operating system marks the vault's file as downloaded (macOS quarantine, Windows' Zone.Identifier). */
  downloaded?: boolean;
  /** Its bytes' fingerprint, to match a mark. */
  hash: string;
  /** Marked as the person's own on this device, for these bytes. */
  markedHash?: string | null;
}

/** Own unless something says it came from elsewhere; a mark makes it own again until its bytes change. */
export function trustOf(origin: PageOrigin): PageTrust {
  const foreign = (origin.role !== undefined && origin.role !== 'owner') || origin.byOther || origin.imported || origin.downloaded;
  if (!foreign) return 'own';
  return origin.markedHash && origin.markedHash === origin.hash ? 'own' : 'foreign';
}

/** A short, stable fingerprint of bytes (FNV-1a, 2 × 32 bits), for marks and baking; not a security hash. */
export function fingerprint(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193);
    b = Math.imul(b ^ bytes[i], 0x5bd1e995);
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

const KEY = 'golem.pages';
const MAX_PAGES = 500;

interface PageRecord {
  /** Came in from outside on this device. */
  imported?: boolean;
  /** Marked as the person's own, for bytes with this fingerprint. */
  mine?: string;
  /** Folders a foreign page may read, for bytes with this fingerprint. */
  reads?: { hash: string; folders: string[] };
  /** Page, Document or Source: how it was last shown here. */
  view?: PageView;
}

/** How an HTML file is shown: as a page, as a document, or as its source text. */
export type PageView = 'page' | 'document' | 'source';

interface Stored {
  pages: Record<string, PageRecord>;
}

/** Where the records live (localStorage, or a map in tests). */
export interface PageStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** What this device remembers about pages, by document key. */
export class PageMemory {
  constructor(private readonly storage: PageStorage) {}

  private load(): Stored {
    try {
      const parsed = JSON.parse(this.storage.getItem(KEY) ?? '{}') as Partial<Stored>;
      return { pages: parsed.pages && typeof parsed.pages === 'object' ? parsed.pages : {} };
    } catch {
      return { pages: {} };
    }
  }

  private update(key: string, change: (record: PageRecord) => PageRecord): void {
    const state = this.load();
    const record = change({ ...state.pages[key] });
    delete state.pages[key];
    if (Object.keys(record).length) state.pages[key] = record;
    const kept = Object.entries(state.pages).slice(-MAX_PAGES);
    try {
      this.storage.setItem(KEY, JSON.stringify({ pages: Object.fromEntries(kept) }));
    } catch {
      /* not remembered */
    }
  }

  private record(key: string): PageRecord {
    return this.load().pages[key] ?? {};
  }

  imported(key: string): boolean {
    return this.record(key).imported === true;
  }

  /** It came in from outside: foreign until marked. */
  setImported(key: string): void {
    this.update(key, (r) => ({ ...r, imported: true }));
  }

  /** A document saved under a new key keeps what was known under its old one (a page opened from the computer, then kept). */
  moved(from: string, to: string): void {
    const record = this.record(from);
    if (!Object.keys(record).length) return;
    this.update(to, (r) => ({ ...record, ...r }));
  }

  marked(key: string): string | null {
    return this.record(key).mine ?? null;
  }

  markMine(key: string, hash: string): void {
    this.update(key, (r) => ({ ...r, mine: hash }));
  }

  /** The folders a foreign page may read, if they were allowed for these bytes (a changed page asks again). */
  reads(key: string, hash: string): string[] | null {
    const reads = this.record(key).reads;
    return reads && reads.hash === hash ? reads.folders : null;
  }

  allowReads(key: string, hash: string, folders: readonly string[]): void {
    this.update(key, (r) => ({ ...r, reads: { hash, folders: [...folders] } }));
  }

  view(key: string): PageView | null {
    return this.record(key).view ?? null;
  }

  setView(key: string, view: PageView): void {
    this.update(key, (r) => ({ ...r, view }));
  }
}
