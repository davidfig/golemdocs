// Changes to the folder hierarchy. Signed in with sync, the folders are the account's (and a change
// is made there first, so it only happens if it is saved); otherwise they are this browser's.

import { deleteFolder, listFolders, moveDocument, putFolder } from './cloud.ts';
import { folderContents, parentsFirst, type Folder } from './folders.ts';
import { deleteLocalFolder, listLocalFolders, putLocalFolder, removeLocalFolderRecord, setSavedFolder } from './storage/local.ts';
import type { LibraryEntry } from './sync.ts';

/** A new folder, in `parentId` (null: the top level). */
export async function createFolder(cloud: boolean, name: string, parentId: string | null): Promise<Folder> {
  const now = Date.now();
  const folder: Folder = { id: crypto.randomUUID(), name, parentId, createdAt: now, updatedAt: now };
  if (cloud) return putFolder(folder);
  await putLocalFolder(folder);
  return folder;
}

/** Renames and/or moves a folder (`parentId` null: to the top level). */
export async function updateFolder(cloud: boolean, folder: Folder, change: { name?: string; parentId?: string | null }): Promise<Folder> {
  const next: Folder = { ...folder, ...change, updatedAt: Date.now() };
  if (cloud) return putFolder(next);
  await putLocalFolder(next);
  return next;
}

/** Deletes a folder record only; what is in it moves up to where the folder was (the caller deletes contents first to remove them). */
export async function removeFolder(cloud: boolean, folder: Folder): Promise<void> {
  if (cloud) await deleteFolder(folder.id);
  // Copies kept in this browser (those not yet uploaded) follow, in either case.
  await deleteLocalFolder(folder.id, folder.parentId);
}

/** Deletes a folder with everything in it: its documents (through `deleteEntry`) and its subfolders. */
export async function removeFolderTree(cloud: boolean, folders: readonly Folder[], entries: readonly LibraryEntry[], folder: Folder, deleteEntry: (entry: LibraryEntry) => Promise<void>): Promise<void> {
  const inside = folderContents(folders, entries, folder);
  for (const entry of inside.items) await deleteEntry(entry);
  for (const f of inside.folders) await removeFolder(cloud, f);
}

/** Moves a document to a folder (null: the top level). */
export async function moveEntry(entry: LibraryEntry, folderId: string | null): Promise<void> {
  if (entry.cloud) await moveDocument(entry.cloud.id, folderId);
  if (entry.local) await setSavedFolder(entry.local.id, folderId);
}

/**
 * Sends the folders made while signed out to the account that has just signed in, so the documents
 * made with them keep their places. Whatever can't be sent stays here for next time.
 */
export async function adoptGuestFolders(): Promise<void> {
  const mine = await listLocalFolders();
  if (!mine.length) return;
  const theirs = new Set((await listFolders()).map((f) => f.id));
  for (const folder of parentsFirst(mine)) {
    if (!theirs.has(folder.id)) await putFolder(folder);
    await removeLocalFolderRecord(folder.id);
  }
}
