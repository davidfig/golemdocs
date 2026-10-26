// The real `VaultHost`: the folder through the native bridge, the account through cloud.ts, the converter that
// is handed in (convertClient.ts: another thread). Kept apart from vaultSync.ts so that file runs in tests with nothing but memory.

import { createDocument, deleteDocuments, downloadDocument, listDocuments, listFolders, moveDocuments, putFolders, renameCloudDocument, saveCloudVersion, saveDocument, throwIfFailed } from '../cloud.ts';
import type { Folder } from '../folders.ts';
import type { DesktopBridge } from './bridge.ts';
import { safeName } from './vaultPlan.ts';
import { guestCloud } from './vaultGuest.ts';
import { vaultMemory } from './vaultMemory.ts';
import { GUEST_ACCOUNT, type VaultCloud, type VaultCodec, type VaultHost } from './vaultSync.ts';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The account's documents as the vault sees them, with folders found (or made) by the names they have on disk. */
export function accountCloud(): VaultCloud {
  let folders: Folder[] = [];

  async function folderFor(directory: string[]): Promise<string | undefined> {
    let parent: string | null = null;
    for (const part of directory) {
      const parentId: string | null = parent;
      let found: Folder | undefined = folders.find((f) => (f.parentId ?? null) === parentId && safeName(f.name) === part);
      if (!found) {
        const made: Folder = { id: crypto.randomUUID(), name: part, parentId, createdAt: Date.now(), updatedAt: Date.now() };
        throwIfFailed(await putFolders([{ id: made.id, name: part, parentId }]));
        folders = [...folders, made];
        found = made;
      }
      parent = found.id;
    }
    return parent ?? undefined;
  }

  return {
    async list() {
      const [docs, theirs] = await Promise.all([listDocuments(), listFolders()]);
      folders = theirs;
      return { docs, folders: theirs };
    },
    download: async (id) => new Uint8Array(await downloadDocument(id)),
    // No `base`: the file in the vault wins, and `keepVersion` has already kept what it replaces.
    replace: async (id, bytes) => ({ updatedAt: (await saveDocument(id, bytes)).updatedAt }),
    async create(directory, name, bytes) {
      const doc = await createDocument(name, bytes, await folderFor(directory));
      return { id: doc.id, updatedAt: doc.updatedAt };
    },
    async place(id, directory, name) {
      await renameCloudDocument(id, name);
      throwIfFailed(await moveDocuments([id], (await folderFor(directory)) ?? null));
    },
    keepVersion: async (id) => void (await saveCloudVersion(id)),
    async trash(id) {
      throwIfFailed(await deleteDocuments([id]));
    },
  };
}

/** The host of the vault at `root` for the signed-in account, or (null) for the documents saved in this browser. */
export function realHost(root: string, disk: DesktopBridge, codec: VaultCodec, account: string | null): VaultHost {
  return { disk, memory: vaultMemory(root), cloud: account ? accountCloud() : guestCloud(), codec, hash: sha256Hex, account: account ?? GUEST_ACCOUNT };
}
