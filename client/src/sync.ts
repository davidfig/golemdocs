// What the dashboard and File ▸ Open Recent list. Signed out, that is the documents saved in this
// browser. Signed in, it is the account's documents: the cloud's catalogue, matched up with the
// copies this browser keeps of them (and any not uploaded yet).
//
// Sync is lazy on purpose. Signing in on another computer only fetches the catalogue (names,
// sizes, dates and a link to each thumbnail); a document's bytes are downloaded when it is opened
// (library.ts, and not even then if the browser already has the current version). Uploads are the
// app's job (main.ts), one at a time: this only says which copies have something to send.

import type { User } from './auth.ts';
import { CloudError, listDocuments, listFolders, listShared, type CloudDocument } from './cloud.ts';
import type { Folder } from './folders.ts';
import { deleteSaved, listLocalFolders, listSaved, ownedBy, type SavedInfo } from './storage/local.ts';
import { t } from './i18n/index.ts';

export type SyncState =
  /** Only in this browser: signed out, or not uploaded yet. */
  | 'local-only'
  /** Only in the cloud: nothing has been downloaded yet. */
  | 'cloud-only'
  | 'synced'
  /** Edited here since the last sync; the cloud copy is unchanged. */
  | 'local-ahead'
  /** Edited elsewhere; this browser's copy is unchanged (it's refreshed when opened). */
  | 'cloud-ahead'
  /** Edited in both places. Uploading it makes a "(conflicted copy)"; nothing is overwritten. */
  | 'conflict'
  /** Linked to the cloud, but the cloud can't be reached (offline). */
  | 'unknown';

export interface LibraryEntry {
  /** Stable across syncs: the browser copy's id, else the cloud document's. */
  key: string;
  name: string;
  size: number;
  updatedAt: number;
  local: SavedInfo | null;
  cloud: CloudDocument | null;
  state: SyncState;
  /** The folder it is in, as recorded (folders.ts says whether that folder still exists). */
  folderId: string | null;
}

/** How a browser copy and its cloud copy relate. `cloud` is null when it's missing or unknown. */
export function classify(local: SavedInfo | null, cloud: CloudDocument | null, cloudKnown: boolean): SyncState {
  if (!local) return 'cloud-only';
  if (!local.cloudId) return 'local-only';
  if (!cloudKnown) return 'unknown';
  if (!cloud) return 'local-only'; // deleted from the cloud elsewhere
  const localChanged = hasUnsentChanges(local);
  // Copies linked before the cloud's date was recorded count as unchanged there.
  const cloudChanged = local.cloudUpdatedAt !== undefined && cloud.updatedAt !== local.cloudUpdatedAt;
  if (localChanged && cloudChanged) return 'conflict';
  if (localChanged) return 'local-ahead';
  if (cloudChanged) return 'cloud-ahead';
  return 'synced';
}

/** Whether a browser copy has changes its account doesn't: never uploaded, or saved since. */
export function hasUnsentChanges(local: SavedInfo): boolean {
  return !local.cloudId || local.updatedAt > (local.cloudSyncedAt ?? 0);
}

