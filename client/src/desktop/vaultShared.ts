// Copies of folders other people shared with this account, in the vault under `Shared/<owner>/<folder>/` (docs/folder-sharing.md,
// "Vault copies"). Each one is kept by its own run of `syncVault`, on a view of the disk that is only its folder (`scopedDisk`), with
// the shared folder as the account (`sharedCloud`) and a memory of its own; the vault's own sync never sees `Shared/` (`outsideDisk`).
//
// The role is kept by the account side, not by the plan: a change the person may not make is not sent, and the sync puts the file
// back. `sharedCloud` does nothing for it and leaves the memory saying so: a file renamed or moved is moved back (the account still
// has it where it was), a file deleted is downloaded again (the account still lists it), and an edit a viewer made is replaced
// (its time in the account is remembered as one it never had, so the account's copy is newer). A second run puts it back at once.
// An editor's new files and folders go up as the owner's, added by them; a viewer's are never sent, never deleted, and counted.
//
// Where a copy is kept is a label (`Alice/Project`), chosen once and kept in the account (`localName`), so neither the owner's name
// changing nor the folder being renamed moves it. A copy whose share ended (left, unshared, the owner's sync over) or that the
// person no longer wants is removed: its files go, including edits not sent yet (the documents are the owner's), and what never
// reached the account stays.

import { cloudPaths, safeName, type CloudDoc, type CloudFolder, type LocalFile } from './vaultPlan.ts';
import { STATE_PATH, syncVault, type SyncReport, type VaultCodec, type VaultDisk, type VaultHost, type VaultMemory } from './vaultSync.ts';

/** Where shared folders are kept in the vault, unless the account has a folder of its own by that name (then `SHARED_ROOTS[1]`). */
export const SHARED_ROOTS = ['Shared', 'Shared with me'] as const;

/** A folder shared with this account, as the account lists it (`listSharedFolders`). */
export interface VaultShare {
  ownerId: string;
  folderId: string;
  name: string;
  role: 'editor' | 'viewer';
  owner: { name: string | null; email: string | null };
  localName: string | null;
}

/** A folder or document in a shared folder (`sharedFolderTree`); the shared folder itself is the folder with no parent. */
export interface ShareTree {
  folders: { id: string; name: string; parentId: string | null; createdByYou: boolean }[];
  documents: { id: string; name: string; folderId: string; createdAt: number; updatedAt: number; createdByYou: boolean }[];
  truncated: boolean;
}

/** What the shared copies need from the account (cloud.ts), so they run in tests in memory. */
export interface SharedApi {
  shares(): Promise<VaultShare[]>;
  tree(share: VaultShare): Promise<ShareTree>;
  download(id: string): Promise<Uint8Array>;
  save(id: string, bytes: Uint8Array): Promise<{ updatedAt: number }>;
  keepVersion(id: string): Promise<void>;
  create(share: VaultShare, folderId: string, name: string, bytes: Uint8Array): Promise<{ id: string; updatedAt: number }>;
  rename(id: string, name: string): Promise<void>;
  trash(id: string): Promise<void>;
  putFolder(share: VaultShare, id: string, name: string, parentId: string): Promise<void>;
  deleteFolder(share: VaultShare, id: string): Promise<void>;
  setLabel(share: VaultShare, label: string): Promise<void>;
  /** The names of the account's own folders at its top level, to keep clear of. */
  topFolders(): Promise<string[]>;
}

const under = (prefix: string) => `${prefix}/`;

