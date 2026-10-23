// Changes to the folder hierarchy. Signed in with sync, the folders are the account's (and a change
// is made there first, so it only happens if it is saved); otherwise they are this browser's.

import { listFolders, moveDocuments, putFolders, renameCloudDocument, throwIfFailed, type BatchResult } from './cloud.ts';
import { folderContents, folderOf, folderPath, isInside, parentsFirst, type Folder } from './folders.ts';
import { deleteLocalFolder, listLocalFolders, putLocalFolder, removeLocalFolderRecord, setSavedFolder, setSavedName, updateLocalFolder } from './storage/local.ts';
import type { LibraryChange } from './linkRename.ts';
import { addFoldersToCatalogue, moveDocsInCatalogue, putDocInCatalogue, updateFoldersInCatalogue, type LibraryEntry } from './sync.ts';

/** Folders that were not saved by a batch call (the cloud's answer for each), as an error naming the first reason. */
/**
 * Told before each rename or move of folders and documents: it returns what to call once the change is made, to keep the links to
 * what moved working (main.ts sets it; see linkRename.ts). Not awaited: the links are written in the background.
 */
let linkKeeper: ((change: LibraryChange) => () => void) | null = null;
export function setLinkKeeper(keeper: typeof linkKeeper): void {
  linkKeeper = keeper;
}

function saved<T extends { id: string }>(result: BatchResult<T>): T[] {
  throwIfFailed(result);
  return result.ok;
}

/** New folders, each in its `parentId` (null: the top level); in order, so one may go inside another made earlier in the list. */
export async function createFolders(cloud: boolean, wanted: readonly { name: string; parentId: string | null; id?: string }[]): Promise<Folder[]> {
  const now = Date.now();
  const folders: Folder[] = wanted.map((w) => ({ id: w.id ?? crypto.randomUUID(), name: w.name, parentId: w.parentId, createdAt: now, updatedAt: now }));
  if (cloud) {
    // The Files panel lists from the cached catalogue first: without the folders, they (and what is put in them) would vanish until the account answers.
    const done = saved(await putFolders(folders));
    addFoldersToCatalogue(done);
    return done;
  }
  for (const folder of folders) await putLocalFolder(folder);
  return folders;
}

/** A new folder, in `parentId` (null: the top level). */
export async function createFolder(cloud: boolean, name: string, parentId: string | null): Promise<Folder> {
  return (await createFolders(cloud, [{ name, parentId }]))[0]!;
}

/**
 * Renames and/or moves folders (`parentId` null: to the top level), in one request when they are the
 * account's. Only what changes is sent: `folder` may be an old copy (from a list shown before the
 * folder was changed elsewhere), and the rest of it would undo that change.
 */
export async function updateFolders(cloud: boolean, changes: readonly { folder: Folder; name?: string; parentId?: string | null }[]): Promise<Folder[]> {
  const now = Date.now();
  const linksAfter = linkKeeper?.({ kind: 'folders', changes: changes.map(({ folder, name, parentId }) => ({ id: folder.id, name, parentId })) });
  if (cloud) {
    const done = saved(await putFolders(changes.map(({ folder, name, parentId }) => ({ id: folder.id, name, parentId }))));
    updateFoldersInCatalogue(done);
    linksAfter?.();
    return done;
  }
  const next: Folder[] = [];
  for (const { folder, ...change } of changes) next.push((await updateLocalFolder(folder.id, change, now)) ?? { ...folder, ...change, updatedAt: now });
  linksAfter?.();
  return next;
}

/** Renames and/or moves a folder. */
export async function updateFolder(cloud: boolean, folder: Folder, change: { name?: string; parentId?: string | null }): Promise<Folder> {
  return (await updateFolders(cloud, [{ folder, ...change }]))[0]!;
}

/** The folders and documents left once `targets` (with everything in them) and `docs` are gone, to show a delete before it is saved. */
export function withoutDeleted(folders: readonly Folder[], entries: readonly LibraryEntry[], targets: readonly Folder[], docs: readonly LibraryEntry[] = []): { folders: Folder[]; entries: LibraryEntry[] } {
  const goneFolders = new Set<string>();
  const goneEntries = new Set<LibraryEntry>(docs);
  for (const target of targets) {
    const inside = folderContents(folders, entries, target);
    for (const f of inside.folders) goneFolders.add(f.id);
    for (const entry of inside.items) goneEntries.add(entry);
  }
  return { folders: folders.filter((f) => !goneFolders.has(f.id)), entries: entries.filter((e) => !goneEntries.has(e)) };
}

/**
 * Deletes folders with everything in them: `deleteEntries` is called once with all their documents and
 * all the folders (the account deletes both in one request). A folder inside another one being deleted
 * goes with it, once. The copies of the folders kept in this browser go too.
 */
