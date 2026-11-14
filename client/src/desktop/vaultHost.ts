// The real `VaultHost`: the folder through the native bridge, the account through cloud.ts, the converter that
// is handed in (convertClient.ts: another thread). Kept apart from vaultSync.ts so that file runs in tests with nothing but memory.

import { createDocument, deleteDocuments, downloadDocument, listDocuments, listFolders, moveDocuments, putFolders, removeFolders, renameCloudDocument, saveCloudVersion, saveDocument, throwIfFailed } from '../cloud.ts';
import type { Folder } from '../folders.ts';
import { keepSyncedCopy } from '../library.ts';
import type { DesktopBridge } from './bridge.ts';
import { safeName } from './vaultPlan.ts';
import { guestCloud } from './vaultGuest.ts';
import { vaultMemory } from './vaultMemory.ts';
import { GUEST_ACCOUNT, type VaultCloud, type VaultCodec, type VaultHost } from './vaultSync.ts';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Keeps what the account stores for a document, as the sync just sent or fetched it, as this browser's copy (`keepSyncedCopy`),
 * so opening a file that changed in the vault needs no download. Never fails the sync: the copy is only a head start.
 */
export type KeepCopy = (cloud: { id: string; name: string; updatedAt: number }, bytes: Uint8Array) => Promise<void>;

/** The account's documents as the vault sees them, with folders found (or made) by the names they have on disk. */
export function accountCloud(keep: KeepCopy = async () => {}): VaultCloud {
  let folders: Folder[] = [];
  /** Each document's name and time in the account, from the last listing, for keeping a copy of what is downloaded. */
  const listed = new Map<string, { name: string; updatedAt: number }>();
  // A copy of the bytes: the converter takes the ones it is given to its own thread.
  const kept = (cloud: { id: string; name: string; updatedAt: number }, bytes: Uint8Array) => keep(cloud, bytes.slice()).catch(() => {});

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
      listed.clear();
      for (const doc of docs) listed.set(doc.id, { name: doc.name, updatedAt: doc.updatedAt });
      return { docs, folders: theirs };
    },
    async download(id) {
      const bytes = new Uint8Array(await downloadDocument(id));
      const doc = listed.get(id);
      if (doc) await kept({ id, ...doc }, bytes);
      return bytes;
    },
    // No `base`: the file in the vault wins, and `keepVersion` has already kept what it replaces.
    async replace(id, bytes) {
      const { updatedAt } = await saveDocument(id, bytes);
      const name = listed.get(id)?.name;
      if (name !== undefined) {
        listed.set(id, { name, updatedAt });
        await kept({ id, name, updatedAt }, bytes);
      }
      return { updatedAt };
    },
    async create(directory, name, bytes) {
      const doc = await createDocument(name, bytes, await folderFor(directory));
      listed.set(doc.id, { name: doc.name, updatedAt: doc.updatedAt });
      await kept({ id: doc.id, name: doc.name, updatedAt: doc.updatedAt }, bytes);
      return { id: doc.id, updatedAt: doc.updatedAt };
    },
    async place(id, directory, name) {
      await renameCloudDocument(id, name);
      const doc = listed.get(id);
      if (doc) listed.set(id, { ...doc, name });
      throwIfFailed(await moveDocuments([id], (await folderFor(directory)) ?? null));
    },
    keepVersion: async (id) => void (await saveCloudVersion(id)),
    async trash(id) {
      throwIfFailed(await deleteDocuments([id]));
    },
    makeFolder: async (directory) => void (await folderFor(directory)),
    async removeFolder(id) {
      throwIfFailed(await removeFolders([id]));
      folders = folders.filter((f) => f.id !== id);
    },
  };
}

/**
 * The host of the vault at `root` for the signed-in account, or (null) for the documents saved in this browser. Signed in, what the
 * sync sends or fetches is kept as this browser's copy too, except for the document open in the editor (`open`, its id in this
 * browser): the page puts the new content into that one itself, once the sync is done (see `VaultHooks.changed`).
 */
export function realHost(root: string, disk: DesktopBridge, codec: VaultCodec, account: string | null, open: () => string | null = () => null): VaultHost {
  const keep: KeepCopy = async (cloud, bytes) => {
    if (account) await keepSyncedCopy(cloud, bytes, account, open());
  };
  return { disk, memory: vaultMemory(root), cloud: account ? accountCloud(keep) : guestCloud(), codec, hash: sha256Hex, account: account ?? GUEST_ACCOUNT };
}
