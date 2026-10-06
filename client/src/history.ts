// A document's history as the app shows it: the versions kept in this browser (storage/local.ts) and, for a document in the account, those the
// account kept (cloud.ts), as one list. Restoring never overwrites anything: it makes a new document, so nothing is ever lost by looking back.

import { CloudError, deleteCloudVersion, listCloudVersions, nameCloudVersion, restoreCloudVersion, saveCloudVersion, type CloudDocument } from './cloud.ts';
import { deleteVersion, getVersion, keepVersion, listVersions, nameVersion } from './storage/local.ts';

/** Where a kept version is: this browser's own history, or the account's. */
export type HistorySource = 'device' | 'account';

export interface HistoryEntry {
  source: HistorySource;
  /** The document's `updatedAt` as it was: its identity within its source, and the moment it was saved. */
  version: number;
  size: number;
  name: string | null;
}

/** The open document, as history knows it. */
export interface HistoryTarget {
  /** Its copy in this browser. */
  localId: string | null;
  /** Its document in the account, if there is one (and the account has sync). */
  cloudId: string | null;
}

/** What `loadHistory` needs; the app gives the real ones, a test gives fakes. */
export interface HistoryDeps {
  listLocal(id: string): Promise<{ version: number; size: number; name: string | null }[]>;
  listCloud(id: string): Promise<{ version: number; size: number; name: string | null }[]>;
}

const realDeps: HistoryDeps = { listLocal: listVersions, listCloud: listCloudVersions };

/**
 * Every kept version of the document, newest first: this browser's and the account's together. A source that cannot be reached
 * (offline, no subscription) is left out and reported in `unreachable`; the other still shows.
 */
export async function loadHistory(target: HistoryTarget, deps: HistoryDeps = realDeps): Promise<{ entries: HistoryEntry[]; unreachable: HistorySource[] }> {
  const unreachable: HistorySource[] = [];
  const [device, account] = await Promise.all([
    target.localId ? deps.listLocal(target.localId).catch(() => (unreachable.push('device'), [])) : [],
    target.cloudId ? deps.listCloud(target.cloudId).catch(() => (unreachable.push('account'), [])) : [],
  ]);
  const entries: HistoryEntry[] = [...device.map((v) => ({ version: v.version, size: v.size, name: v.name, source: 'device' as const })), ...account.map((v) => ({ version: v.version, size: v.size, name: v.name, source: 'account' as const }))];
  entries.sort((a, b) => b.version - a.version || (a.source === 'account' ? -1 : 1));
  return { entries, unreachable };
}

/** The name a restored document is given: the document's own, with when the version was saved. */
export function restoredName(name: string, version: number, locale?: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const when = new Date(version).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return `${stem} (${when})${ext}`;
}

/** Keeps the document as it is now as a named version, in this browser and in the account when it has a copy there. */
export async function saveNamedVersion(target: HistoryTarget, name: string): Promise<void> {
  if (target.localId) await keepVersion(target.localId, name);
  if (target.cloudId) {
    await saveCloudVersion(target.cloudId, name).catch((error: unknown) => {
      // An account without sync, or a document that cannot be saved to just now (several people editing it) has nothing to keep there: this browser's copy stands.
      if (!(error instanceof CloudError) || ![402, 403, 404, 423].includes(error.status)) throw error;
    });
  }
}

export async function renameEntry(target: HistoryTarget, entry: HistoryEntry, name: string | null): Promise<void> {
  if (entry.source === 'device') await nameVersion(target.localId!, entry.version, name);
  else await nameCloudVersion(target.cloudId!, entry.version, name);
}

export async function deleteEntry(target: HistoryTarget, entry: HistoryEntry): Promise<void> {
  if (entry.source === 'device') await deleteVersion(target.localId!, entry.version);
  else await deleteCloudVersion(target.cloudId!, entry.version);
}

/** The bytes of a version kept in this browser (null if they are gone). */
export const deviceVersionBytes = getVersion;

/** The account makes the new document itself, from the version, without it being downloaded and uploaded again. */
export function restoreFromAccount(target: HistoryTarget, entry: HistoryEntry, name: string): Promise<CloudDocument> {
  return restoreCloudVersion(target.cloudId!, entry.version, name);
}