export async function removeFolderTree(folders: readonly Folder[], entries: readonly LibraryEntry[], targets: readonly Folder[], deleteEntries: (entries: LibraryEntry[], folderIds: string[]) => Promise<void>): Promise<void> {
  const doomed = new Map<string, Folder>();
  const items = new Set<LibraryEntry>();
  for (const target of targets) {
    const inside = folderContents(folders, entries, target);
    for (const f of inside.folders) doomed.set(f.id, f);
    for (const entry of inside.items) items.add(entry);
  }
  await deleteEntries([...items], [...doomed.keys()]);
  // Deepest first, so each folder is removed before the one it is in.
  const depth = (f: Folder) => folderPath(folders, f.id).length;
  for (const folder of [...doomed.values()].sort((a, b) => depth(b) - depth(a))) await deleteLocalFolder(folder.id, folder.parentId);
}

/** A document or folder being dragged, in the Files Sidebar or on the Documents screen. */
export type Dragged = { kind: 'doc'; entry: LibraryEntry } | { kind: 'folder'; folder: Folder };

/** Whether `item` can be dropped in folder `to` (null: the top level): somewhere it isn't already, and a folder never inside itself. */
export function canDrop(folders: readonly Folder[], item: Dragged, to: string | null): boolean {
  if (item.kind === 'doc') return folderOf(item.entry, folders) !== to;
  return item.folder.parentId !== to && to !== item.folder.id && !isInside(folders, to, item.folder.id);
}

/**
 * `entries`, with those in `moved` (matched by key) now in folder `to`: new objects, to show a move
 * before it is saved. The entries on screen aren't changed in place, as a list fetched meanwhile may
 * already have replaced them (and the change would then be lost from view).
 */
export function withMoved(entries: readonly LibraryEntry[], moved: readonly LibraryEntry[], to: string | null): LibraryEntry[] {
  const keys = new Set(moved.map((e) => e.key));
  return entries.map((entry) => {
    if (!keys.has(entry.key)) return entry;
    const local = entry.local && { ...entry.local, folderId: to ?? undefined };
    if (local && to === null) delete local.folderId;
    return { ...entry, folderId: to, cloud: entry.cloud && { ...entry.cloud, folderId: to }, local };
  });
}

/** Moves documents to a folder (null: the top level); the account's in one request. */
export async function moveEntries(entries: readonly LibraryEntry[], folderId: string | null): Promise<void> {
  const cloudIds = entries.flatMap((e) => (e.cloud ? [e.cloud.id] : []));
  const linksAfter = linkKeeper?.({ kind: 'move', keys: entries.map((e) => e.key), to: folderId });
  const result = cloudIds.length ? await moveDocuments(cloudIds, folderId) : { ok: [], failed: [] };
  // What did move is recorded, here too, even when some did not (and that is then reported).
  const refused = new Set(result.failed.map((f) => f.id));
  if (result.ok.length) moveDocsInCatalogue(result.ok, folderId);
  for (const entry of entries) if (entry.local && !(entry.cloud && refused.has(entry.cloud.id))) await setSavedFolder(entry.local.id, folderId);
  // Links are only written for a move that all happened.
  if (!result.failed.length) linksAfter?.();
  throwIfFailed(result);
}

/**
 * Renames a document that is not open (the open one is renamed through the editor, which saves it under the new name). The
 * account's copy is renamed first, so nothing changes here unless it is saved there; the name is all that changes.
 */
export async function renameEntry(entry: LibraryEntry, name: string): Promise<void> {
  const linksAfter = linkKeeper?.({ kind: 'rename', key: entry.key, name });
  // A copy linked to the account is renamed there too, even when the account's list hasn't come yet.
  const cloudId = entry.cloud?.id ?? entry.local?.cloudId;
  if (cloudId) putDocInCatalogue(await renameCloudDocument(cloudId, name));
  if (entry.local) await setSavedName(entry.local.id, name);
  linksAfter?.();
}

/**
 * Sends the folders made while signed out to the account that has just signed in, so the documents
 * made with them keep their places. Whatever can't be sent stays here for next time.
 */
export async function adoptGuestFolders(): Promise<void> {
  const mine = await listLocalFolders();
  if (!mine.length) return;
  const theirs = new Set((await listFolders()).map((f) => f.id));
  // Parents first, in one request; those the account refused stay here for next time.
  const result = await putFolders(parentsFirst(mine).filter((f) => !theirs.has(f.id)));
  addFoldersToCatalogue(result.ok);
  const refused = new Set(result.failed.map((f) => f.id));
  for (const folder of mine) if (!refused.has(folder.id)) await removeLocalFolderRecord(folder.id);
}
