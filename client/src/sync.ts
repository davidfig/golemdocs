// What the dashboard shows: the documents saved in this browser and the ones in the user's cloud
// account, matched up, with what needs syncing between them.
//
// Sync is lazy on purpose. Signing in on another computer only fetches the catalogue (names,
// sizes, dates and a link to each thumbnail); a document's bytes are downloaded when it is opened
// (library.ts, and not even then if the browser already has the current version). The only thing
// that moves without being asked is a document that is already linked to the cloud and was changed
// here: its new version is uploaded, since the user chose the cloud for it. Documents that were
// never saved to the cloud stay on this device until the user says otherwise.

import { currentUser, type User } from './auth.ts';
import { CloudError, listDocuments, type CloudDocument } from './cloud.ts';
import { uploadToCloud } from './library.ts';
import { listSaved, type SavedInfo } from './storage/local.ts';

export type SyncState =
  /** Only in this browser. */
  | 'local-only'
  /** Only in the cloud: nothing has been downloaded yet. */
  | 'cloud-only'
  | 'synced'
  /** Edited here since the last sync; the cloud copy is unchanged. */
  | 'local-ahead'
  /** Edited elsewhere; this browser's copy is unchanged (it's refreshed when opened). */
  | 'cloud-ahead'
  /** Edited in both places. Nothing is overwritten; opening it opens this browser's copy. */
  | 'conflict'
  /** Linked to the cloud, but the cloud can't be reached (signed out, offline). */
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
}

/** How a browser copy and its cloud copy relate. `cloud` is null when it's missing or unknown. */
export function classify(local: SavedInfo | null, cloud: CloudDocument | null, cloudKnown: boolean): SyncState {
  if (!local) return 'cloud-only';
  if (!local.cloudId) return 'local-only';
  if (!cloudKnown) return 'unknown';
  if (!cloud) return 'local-only'; // deleted from the cloud elsewhere; saving to the cloud again recreates it
  const localChanged = local.updatedAt > (local.cloudSyncedAt ?? 0);
  // Copies linked before the cloud's date was recorded count as unchanged there.
  const cloudChanged = local.cloudUpdatedAt !== undefined && cloud.updatedAt !== local.cloudUpdatedAt;
  if (localChanged && cloudChanged) return 'conflict';
  if (localChanged) return 'local-ahead';
  if (cloudChanged) return 'cloud-ahead';
  return 'synced';
}

/** Pairs browser copies with cloud documents (`cloud` null: not signed in or unreachable), newest first. */
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
    });
  }
  for (const c of cloud ?? []) {
    if (linked.has(c.id)) continue;
    entries.push({ key: c.id, name: c.name, size: c.size, updatedAt: c.updatedAt, local: null, cloud: c, state: 'cloud-only' });
  }
  return entries.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** Uploads the cloud-linked documents that were edited here. Returns how many were sent. */
export async function pushLinked(entries: readonly LibraryEntry[], upload: (localId: string) => Promise<unknown> = uploadToCloud): Promise<number> {
  let sent = 0;
  for (const entry of entries) {
    if (entry.state !== 'local-ahead' || !entry.local || !entry.cloud) continue;
    try {
      await upload(entry.local.id);
      sent++;
    } catch {
      // Stays "local-ahead"; the next visit tries again.
    }
  }
  return sent;
}

export interface Library {
  entries: LibraryEntry[];
  /** Who is signed in, or null. */
  user: User | null;
  /** Why the cloud's documents aren't listed even though someone is signed in. */
  cloudProblem: string | null;
}

/** Documents saved in this browser only: instant, and all there is while signed out or offline. */
export async function loadLocalLibrary(): Promise<LibraryEntry[]> {
  return mergeLibrary(await listSaved().catch(() => []), null);
}

/** Both sides, matched up, after sending any edits to cloud-linked documents. */
export async function loadLibrary(): Promise<Library> {
  const local = await listSaved().catch(() => []);
  const user = await currentUser().catch(() => null);
  if (!user) return { entries: mergeLibrary(local, null), user: null, cloudProblem: null };

  let cloud: CloudDocument[];
  try {
    cloud = await listDocuments();
  } catch (error) {
    const signedOut = error instanceof CloudError && error.status === 401;
    return {
      entries: mergeLibrary(local, null),
      user: signedOut ? null : user,
      cloudProblem: signedOut ? null : `Your cloud documents can’t be listed right now (${(error as Error).message}).`,
    };
  }

  let entries = mergeLibrary(local, cloud);
  if (await pushLinked(entries)) {
    // Uploading changed the browser copies' sync marks and the cloud's dates.
    const [freshLocal, freshCloud] = await Promise.all([listSaved().catch(() => local), listDocuments().catch(() => cloud)]);
    entries = mergeLibrary(freshLocal, freshCloud);
  }
  return { entries, user, cloudProblem: null };
}
