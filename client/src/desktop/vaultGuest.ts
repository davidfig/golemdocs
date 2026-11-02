// The vault's other side when nobody is signed in: the documents saved in this browser (storage/local.ts, the ones made
// while signed out), with the folders kept here. It answers the same `VaultCloud` questions as the account does (vaultHost.ts),
// so the sync, the plan and the file codec are the same either way; only where the documents live differs.
//
// A document replaced by the folder first gets a version in this browser's history, and one deleted from the folder goes to
// this browser's trash (30 days), like the account's.

import type { Folder } from '../folders.ts';
import { deleteLocalFolder, getSaved, keepVersion, listLocalFolders, listSaved, ownedBy, putLocalFolder, saveSaved, setSavedFolder, trashSaved } from '../storage/local.ts';
import { safeName } from './vaultPlan.ts';
import type { VaultCloud } from './vaultSync.ts';

export function guestCloud(): VaultCloud {
  let folders: Folder[] = [];

  async function folderFor(directory: string[]): Promise<string | null> {
    let parent: string | null = null;
    for (const part of directory) {
      const parentId: string | null = parent;
      let found: Folder | undefined = folders.find((f) => f.parentId === parentId && safeName(f.name) === part);
      if (!found) {
        const now = Date.now();
        found = { id: crypto.randomUUID(), name: part, parentId, createdAt: now, updatedAt: now };
        await putLocalFolder(found);
        folders = [...folders, found];
      }
      parent = found.id;
    }
    return parent;
  }

  async function stored(id: string) {
    const found = await getSaved(id);
    if (!found) throw new Error('that document is no longer in this browser');
    return found;
  }

  return {
    async list() {
      folders = await listLocalFolders();
      const docs = ownedBy(await listSaved(), null);
      // This browser keeps no creation time; with all equal, documents are ordered by id, which never changes.
      return { docs: docs.map((d) => ({ id: d.id, name: d.name, folderId: d.folderId ?? null, createdAt: 0, updatedAt: d.updatedAt })), folders };
    },
    download: async (id) => new Uint8Array((await stored(id)).bytes),
    async replace(id, bytes) {
      const { info } = await stored(id);
      return { updatedAt: (await saveSaved({ id, name: info.name, bytes })).updatedAt };
    },
    async create(directory, name, bytes) {
      const folderId = await folderFor(directory);
      const info = await saveSaved({ name, bytes, ...(folderId !== null && { folderId }) });
      return { id: info.id, updatedAt: info.updatedAt };
    },
    async place(id, directory, name) {
      const { info, bytes } = await stored(id);
      if (info.name !== name) await saveSaved({ id, name, bytes });
      await setSavedFolder(id, await folderFor(directory));
    },
    keepVersion: async (id) => void (await keepVersion(id)),
    trash: trashSaved,
    async removeFolder(id) {
      await deleteLocalFolder(id, folders.find((f) => f.id === id)?.parentId ?? null);
      folders = folders.filter((f) => f.id !== id);
    },
  };
}
