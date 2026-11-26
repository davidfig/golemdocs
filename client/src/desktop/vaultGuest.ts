// The vault's other side when nobody is signed in: the documents saved in this browser (storage/local.ts, the ones made
// while signed out), with the folders kept here. It answers the same `VaultCloud` questions as the account does (vaultHost.ts),
// so the sync, the plan and the file codec are the same either way; only where the documents live differs.
//
// A document replaced by the folder first gets a version in this browser's history, and one deleted from the folder goes to
// this browser's trash (30 days), like the account's.

import { openNames, withoutEncrypted } from './vaultEncrypted.ts';
import { decryptedInVault, documentInVault, isEncryptedFolder, newKey, rememberInVault, sealNameWith } from '../encryption/session.ts';
import { encryptDocument } from '../encryption/convert.ts';
import type { Folder } from '../folders.ts';
import { deleteLocalFolder, getSaved, keepVersion, listLocalFolders, listSaved, ownedBy, putLocalFolder, saveSaved, setSavedFolder, trashSaved, updateLocalFolder } from '../storage/local.ts';
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
        // Inside an encrypted folder (decrypted into the vault), a folder is encrypted too: its own key, its name kept sealed.
        if (folders.find((f) => f.id === parentId)?.encrypted) {
          const wrappedKey = await newKey();
          found = { ...found, encrypted: true, wrappedKey };
          await putLocalFolder({ ...found, name: await sealNameWith(wrappedKey, part) });
        } else await putLocalFolder(found);
        folders = [...folders, found];
      }
      parent = found.id;
    }
    return parent;
  }

  /** The folder at a vault path, without making any. */
  function folderAt(directory: string[]): Folder | undefined {
    let found: Folder | undefined;
    for (const part of directory) {
      const parentId = found?.id ?? null;
      found = folders.find((f) => (f.parentId ?? null) === parentId && safeName(f.name) === part);
      if (!found) return undefined;
    }
    return found;
  }

  async function stored(id: string) {
    const found = await getSaved(id);
    if (!found) throw new Error('that document is no longer in this browser');
    return found;
  }

  return {
    async list() {
      // Encrypted documents and folders are not in the vault (vaultEncrypted.ts, docs/encrypted-folders.md), unless decrypted into it
      // for this session: then they are, with their names opened (storage seals what comes back, and opens what goes out).
      const shown = withoutEncrypted(ownedBy(await listSaved(), null), await listLocalFolders(), decryptedInVault, documentInVault);
      rememberInVault(shown.decryptedDocs);
      folders = await openNames(shown.folders);
      // This browser keeps no creation time; with all equal, documents are ordered by id, which never changes.
      const docs = (await openNames(shown.docs)).map((d) => ({ id: d.id, name: d.name, folderId: d.folderId ?? null, createdAt: 0, updatedAt: d.updatedAt }));
      return { docs, folders, encrypted: shown.encrypted, notes: shown.notes, encryptedPaths: shown.encryptedPaths, decryptedPaths: shown.decryptedPaths };
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
      const to = await folderFor(directory);
      // An ordinary document moved into an encrypted folder (decrypted into the vault) is encrypted first, as Encrypt… does.
      const before = await stored(id);
      if (!before.info.encrypted && isEncryptedFolder(to)) {
        const { info } = before;
        await encryptDocument({ key: info.id, name: info.name, size: info.size, updatedAt: info.updatedAt, local: info, cloud: null, state: 'local-only', folderId: info.folderId ?? null }, { owner: undefined, cloud: false });
      }
      const { info, bytes } = await stored(id);
      if (info.name !== name) await saveSaved({ id, name, bytes });
      await setSavedFolder(id, to);
    },
    keepVersion: async (id) => void (await keepVersion(id)),
    trash: trashSaved,
    makeFolder: async (directory) => void (await folderFor(directory)),
    async removeFolder(id) {
      await deleteLocalFolder(id, folders.find((f) => f.id === id)?.parentId ?? null);
      folders = folders.filter((f) => f.id !== id);
    },
    async moveFolder(from, to) {
      const folder = folderAt(from);
      // Encrypted folders (decrypted into the vault) are moved document by document, as the account's are.
      if (!folder || !to.length || folderAt(to) || folder.encrypted) return false;
      const parentId = await folderFor(to.slice(0, -1));
      if (parentId !== null && (isEncryptedFolder(parentId) || folders.find((f) => f.id === parentId)?.encrypted)) return false;
      const name = to[to.length - 1];
      if (!(await updateLocalFolder(folder.id, { name, parentId }, Date.now()))) return false;
      folders = folders.map((f) => (f.id === folder.id ? { ...f, name, parentId } : f));
      return true;
    },
  };
}
