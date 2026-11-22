// The trash as the app shows it: what was deleted from this browser (storage/local.ts) and, for an account with sync, from the account
// (cloud.ts), as one list. Each is kept 30 days. `TrashStore` keeps that list for the Files sidebar and File › Open, which both show
// it as a folder (ui/trashActions.ts has what they share); the real storage is behind `TrashDeps`.

/** Where a deleted document is kept: this browser, or the account. */
export type TrashSource = 'device' | 'account';

export interface TrashItem {
  source: TrashSource;
  id: string;
  name: string;
  size: number;
  deletedAt: number;
  /** When it will be deleted for good. */
  purgeAt: number;
}

export interface TrashDeps {
  /** Whether an account with sync is signed in, so there is an account trash to ask. */
  hasAccount(): boolean;
  listDevice(): Promise<TrashItem[]>;
  listAccount(): Promise<TrashItem[]>;
  restore(item: TrashItem): Promise<void>;
  /** Deletes one for good. */
  purge(item: TrashItem): Promise<void>;
  /** Its bytes, to look at before bringing it back. */
  read(item: TrashItem): Promise<ArrayBuffer>;
}

/** What tells two items apart: the same id may be in both trashes (a document kept in this browser and in the account). */
export const trashKey = (item: TrashItem): string => `${item.source}:${item.id}`;

/**
 * Everything in the trash, newest first. The account's trash failing (offline, say) does not hide this browser's: it is reported in
 * `accountError` and the rest shows.
 */
export async function loadTrash(deps: TrashDeps): Promise<{ items: TrashItem[]; accountError: string | null }> {
  let accountError: string | null = null;
  const [device, account] = await Promise.all([
    deps.listDevice(),
    deps.hasAccount()
      ? deps.listAccount().catch((error: unknown) => {
          accountError = (error as Error).message;
          return [] as TrashItem[];
        })
      : [],
  ]);
  return { items: [...device, ...account].sort((a, b) => b.deletedAt - a.deletedAt), accountError };
}

/** How many documents are deleted at once while the trash is emptied. */
export const EMPTY_AT_ONCE = 4;

/**
 * Empties the trash one document at a time (a few at once), so the dialog can count them off as they go, rather than asking for
 * everything in one request that says nothing until it ends. Deletes exactly `items`, the ones the person was shown and agreed to.
 * `onDone` hears of each, with the error if it failed; a failure doesn't stop the rest. Stopping (`signal`) lets the ones under way
 * finish and starts no more.
 */
export async function emptyTrash(
  deps: Pick<TrashDeps, 'purge'>,
  items: readonly TrashItem[],
  options: { signal?: AbortSignal; onDone(item: TrashItem, error: Error | null): void },
): Promise<void> {
  let next = 0;
  const work = async (): Promise<void> => {
    while (next < items.length && !options.signal?.aborted) {
      const item = items[next++]!;
      let error: Error | null = null;
      try {
        await deps.purge(item);
      } catch (thrown) {
        error = thrown instanceof Error ? thrown : new Error(String(thrown));
      }
      options.onDone(item, error);
    }
  };
  await Promise.all(Array.from({ length: Math.min(EMPTY_AT_ONCE, items.length) }, work));
}

/** The trash being emptied: how far it has got. */
export interface Emptying {
  done: number;
  total: number;
  readonly stop: AbortController;
}

/**
 * The trash, listed once for everything that shows it, with what is done to it. Listing is asked for when something shows it and
 * after a delete; a listing asked for while one is on its way is made once that one ends, so it sees the change.
 */
export class TrashStore {
  items: TrashItem[] = [];
  /** Why the account's trash could not be listed (this browser's still shows), or null. */
  accountError: string | null = null;
  /** Whether it has been listed at all yet. */
  loaded = false;
  /** Items being deleted for good (`trashKey`), still listed until they are gone. */
  readonly going = new Set<string>();
  emptying: Emptying | null = null;
  private readonly listeners = new Set<() => void>();
  private listing: Promise<void> | null = null;
  private again = false;

  constructor(private readonly deps: TrashDeps) {}

  /** Calls `listener` after every change; returns how to stop. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** Lists the trash again. */
  refresh(): Promise<void> {
    if (this.listing) {
      this.again = true;
      return this.listing;
    }
    this.listing = (async () => {
      do {
        this.again = false;
        const loaded = await loadTrash(this.deps);
        this.items = loaded.items;
        this.accountError = loaded.accountError;
        this.loaded = true;
      } while (this.again);
    })().finally(() => {
      this.listing = null;
      this.changed();
    });
    return this.listing;
  }

  /** Brings one back; it leaves the list at once. Fails with why. */
  async restore(item: TrashItem): Promise<void> {
    await this.deps.restore(item);
    this.drop(item);
    this.changed();
    void this.refresh();
  }

  /** Deletes one for good. It is marked as going until it is gone; fails with why (and stays). */
  async purge(item: TrashItem): Promise<void> {
    this.going.add(trashKey(item));
    this.changed();
    try {
      await this.deps.purge(item);
      this.drop(item);
    } finally {
      this.going.delete(trashKey(item));
      this.changed();
    }
  }

  read(item: TrashItem): Promise<ArrayBuffer> {
    return this.deps.read(item);
  }

  /**
   * Empties the trash of `items` (what the person was shown and agreed to), one at a time (see `emptyTrash`), each leaving the list
   * as it goes. `emptying` says how far it has got meanwhile. Resolves with the first failure, if any.
   */
  async empty(items: readonly TrashItem[]): Promise<{ failed: Error | null; stopped: boolean }> {
    if (this.emptying) return { failed: null, stopped: true };
    const emptying: Emptying = { done: 0, total: items.length, stop: new AbortController() };
    this.emptying = emptying;
    let failed: Error | null = null;
    for (const item of items) this.going.add(trashKey(item));
    this.changed();
    try {
      await emptyTrash(this.deps, items, {
        signal: emptying.stop.signal,
        onDone: (item, error) => {
          emptying.done++;
          this.going.delete(trashKey(item));
          if (error) failed ??= error;
          else this.drop(item);
          this.changed();
        },
      });
    } finally {
      for (const item of items) this.going.delete(trashKey(item));
      this.emptying = null;
      this.changed();
    }
    void this.refresh();
    return { failed, stopped: emptying.stop.signal.aborted };
  }

  /** Stops emptying: no more are started. */
  stop(): void {
    this.emptying?.stop.abort();
  }

  private drop(item: TrashItem): void {
    const key = trashKey(item);
    this.items = this.items.filter((i) => trashKey(i) !== key);
  }
}