/** The part of the disk inside `prefix`, with paths relative to it. It has no `.golemdocs/state.json`: the vault's own says whose it is. */
export function scopedDisk(disk: VaultDisk, prefix: string, keep: (file: LocalFile) => boolean = () => true): VaultDisk {
  const inside = (path: string) => `${prefix}/${path}`;
  return {
    async scan() {
      return (await disk.scan()).filter((f) => f.path.startsWith(under(prefix))).map((f) => ({ ...f, path: f.path.slice(prefix.length + 1) })).filter(keep);
    },
    async read(path) {
      if (path === STATE_PATH) throw new Error('none');
      return disk.read(inside(path));
    },
    async write(path, bytes) {
      return path === STATE_PATH ? 0 : disk.write(inside(path), bytes);
    },
    remove: (path) => disk.remove(inside(path)),
    ...(disk.folders && disk.makeFolder && disk.removeFolder
      ? {
          async folders() {
            const all = await disk.folders!();
            return all && all.filter((p) => p.startsWith(under(prefix))).map((p) => p.slice(prefix.length + 1));
          },
          makeFolder: (path: string) => disk.makeFolder!(inside(path)),
          removeFolder: (path: string) => disk.removeFolder!(inside(path)),
        }
      : {}),
    ...(disk.setTimes ? { setTimes: (path: string, times: { created?: number; modified?: number }) => disk.setTimes!(inside(path), times) } : {}),
  };
}

/** The disk without `prefix` and what is in it: the vault's own sync, which never uploads or deletes the shared copies. */
export function outsideDisk(disk: VaultDisk, prefix: string): VaultDisk {
  const outside = (path: string) => path !== prefix && !path.startsWith(under(prefix));
  return {
    ...disk,
    scan: async () => (await disk.scan()).filter((f) => outside(f.path)),
    ...(disk.folders
      ? {
          async folders() {
            const all = await disk.folders!();
            return all && all.filter(outside);
          },
        }
      : {}),
  };
}

/** What a shared copy's run of the sync did that the role kept from the account; the copy is put back by running it again. */
export interface Refusals {
  count: number;
}

/**
 * The shared folder as the sync's account. `accountWins` is for a copy with no memory: an editor's file that differs from the
 * account's is kept as a version of the document rather than replacing it, and the account's copy is written to disk.
 */
export function sharedCloud(api: SharedApi, share: VaultShare, tree: ShareTree, refused: Refusals, accountWins: boolean): VaultHost['cloud'] {
  const editor = share.role === 'editor';
  let current = tree;
  const root = () => current.folders.find((f) => f.parentId === null)?.id ?? share.folderId;
  const docs = () => new Map(current.documents.map((d) => [d.id, d]));
  const refuse = () => void refused.count++;

  /** The folder at `directory` (inside the shared folder), made if missing. */
  async function folderFor(directory: string[]): Promise<string> {
    let parent = root();
    for (const part of directory) {
      const found = current.folders.find((f) => f.parentId === parent && safeName(f.name) === part);
      if (found) {
        parent = found.id;
        continue;
      }
      const id = crypto.randomUUID();
      await api.putFolder(share, id, part, parent);
      current = { ...current, folders: [...current.folders, { id, name: part, parentId: parent, createdByYou: true }] };
      parent = id;
    }
    return parent;
  }

  return {
    async list() {
      current = await api.tree(share);
      // A listing that leaves documents out would read as their deletion.
      if (current.truncated) throw new Error('This shared folder has too many files to keep a copy of.');
      const top = root();
      const folders: CloudFolder[] = current.folders.filter((f) => f.id !== top).map((f) => ({ id: f.id, name: f.name, parentId: f.parentId === top ? null : f.parentId }));
      const documents: CloudDoc[] = current.documents.map((d) => ({ id: d.id, name: d.name, folderId: d.folderId === top ? null : d.folderId, createdAt: d.createdAt, updatedAt: d.updatedAt }));
      return { docs: documents, folders };
    },
    download: (id) => api.download(id),
    async replace(id, bytes) {
      // Remembered as a time the account never had: the account's copy is newer, so the next run writes it back.
      if (!editor) return refuse(), { updatedAt: -1 };
      if (!accountWins) return api.save(id, bytes);
      // The account's copy stays the document; the file is kept as a version of it (the sync has kept the account's already).
      const theirs = await api.download(id);
      await api.save(id, bytes);
      await api.keepVersion(id);
      await api.save(id, theirs);
      refuse();
      return { updatedAt: -1 };
    },
    async create(directory, name, bytes) {
      if (!editor) throw new Error('This folder is shared with you to view only: files added here are not sent.');
      const made = await api.create(share, await folderFor(directory), name, bytes);
      current = { ...current, documents: [...current.documents, { id: made.id, name, folderId: '', createdAt: made.updatedAt, updatedAt: made.updatedAt, createdByYou: true }] };
      return made;
    },
    async place(id, directory, name) {
      const doc = docs().get(id);
      const folder = doc && current.folders.find((f) => f.id === doc.folderId);
      const here = (() => {
        const path: string[] = [];
        for (let f = folder; f && f.parentId !== null; f = current.folders.find((p) => p.id === f!.parentId)) path.unshift(safeName(f.name));
        return path;
      })();
      // Only a rename, in its folder, of what this person added: no moves, and nothing of the owner's.
      if (!editor || !doc?.createdByYou || here.join('/') !== directory.join('/')) return refuse();
      await api.rename(id, name);
    },
    keepVersion: async (id) => (editor ? api.keepVersion(id) : undefined),
    async trash(id) {
      if (!editor || !docs().get(id)?.createdByYou) return refuse();
      await api.trash(id);
    },
    async removeFolder(id) {
      if (!editor || !current.folders.find((f) => f.id === id)?.createdByYou) return refuse();
      await api.deleteFolder(share, id);
    },
    async makeFolder(directory) {
      if (!editor) return refuse();
      await folderFor(directory);
    },
  };
}

