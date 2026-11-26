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
  /**
   * The operating system marks the vault's file as downloaded (macOS quarantine, Windows' Zone.Identifier); null when that can't be
   * told (a shell too old to ask), which counts as downloaded: a page from the vault folder is foreign until marked.
   */
  downloaded?: boolean | null;
  /** The person marked this page as theirs on this device while its file had the download mark: that mark no longer counts. */
  acceptedDownload?: boolean;
  /** Its bytes' fingerprint, to match a mark. */
  hash: string;
  /** Marked as the person's own on this device, for these bytes. */
  markedHash?: string | null;
}

/** Whether the file has (or may have) the system's download mark that the person has not accepted. */
const downloadedNow = (origin: Pick<PageOrigin, 'downloaded' | 'acceptedDownload'>): boolean => origin.downloaded !== false && origin.downloaded !== undefined && !origin.acceptedDownload;

/** Own unless something says it came from elsewhere; a mark makes it own again until its bytes change. */
export function trustOf(origin: PageOrigin): PageTrust {
  const foreign = (origin.role !== undefined && origin.role !== 'owner') || !!origin.byOther || !!origin.imported || downloadedNow(origin);
  if (!foreign) return 'own';
  return origin.markedHash && origin.markedHash === origin.hash ? 'own' : 'foreign';
}

/**
 * The fingerprint of a page's bytes that a mark or a grant is kept for: SHA-256, so bytes someone else changes can't be made to
 * match one (marks kept by an earlier app, with another fingerprint, simply no longer match, and the page asks again).
 */
export async function fingerprint(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * What was allowed for this session only (a page not kept yet, or a grant given "once"), by the page's key or name: always for
 * the bytes it was given for, so another file of the same name, or the page changed, is not trusted by it.
 */
export class SessionGrants {
  private readonly mine = new Map<string, string>();
  private readonly allowed = new Map<string, { hash: string; folders: string[] }>();

  markMine(id: string, hash: string): void {
    this.mine.set(id, hash);
  }

  /** The bytes this page was marked as own for, if it was (compared to its own by `trustOf`). */
  marked(id: string): string | null {
    return this.mine.get(id) ?? null;
  }

  allowReads(id: string, hash: string, folders: readonly string[]): void {
    this.allowed.set(id, { hash, folders: [...folders] });
  }

  /** The folders it may read, if they were allowed for these bytes. */
  reads(id: string, hash: string): string[] | null {
    const grant = this.allowed.get(id);
    return grant && grant.hash === hash ? grant.folders : null;
  }
}

/**
 * Whether this device should tell the account that an owner's page came from outside (`PUT /api/documents/:id/outside`, true): it came
 * in here from outside, or its file has the system's download mark (known, not merely untold by an old shell), the account doesn't
 * already say so, the person hasn't accepted it, and these bytes weren't reported before.
 */
export function shouldReportOutside(origin: Omit<PageOrigin, 'markedHash'>, reported: string | null): boolean {
  if (origin.role !== undefined && origin.role !== 'owner') return false;
  if (origin.byOther || origin.acceptedDownload || reported === origin.hash) return false;
  return !!origin.imported || origin.downloaded === true;
}

/** The records kept, at most `max`: the oldest go first, but never one that says a page came from outside or had its download accepted. */
export function trimRecords<R extends { imported?: boolean; acceptedDownload?: boolean }>(entries: [string, R][], max: number): [string, R][] {
  let extra = entries.length - max;
  if (extra <= 0) return entries;
  return entries.filter(([, r]) => {
    if (extra > 0 && !r.imported && !r.acceptedDownload) {
      extra--;
      return false;
    }
    return true;
  });
}

/**
 * Whether what a page read (vault paths, and folders ending in `/`, '/' for the whole vault) includes any of `paths`: a page whose
 * results hold an encrypted document's words never has them kept for its viewers.
 */
export function readsAny(read: readonly string[], paths: readonly string[]): boolean {
  const wanted = paths.map((p) => p.toLowerCase());
  return read.some((r) => {
    const q = r.toLowerCase();
    if (!q.endsWith('/')) return wanted.includes(q);
    return (q === '/' && wanted.length > 0) || wanted.some((p) => p.startsWith(q));
  });
}

const KEY = 'golem.pages';
const MAX_PAGES = 500;

interface PageRecord {
  /** Came in from outside on this device. */
  imported?: boolean;
  /** Marked as the person's own while its file had the system's download mark, which then no longer makes it foreign. */
  acceptedDownload?: boolean;
  /** The bytes this device last told the account came from outside (`PUT …/outside`), so it is said once for them. */
  reported?: string;
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
    const kept = trimRecords(Object.entries(state.pages), MAX_PAGES);
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

  acceptedDownload(key: string): boolean {
    return this.record(key).acceptedDownload === true;
  }

  /**
   * Marked as the person's own (Mark as Mine): for these bytes, no longer "came in from outside", and its file's download mark
   * accepted when it had one.
   */
  markOwn(key: string, hash: string, downloaded: boolean): void {
    this.update(key, (r) => {
      const next: PageRecord = { ...r, mine: hash, ...(downloaded || r.acceptedDownload ? { acceptedDownload: true } : {}) };
      delete next.imported;
      return next;
    });
  }

  /** The bytes last reported to the account as from outside. */
  reported(key: string): string | null {
    return this.record(key).reported ?? null;
  }

  setReported(key: string, hash: string): void {
    this.update(key, (r) => ({ ...r, reported: hash }));
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
