// The secrets that make live blocks this person's on this device (owner.ts): this browser's own (for blocks made signed out)
// and every account's that has been signed in here, from the server (`owner` in /api/live-marker). Kept in browser storage,
// never synced as a setting: the account's comes from the server on each device.

import { newOwnerSecret, signedBy } from './owner.ts';
import type { LiveOwner } from './owner.ts';

const LOCAL_KEY = 'golem.liveOwner';
const ACCOUNTS_KEY = 'golem.liveOwner.accounts';

let memoryLocal: string | null = null;
/** The signed-in account's id. */
let account: string | null = null;
let memoryAccounts: Record<string, string> = {};

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: kept for this page only.
  }
}

const isSecret = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{32}$/.test(s);

function localSecret(): string {
  const stored = read(LOCAL_KEY) ?? memoryLocal;
  if (isSecret(stored)) return stored;
  memoryLocal = newOwnerSecret();
  write(LOCAL_KEY, memoryLocal);
  return memoryLocal;
}

/** Every account's secret known here, by account id. */
function accountSecrets(): Record<string, string> {
  try {
    const stored: unknown = JSON.parse(read(ACCOUNTS_KEY) ?? '{}');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) return { ...Object.fromEntries(Object.entries(stored).filter(([, v]) => isSecret(v))), ...memoryAccounts };
  } catch {
    // Unreadable: only this page's.
  }
  return memoryAccounts;
}

/** Who is signed in (null: no one): their secret, if this device has had it, is used at once, even offline. */
export function setLiveAccount(id: string | null): void {
  account = id;
}

/** An account's secret, as the server gave it. */
export function learnAccountOwner(id: string, secret: unknown): void {
  if (!isSecret(secret) || accountSecrets()[id] === secret) return;
  memoryAccounts = { ...memoryAccounts, [id]: secret };
  write(ACCOUNTS_KEY, JSON.stringify(accountSecrets()));
}

/** Who this device works for: every secret it holds; new blocks are signed with the account's, or this browser's signed out. */
export function liveOwner(): LiveOwner {
  const local = localSecret();
  const known = accountSecrets();
  const mine = account ? known[account] : undefined;
  return { secrets: [...new Set([...(mine ? [mine] : []), ...Object.values(known), local])], sign: mine ?? local };
}

/** A `by` for a block made now. */
export const newBlockBy = (): Promise<string> => signedBy(liveOwner().sign);