/** What this computer keeps about the shared copies in its vault: where they are, and which share each one is. */
interface Registry {
  version: 1;
  root?: string;
  shares: { ownerId: string; folderId: string; label: string }[];
}

const keyOf = (share: { ownerId: string; folderId: string }) => `${share.ownerId}/${share.folderId}`;

/** A new copy's label: `<owner>/<folder>`, " (2)" on an owner's name another owner has, and on a folder's name that owner has twice. */
export function newLabel(share: VaultShare, taken: readonly { ownerId: string; label: string }[]): string {
  const ownerName = safeName(share.owner.name ?? share.owner.email?.split('@')[0] ?? share.ownerId);
  const ownersDir = (label: string) => label.slice(0, label.indexOf('/'));
  const mine = taken.find((t) => t.ownerId === share.ownerId);
  let dir = mine ? ownersDir(mine.label) : ownerName;
  for (let n = 2; !mine && taken.some((t) => t.ownerId !== share.ownerId && ownersDir(t.label).toLowerCase() === dir.toLowerCase()); n++) dir = `${ownerName} (${n})`;
  const folderName = safeName(share.name);
  let label = `${dir}/${folderName}`;
  for (let n = 2; taken.some((t) => t.label.toLowerCase() === label.toLowerCase()); n++) label = `${dir}/${folderName} (${n})`;
  return label;
}

/** Memories of the vault by name: one for the list of copies, one per copy (vaultMemory.ts, keyed beside the vault's own). */
export type MemoryFor = (name: string) => VaultMemory;

export interface SharedSyncReport {
  /** Per copy kept or brought up to date: its label and what its run of the sync did. */
  copies: { label: string; report: SyncReport }[];
  /** Copies removed because their share ended or is no longer wanted. */
  removed: string[];
  /** Files left in the vault that were never sent to the account: a viewer's additions, and files in a removed copy that were never sent. */
  kept: number;
  /** Where the copies are, relative to the vault (`Shared`), or null while there are none. */
  root: string | null;
}

export interface SharedOptions {
  disk: VaultDisk;
  memory: MemoryFor;
  api: SharedApi;
  codec: VaultCodec;
  hash(bytes: Uint8Array): Promise<string>;
  account: string;
  /** Whether this person wants a copy of this share in this vault ("Keep a copy in my vault"). */
  wanted(share: VaultShare): boolean;
}

/** Where the shared copies are, once known (null before the first copy): the vault's own sync leaves it out. */
export async function sharedRoot(memory: MemoryFor): Promise<string | null> {
  return (await loadRegistry(memory)).root ?? null;
}

async function loadRegistry(memory: MemoryFor): Promise<Registry> {
  try {
    const text = await memory('shared').load();
    const parsed = text ? (JSON.parse(text) as Registry) : null;
    if (parsed?.version === 1 && Array.isArray(parsed.shares)) return parsed;
  } catch {
    /* none, or unreadable: as if no copies were made yet */
  }
  return { version: 1, shares: [] };
}