/** Pairs browser copies with cloud documents (`cloud` null: signed out or unreachable), newest first. */
export function mergeLibrary(local: readonly SavedInfo[], cloud: readonly CloudDocument[] | null): LibraryEntry[] {
  const byCloudId = new Map((cloud ?? []).map((d) => [d.id, d]));
  const linked = new Set<string>();
  const entries: LibraryEntry[] = [];

  for (const l of local) {
    const c = (l.cloudId && byCloudId.get(l.cloudId)) || null;
    if (c) linked.add(c.id);
    const state = classify(l, c, cloud !== null);
    const useCloud = c !== null && state === 'cloud-ahead';
    entries.push({
      key: l.id,
      name: useCloud ? c.name : l.name,
      size: useCloud ? c.size : l.size,
      updatedAt: Math.max(l.updatedAt, c?.updatedAt ?? 0),
      local: l,
      cloud: c,
      state,
      folderId: c ? (c.folderId ?? null) : (l.folderId ?? null),
    });
  }
  for (const c of cloud ?? []) {
    if (linked.has(c.id)) continue;
    entries.push({ key: c.id, name: c.name, size: c.size, updatedAt: c.updatedAt, local: null, cloud: c, state: 'cloud-only', folderId: c.folderId ?? null });
  }
  return entries.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/**
 * Browser copies of documents deleted from the account elsewhere, which can go: they have nothing
 * the account is missing. (One edited here since is uploaded again instead, so no work is lost.)
 */
export function deletedElsewhere(local: readonly SavedInfo[], cloud: readonly CloudDocument[]): SavedInfo[] {
  const ids = new Set(cloud.map((d) => d.id));
  return local.filter((l) => l.cloudId && !ids.has(l.cloudId) && !hasUnsentChanges(l));
}

export interface Library {
  entries: LibraryEntry[];
  /** Why the account's documents aren't all listed (offline, say); the browser's copies still are. */
  cloudProblem: string | null;
  /** The session ended: the account needs signing in to again. */
  signedOut: boolean;
  /** Documents other people shared with the user. */
  shared: CloudDocument[];
  /** The folders the documents are arranged in. */
  folders: Folder[];
}

const CATALOGUE_KEY = 'wm.catalogue';

/** The account's catalogue as last listed, kept so the dashboard can show it before the network answers. */
function readCatalogue(user: User | null): { cloud: CloudDocument[]; shared: CloudDocument[]; folders: Folder[] } | null {
  if (!user) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(CATALOGUE_KEY) ?? 'null');
    return saved && saved.user === user.id ? { cloud: saved.cloud, shared: saved.shared, folders: saved.folders ?? [] } : null;
  } catch {
    return null;
  }
}

function writeCatalogue(user: User, cloud: CloudDocument[], shared: CloudDocument[], folders: Folder[]): void {
  try {
    localStorage.setItem(CATALOGUE_KEY, JSON.stringify({ user: user.id, cloud, shared, folders }));
  } catch {
    // Only a head start; the next listing fills it in.
  }
}

/** What this browser has for `user` (null: signed out): instant, and all there is offline. */
export async function loadLocalLibrary(user: User | null): Promise<{ entries: LibraryEntry[]; shared: CloudDocument[]; folders: Folder[] }> {
  const cached = readCatalogue(user);
  const local = ownedBy(await listSaved().catch(() => []), user?.id ?? null);
  // Signed in, the folders are the account's; otherwise they are this browser's.
  const folders = user ? (cached?.folders ?? []) : await listLocalFolders().catch(() => []);
  return { entries: mergeLibrary(local, cached?.cloud ?? null), shared: cached?.shared ?? [], folders };
}

/**
 * The documents to show for `user` (null: signed out, or signed in without sync). Signed in, copies
 * of documents deleted from the account elsewhere are removed from this browser on the way.
 * `identity` is who is signed in: without sync they still see what subscribers shared with them.
 */
export async function loadLibrary(user: User | null, identity: User | null = user): Promise<Library> {
  const local = ownedBy(await listSaved().catch(() => []), user?.id ?? null);
  if (!user) {
    const shared = identity ? await listShared().catch(() => []) : [];
    return { entries: mergeLibrary(local, null), cloudProblem: null, signedOut: false, shared, folders: await listLocalFolders().catch(() => []) };
  }

  let cloud: CloudDocument[];
  try {
    cloud = await listDocuments();
  } catch (error) {
    const signedOut = error instanceof CloudError && error.status === 401;
    const problem = signedOut ? t('app.signedOutProblem') : t('app.cloudUnreachable', { message: (error as Error).message });
    return { entries: mergeLibrary(local, null), cloudProblem: problem, signedOut, shared: [], folders: readCatalogue(user)?.folders ?? [] };
  }

  const gone = deletedElsewhere(local, cloud);
  for (const l of gone) await deleteSaved(l.id).catch(() => {});
  const kept = gone.length ? local.filter((l) => !gone.includes(l)) : local;
  // Not worth failing the dashboard over.
  const shared = await listShared().catch(() => []);
  const folders = await listFolders().catch(() => readCatalogue(user)?.folders ?? []);
  writeCatalogue(user, cloud, shared, folders);
  return { entries: mergeLibrary(kept, cloud), cloudProblem: null, signedOut: false, shared, folders };
}
