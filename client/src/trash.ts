// The trash as the app shows it: what was deleted from this browser (storage/local.ts) and, for an account with sync, from the account
// (cloud.ts), as one list. Each is kept 30 days. The dialog goes through here, with the real storage behind `TrashDeps`.

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
  /** Deletes one for good, or (without an item) everything in the trash. */
  purge(item?: TrashItem): Promise<void>;
}

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