/** The manifest a copy's memory holds (syncVault's state), or none. */
async function entriesOf(memory: VaultMemory): Promise<{ path: string; hash: string }[]> {
  try {
    const text = await memory.load();
    const state = text ? (JSON.parse(text) as { entries?: { path: string; hash: string }[] }) : null;
    return Array.isArray(state?.entries) ? state.entries : [];
  } catch {
    return [];
  }
}

/**
 * Keeps every shared copy: makes the ones that are new, brings the others up to date both ways within the role, and removes the
 * ones whose share ended. Throws (changing nothing) when the shares can't be listed.
 */
export async function syncShared(options: SharedOptions): Promise<SharedSyncReport> {
  const { disk, memory, api } = options;
  const shares = await api.shares();
  const registry = await loadRegistry(memory);
  const report: SharedSyncReport = { copies: [], removed: [], kept: 0, root: registry.root ?? null };
  const wanted = shares.filter(options.wanted);

  // Where the copies go, chosen when the first is made: clear of a folder of the account's own.
  if (!registry.root && wanted.length) {
    const own = new Set((await api.topFolders()).map((n) => safeName(n).toLowerCase()));
    const root = SHARED_ROOTS.find((r) => !own.has(r.toLowerCase()));
    if (!root) return report;
    registry.root = root;
  }
  const root = registry.root;
  report.root = root ?? null;

  // Copies whose share ended, or that are no longer wanted, go first, so their labels are free.
  const keep = new Set(wanted.map(keyOf));
  for (const entry of registry.shares.filter((e) => !keep.has(keyOf(e)))) {
    const copy = memory(`shared:${keyOf(entry)}`);
    const prefix = `${root}/${entry.label}`;
    for (const { path } of await entriesOf(copy)) await disk.remove(`${prefix}/${path}`).catch(() => {});
    report.kept += (await disk.scan()).filter((f) => f.path.startsWith(under(prefix))).length;
    if (disk.folders && disk.removeFolder) {
      const left = ((await disk.folders()) ?? []).filter((p) => p === prefix || p.startsWith(under(prefix))).sort((a, b) => b.length - a.length);
      for (const path of left) await disk.removeFolder(path).catch(() => false);
      // The owner's folder too, once nothing of theirs is left.
      await disk.removeFolder(prefix.slice(0, prefix.lastIndexOf('/'))).catch(() => false);
    }
    await copy.save('');
    report.removed.push(entry.label);
  }
  registry.shares = registry.shares.filter((e) => keep.has(keyOf(e)));

  for (const share of wanted) {
    const known = registry.shares.find((e) => keyOf(e) === keyOf(share));
    const others = registry.shares.filter((e) => e !== known);
    const clash = (label: string) => others.some((e) => e.label.toLowerCase() === label.toLowerCase());
    let label = known?.label ?? (share.localName && !clash(share.localName) ? share.localName : newLabel(share, others));
    const copy = memory(`shared:${keyOf(share)}`);
    const remembered = await entriesOf(copy);
    // Renamed on disk: the files the memory has are found under another folder of `Shared/`, which becomes the label.
    if (remembered.length) {
      const files = await disk.scan();
      const prefix = `${root}/${label}`;
      if (!files.some((f) => f.path.startsWith(under(prefix)))) {
        const moved = relocated(files, remembered, root!, (candidate) => !clash(candidate));
        if (moved) label = moved;
        // Gone from disk altogether: the copy is written again (nothing is sent: the account wins without a memory).
        else await copy.save('');
      }
    }
    if (known) known.label = label;
    else registry.shares.push({ ownerId: share.ownerId, folderId: share.folderId, label });
    if (share.localName !== label) await api.setLabel(share, label).catch(() => {});

    const prefix = `${root}/${label}`;
    try {
      const tree = await api.tree(share);
      const noMemory = !(await entriesOf(copy)).length;
      // A viewer's own files (not the account's, not remembered) are left alone, and counted.
      const ours = new Set([...cloudPaths(tree.documents.map((d) => ({ ...d, folderId: d.folderId === share.folderId ? null : d.folderId })), tree.folders.filter((f) => f.parentId !== null).map((f) => ({ ...f, parentId: f.parentId === share.folderId ? null : f.parentId }))).map((c) => c.path), ...(await entriesOf(copy)).map((e) => e.path)]);
      // One that may be a remembered file moved (the size of one that is missing) is let through, so the move is seen and put back.
      const remembered = await entriesOf(copy);
      const present = new Set((await disk.scan()).filter((f) => f.path.startsWith(under(prefix))).map((f) => f.path.slice(prefix.length + 1)));
      const movedSizes = new Set((remembered as { path: string; size?: number }[]).filter((e) => !present.has(e.path)).map((e) => e.size));
      let strays = 0;
      const keepFile = share.role === 'viewer' ? (f: LocalFile) => ours.has(f.path) || movedSizes.has(f.size) || (strays++, false) : () => true;
      let result: SyncReport | null = null;
      for (let pass = 0; pass < 2; pass++) {
        const refused: Refusals = { count: 0 };
        strays = 0;
        const host: VaultHost = { disk: scopedDisk(disk, prefix, keepFile), memory: copy, cloud: sharedCloud(api, share, tree, refused, noMemory && pass === 0), codec: options.codec, hash: options.hash, account: options.account };
        result = await syncVault(host);
        if (!refused.count) break;
      }
      report.kept += strays;
      report.copies.push({ label, report: result! });
    } catch (error) {
      report.copies.push({ label, report: failed(error) });
    }
  }

  await memory('shared').save(JSON.stringify(registry));
  return report;
}

