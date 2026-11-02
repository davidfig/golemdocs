// The library as everything shows it: this browser's copies, the account's documents, the folders
// they are in and what other people shared. The Documents screen, the Files Sidebar and the rest of
// the app (File › Open Recent, what saving and uploading need to know) all read this one copy, so
// they can't disagree, and one listing of the account serves them all.
//
// The entries are the truth: this browser's copies and the account's list are read off them. So a
// change shown before it is saved (a document moved, say) holds until the next listing replaces it,
// whichever list the next change comes through.

import type { User } from './auth.ts';
import type { CloudDocument } from './cloud.ts';
import type { Folder } from './folders.ts';
import { listSaved, type SavedInfo } from './storage/local.ts';
import { loadLibrary, loadLocalLibrary, localCopies, mergeLibrary, type LibraryEntry } from './sync.ts';

export interface LibraryHost {
  /** Whose documents to list (null: signed out, or without sync: this browser's own). */
  account(): User | null;
  /** Who is signed in, sync or not (they still see what others shared with them). */
  signedIn(): User | null;
  /** What a listing found out about the account, for the uploads (signed out elsewhere, unreachable). */
  listed?(result: { signedOut: boolean; offline: boolean }): void;
}

/** How long `refreshSoon` waits, so a burst of saves makes one listing. */
const REFRESH_DELAY_MS = 3000;

export class LibraryStore {
  private entryList: LibraryEntry[] = [];
  private folderList: Folder[] = [];
  private sharedList: CloudDocument[] = [];
  /** Whether the account's list is known (signed in and reached, or cached), so a copy missing from it means something. */
  private cloudKnown = false;
  private problemText: string | null = null;
  /** Bumped by every change and listing: a listing that answers after a newer one, or after a change shown here, is dropped. */
  private generation = 0;
  /** Whether anything has been listed yet (the first refresh shows what this browser has before asking the account). */
  private listed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  /** `local` and `cloud`, read off the entries once per change. */
  private derived: { local: SavedInfo[]; cloud: CloudDocument[] } | null = null;

  constructor(private readonly host: LibraryHost) {}

  get entries(): LibraryEntry[] {
    return this.entryList;
  }

  get folders(): Folder[] {
    return this.folderList;
  }

  get shared(): CloudDocument[] {
    return this.sharedList;
  }

  /** Why the account's documents aren't all listed (offline, say), or null. */
  get problem(): string | null {
    return this.problemText;
  }

  /** This browser's copies (the user's own). */
  get local(): SavedInfo[] {
    return this.split().local;
  }

  /** The account's documents (empty when not known). */
  get cloud(): CloudDocument[] {
    return this.split().cloud;
  }

  private split(): { local: SavedInfo[]; cloud: CloudDocument[] } {
    this.derived ??= {
      local: this.entryList.flatMap((e) => (e.local ? [e.local] : [])),
      cloud: this.entryList.flatMap((e) => (e.cloud ? [e.cloud] : [])),
    };
    return this.derived;
  }

  /** Calls `listener` after every change. Returns how to stop. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(change: { entries?: LibraryEntry[]; folders?: Folder[]; shared?: CloudDocument[] }): void {
    if (change.entries) {
      this.entryList = change.entries;
      this.derived = null;
    }
    if (change.folders) this.folderList = change.folders;
    if (change.shared) this.sharedList = change.shared;
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Shows a change before it is saved (moved, renamed, made or deleted). A listing already on its
   * way is dropped, as it was asked for before: list again once the change is saved.
   */
  update(change: { entries?: LibraryEntry[]; folders?: Folder[]; shared?: CloudDocument[] }): void {
    this.generation++;
    this.set(change);
  }

  /** This browser's copies changed (one saved, or uploaded): read them again. */
  async reloadLocal(): Promise<void> {
    const local = await localCopies(this.host.account());
    if (local) this.set({ entries: mergeLibrary(local, this.cloudKnown ? this.cloud : null) });
  }

  /**
   * The account's id for a copy in this browser. Asked before the library is first read (a document opened from the account a moment
   * ago, say), it is read off the stored copy, rather than taken for one the account doesn't have.
   */
  async cloudIdOf(localId: string): Promise<string | undefined> {
    return this.local.find((l) => l.id === localId)?.cloudId ?? (await listSaved().catch(() => [])).find((l) => l.id === localId)?.cloudId;
  }

  /** A copy just saved (or opened from the account), shown without reading them all again. */
  putLocal(info: SavedInfo): void {
    this.set({ entries: mergeLibrary([info, ...this.local.filter((l) => l.id !== info.id)], this.cloudKnown ? this.cloud : null) });
  }

  /** Documents just saved to the account (made, renamed or uploaded), shown without listing it again. */
  putCloud(...docs: CloudDocument[]): void {
    const ids = new Set(docs.map((d) => d.id));
    this.cloudKnown = true;
    this.set({ entries: mergeLibrary(this.local, [...docs, ...this.cloud.filter((d) => !ids.has(d.id))]) });
  }

  /** Lists everything again in a moment (several changes in a row make one listing). */
  refreshSoon(delay = REFRESH_DELAY_MS): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), delay);
  }

  /**
   * Lists everything again. The first time, what this browser has (and the account's list as last
   * seen) shows at once, before the account answers.
   */
  async refresh(): Promise<void> {
    clearTimeout(this.timer);
    const generation = ++this.generation;
    const account = this.host.account();
    if (!this.listed) {
      const start = await loadLocalLibrary(account);
      if (generation !== this.generation) return;
      this.cloudKnown = start.cloud !== null;
      this.set({ entries: start.entries, folders: start.folders, shared: start.shared });
    }
    const library = await loadLibrary(account, this.host.signedIn());
    this.host.listed?.({ signedOut: library.signedOut, offline: library.offline });
    if (generation !== this.generation) return;
    this.listed = true;
    this.problemText = library.cloudProblem;
    // Unreachable, the account's list as last known stays (its copies here still show).
    if (library.cloud !== null || !account) this.cloudKnown = library.cloud !== null;
    const entries = library.cloud === null && account && this.cloudKnown ? mergeLibrary(library.local, this.cloud) : library.entries;
    // Unless they couldn't be listed: what is shown is better than none.
    this.set({ entries, ...(library.folders && { folders: library.folders }), ...(!library.cloudProblem && { shared: library.shared }) });
  }

  /** Who is listed changed (signed in or out): start again from what this browser has for them. */
  reset(): void {
    this.listed = false;
    this.cloudKnown = false;
  }
}
