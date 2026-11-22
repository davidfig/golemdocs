// The real `VaultHost`: the folder through the native bridge, the account through cloud.ts, the converter that
// is handed in (convertClient.ts: another thread). Kept apart from vaultSync.ts so that file runs in tests with nothing but memory.

import { createDocument, createInSharedFolder, deleteDocuments, deleteSharedDocument, deleteSharedSubfolder, downloadDocument, listDocuments, listFolders, listSharedFolders, moveDocuments, putFolders, putSharedSubfolder, removeFolders, renameCloudDocument, saveCloudVersion, saveDocument, setSharedFolderLabel, sharedFolderTree, throwIfFailed } from '../cloud.ts';
import type { Folder } from '../folders.ts';
import { keepSyncedCopy } from '../library.ts';
import type { DesktopBridge } from './bridge.ts';
import { safeName } from './vaultPlan.ts';
import { guestCloud } from './vaultGuest.ts';
import { openNames, withoutEncrypted } from './vaultEncrypted.ts';
import { decryptedInVault, documentInVault, newKey, openSealedFile, rememberInVault, sealFileWith, sealNameWith } from '../encryption/session.ts';
import { encryptAccountDocument } from '../encryption/convert.ts';
import type { CloudDocument } from '../cloud.ts';
import type { SharedApi } from './vaultShared.ts';
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
export function accountCloud(keep: KeepCopy = async () => {}, owner = ''): VaultCloud {
  let folders: Folder[] = [];
  /** The account's documents as listed (sealed), for encrypting one the vault moves into an encrypted folder. */
  const accountDocs = new Map<string, CloudDocument>();
  /** Each document's name and time in the account, from the last listing, for keeping a copy of what is downloaded. */
  const listed = new Map<string, { name: string; updatedAt: number }>();
  /**
   * The encrypted documents' keys, from the last listing: what the vault writes of one (decrypted into it for this session) is opened, and
   * what it sends back is sealed, as is a file it still had for one.
   */
  const sealedKeys = new Map<string, string>();
  /** The encrypted folders, from the last listing: a document or folder the vault makes in one is encrypted (docs/encrypted-folders.md). */
  const sealedFolders = new Set<string>();
  // A copy of the bytes: the converter takes the ones it is given to its own thread.
  const kept = (cloud: { id: string; name: string; updatedAt: number }, bytes: Uint8Array) => keep(cloud, bytes.slice()).catch(() => {});

  async function folderFor(directory: string[]): Promise<string | undefined> {
    let parent: string | null = null;
    for (const part of directory) {
      const parentId: string | null = parent;
      let found: Folder | undefined = folders.find((f) => (f.parentId ?? null) === parentId && safeName(f.name) === part);
      if (!found) {
        const made: Folder = { id: crypto.randomUUID(), name: part, parentId, createdAt: Date.now(), updatedAt: Date.now() };
        // Inside an encrypted folder (decrypted into the vault), a folder is encrypted too, with its own key; its name goes sealed (cloud.ts).
        const sealed = parentId !== null && sealedFolders.has(parentId) ? { encrypted: true, wrappedKey: await newKey() } : {};
        throwIfFailed(await putFolders([{ id: made.id, name: part, parentId, ...sealed }]));
        if (sealed.encrypted) sealedFolders.add(made.id);
        folders = [...folders, made];
        found = made;
      }
      parent = found.id;
    }
    return parent ?? undefined;
  }

  return {
    async list() {
      const [all, every] = await Promise.all([listDocuments(), listFolders()]);
      // Encrypted documents and folders are never in the vault: their files would be decrypted on disk, outliving the session
      // (vaultEncrypted.ts, docs/encrypted-folders.md).
      // An encrypted folder decrypted into the vault for this session stays in, with its names opened.
      const shown = withoutEncrypted(all, every, decryptedInVault, documentInVault);
      rememberInVault(shown.decryptedDocs);
      const docs = await openNames(shown.docs);
      folders = await openNames(shown.folders);
      listed.clear();
      sealedKeys.clear();
      sealedFolders.clear();
      for (const doc of docs) listed.set(doc.id, { name: doc.name, updatedAt: doc.updatedAt });
      for (const doc of all) if (doc.encrypted && doc.wrappedKey) sealedKeys.set(doc.id, doc.wrappedKey);
      for (const folder of every) if (folder.encrypted) sealedFolders.add(folder.id);
      accountDocs.clear();
      for (const doc of all) accountDocs.set(doc.id, doc);
      return { docs, folders, encrypted: shown.encrypted, notes: shown.notes, encryptedPaths: shown.encryptedPaths, decryptedPaths: shown.decryptedPaths };
    },
    async download(id) {
      const stored = new Uint8Array(await downloadDocument(id));
      // An encrypted document's file is opened for the vault; no copy of it is kept here from the vault's side (it would be readable).
      if (sealedKeys.has(id)) return openSealedFile(stored);
      const bytes = stored;
      const doc = listed.get(id);
      if (doc) await kept({ id, ...doc }, bytes);
      return bytes;
    },
    // No `base`: the file in the vault wins, and `keepVersion` has already kept what it replaces.
    async replace(id, given) {
      // An encrypted document's file goes sealed (the server refuses anything else); while it is locked, this fails and is tried later.
      const key = sealedKeys.get(id);
      const bytes = key ? await sealFileWith(key, given) : given;
      const { updatedAt } = await saveDocument(id, bytes);
      if (key) return { updatedAt };
      const name = listed.get(id)?.name;
      if (name !== undefined) {
        listed.set(id, { name, updatedAt });
        await kept({ id, name, updatedAt }, bytes);
      }
      return { updatedAt };
    },
    async create(directory, name, given) {
      const folderId = await folderFor(directory);
      // Made in an encrypted folder: encrypted from the start, with its own key (the name is sealed by `createDocument`).
      if (folderId && sealedFolders.has(folderId)) {
        const key = await newKey();
        const doc = await createDocument(name, await sealFileWith(key, given), folderId, key);
        sealedKeys.set(doc.id, key);
        return { id: doc.id, updatedAt: doc.updatedAt };
      }
      const bytes = given;
      const doc = await createDocument(name, bytes, folderId);
      listed.set(doc.id, { name: doc.name, updatedAt: doc.updatedAt });
      await kept({ id: doc.id, name: doc.name, updatedAt: doc.updatedAt }, bytes);
      return { id: doc.id, updatedAt: doc.updatedAt };
    },
    async place(id, directory, name) {
      const to = (await folderFor(directory)) ?? null;
      // An ordinary document moved into an encrypted folder (decrypted into the vault) is encrypted first, file, name and versions, as
      // Encrypt… does: an encrypted folder takes only encrypted documents. One moved out stays encrypted (encryption/session.ts).
      let key = sealedKeys.get(id);
      const doc = accountDocs.get(id);
      if (!key && to !== null && sealedFolders.has(to) && doc) {
        key = await encryptAccountDocument(doc, owner);
        sealedKeys.set(id, key);
      }
      await renameCloudDocument(id, key ? await sealNameWith(key, name) : name);
      const listedDoc = listed.get(id);
      if (listedDoc) listed.set(id, { ...listedDoc, name });
      throwIfFailed(await moveDocuments([id], to));
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
  return { disk, memory: vaultMemory(root), cloud: account ? accountCloud(keep, account) : guestCloud(), codec, hash: sha256Hex, account: account ?? GUEST_ACCOUNT };
}

/** The folders shared with the signed-in account, for their copies in the vault (vaultShared.ts), through cloud.ts. */
export function sharedApi(): SharedApi {
  return {
    shares: listSharedFolders,
    tree: sharedFolderTree,
    download: async (id) => new Uint8Array(await downloadDocument(id)),
    save: (id, bytes) => saveDocument(id, bytes),
    keepVersion: async (id) => void (await saveCloudVersion(id)),
    create: (share, folderId, name, bytes) => createInSharedFolder(share.ownerId, folderId, name, bytes),
    rename: async (id, name) => void (await renameCloudDocument(id, name)),
    trash: deleteSharedDocument,
    putFolder: async (share, id, name, parentId) => void (await putSharedSubfolder(share, id, name, parentId)),
    deleteFolder: deleteSharedSubfolder,
    setLabel: setSharedFolderLabel,
    topFolders: async () => (await listFolders()).filter((f) => !f.parentId).map((f) => f.name),
  };
}