/** A copy's run that failed before it began (the shared folder could not be listed). */
function failed(error: unknown): SyncReport {
  const message = error instanceof Error ? error.message : String(error);
  return { accountDocs: 0, folderFiles: 0, downloaded: 0, uploaded: 0, linked: 0, created: 0, renamed: 0, movedHere: 0, deletedHere: 0, trashed: 0, foldersRemoved: 0, foldersMade: 0, skipped: 0, errors: [{ action: { kind: 'forget', id: '' }, message }], touched: [], missing: [] };
}

/**
 * The label a copy was moved to on disk: the folder two levels under `root` (`<owner>/<folder>`) that holds the most of the
 * remembered files, at the same paths with the same sizes being enough to tell. Null when none holds any.
 */
export function relocated(files: readonly LocalFile[], remembered: readonly { path: string }[], root: string, free: (label: string) => boolean): string | null {
  const counts = new Map<string, number>();
  const wantedPaths = new Set(remembered.map((e) => e.path));
  for (const file of files) {
    if (!file.path.startsWith(under(root))) continue;
    const parts = file.path.slice(root.length + 1).split('/');
    if (parts.length < 3) continue;
    const label = `${parts[0]}/${parts[1]}`;
    if (wantedPaths.has(parts.slice(2).join('/')) && free(label)) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [label, count] of counts) if (!best || count > counts.get(best)!) best = label;
  return best;
}

/** The shares this person keeps no copy of ("Keep a copy in my vault" off), as `<owner>/<folder>` keys; a preference, so it follows the account. */
export const SHARED_OFF_KEY = 'golem.sharedVaultOff';

function offList(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SHARED_OFF_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/** Whether the vault keeps a copy of this shared folder (on unless turned off). */
export function keepsCopy(share: { ownerId: string; folderId: string }): boolean {
  return !offList().includes(keyOf(share));
}

/** Turns "Keep a copy in my vault" on or off for one shared folder. */
export function setKeepsCopy(share: { ownerId: string; folderId: string }, on: boolean): void {
  const rest = offList().filter((k) => k !== keyOf(share));
  try {
    if (on && !rest.length) localStorage.removeItem(SHARED_OFF_KEY);
    else localStorage.setItem(SHARED_OFF_KEY, JSON.stringify(on ? rest : [...rest, keyOf(share)]));
  } catch {
    /* storage blocked: the copy stays as it was */
  }
}
