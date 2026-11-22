// How encrypted documents and folders show in the library (docs/encrypted-folders.md): the library is listed sealed, as stored, and this is
// the last step before anything shows it. While their keys are open they show with their names opened; while locked, they stay where they
// are, as "Encrypted document" or "Encrypted folder" with a padlock, and opening one asks for the key.

import { isSealedName } from '@golemdocs/ops';
import type { CloudDocument } from '../cloud.ts';
import type { Folder } from '../folders.ts';
import { t } from '../i18n/index.ts';
import type { SavedInfo } from '../storage/local.ts';
import type { LibraryEntry } from '../sync.ts';
import { hasEncrypted, isUnlocked, knowDocuments, knowFolders, knowKey, opens, openSealedName } from './session.ts';

interface Listing {
  entries: LibraryEntry[];
  local: SavedInfo[];
  cloud: CloudDocument[] | null;
  folders: Folder[] | null;
}

/** A name opened, or null if it cannot be (its key is locked, or it is damaged). */
const opened = (name: string): Promise<string | null> => openSealedName(name).catch(() => null);

/** Whether a document is encrypted, by any of what is known of it. */
const isEncrypted = (entry: { local: SavedInfo | null; cloud: CloudDocument | null }): boolean => !!entry.local?.encrypted || !!entry.cloud?.encrypted;
const keyOf = (entry: { local: SavedInfo | null; cloud: CloudDocument | null }): string | undefined => entry.local?.wrappedKey ?? entry.cloud?.wrappedKey;

/** The listing as it should show: encrypted names opened, or placeholders with a padlock while locked. */
export async function presentSealed<T extends Listing>(listing: T): Promise<T> {
  if (listing.folders) knowFolders(listing.folders);
  if (listing.cloud) knowDocuments(listing.cloud);
  for (const l of listing.local) knowKey(l.wrappedKey);
  if (!hasEncrypted() && !listing.entries.some(isEncrypted)) return listing;

  const folders = listing.folders && (await Promise.all(listing.folders.map(presentFolder)));
  const entries: LibraryEntry[] = [];
  const lockedKeys = new Set<string>();
  for (const entry of listing.entries) {
    if (!isEncrypted(entry)) {
      entries.push(entry);
      continue;
    }
    const name = isUnlocked() && (await opens(keyOf(entry))) ? await opened(entry.name) : null;
    if (name === null) {
      entries.push({ ...entry, name: t('encryption.lockedDocument'), locked: true, encrypted: true });
      lockedKeys.add(entry.key);
      continue;
    }
    entries.push({
      ...entry,
      name,
      encrypted: true,
      local: entry.local && { ...entry.local, name: (await opened(entry.local.name)) ?? name },
      cloud: entry.cloud && { ...entry.cloud, name: (await opened(entry.cloud.name)) ?? name },
    });
  }
  // The copies and the account's list the entries came from: what is locked is left out of those, so nothing reads it by mistake.
  const lockedEntry = (e: LibraryEntry) => lockedKeys.has(e.key);
  const lockedLocal = new Set(listing.entries.filter(lockedEntry).flatMap((e) => (e.local ? [e.local.id] : [])));
  const lockedCloud = new Set(listing.entries.filter(lockedEntry).flatMap((e) => (e.cloud ? [e.cloud.id] : [])));
  return {
    ...listing,
    entries,
    folders,
    local: listing.local.filter((l) => !lockedLocal.has(l.id)),
    cloud: listing.cloud && listing.cloud.filter((d) => !lockedCloud.has(d.id)),
  };
}

async function presentFolder(folder: Folder): Promise<Folder> {
  if (!folder.encrypted) return folder;
  const open = isUnlocked() && (await opens(folder.wrappedKey));
  // Only the folder that was encrypted has a readable name; inside it, a folder's is sealed.
  if (!isSealedName(folder.name)) return { ...folder, locked: !open };
  const name = open ? await opened(folder.name) : null;
  return name === null ? { ...folder, name: t('encryption.lockedFolder'), locked: true } : { ...folder, name, locked: false };
}
