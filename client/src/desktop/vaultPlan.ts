// Deciding what a sync does, as pure functions: no disk, no network, nothing to mock.
//
// The vault (a folder on this computer) mirrors the account's documents. The rule is that the local file wins:
// whatever the person did to the folder is what the account becomes. Nothing is lost by that, because the account
// keeps every version (a replaced document's old bytes are kept as a version first, a deleted one goes to the
// trash for 30 days), so a mistake can be undone from the cloud side.
//
// A sync is two steps so the slow part (hashing files) is only done where it can change the answer:
//   1. `needsHash` names the files whose content has to be compared;
//   2. `planVault` takes their hashes and returns the actions.

/** A file in the vault, as the disk reports it. */
export interface LocalFile {
  /** Relative to the vault, `/` between names. */
  path: string;
  size: number;
  mtimeMs: number;
}

/** What the last sync left behind about one document: the link between a file and its cloud document. */
export interface ManifestEntry {
  /** The cloud document's id. Files are followed by this, not by their path, so a rename is not a delete and a create. */
  id: string;
  path: string;
  /** SHA-256 (hex) of the file as the sync last wrote or read it. */
  hash: string;
  size: number;
  mtimeMs: number;
  /** The cloud document's `updatedAt` at the last sync. */
  cloudUpdatedAt: number;
}

/** A document in the account, placed where it would be in the vault (see `cloudPaths`). */
export interface CloudFile {
  id: string;
  path: string;
  updatedAt: number;
}

export interface PlanInput {
  local: readonly LocalFile[];
  manifest: readonly ManifestEntry[];
  cloud: readonly CloudFile[];
  /** Hex SHA-256 of files, for the paths `needsHash` asked for. */
  hashes: ReadonlyMap<string, string>;
  /** The person confirmed that many deleted files are meant (see `VaultPlan.blocked`). */
  allowMassDelete?: boolean;
}

export type VaultAction =
  /** Cloud to disk: a new document, or one changed in the account while the file was not. */
  | { kind: 'download'; id: string; path: string }
  /** Disk to an existing cloud document. `keepCloudVersion`: the account changed it too, so its bytes are kept as a version first. */
  | { kind: 'upload'; id: string; path: string; keepCloudVersion: boolean }
  /** A file with no cloud document: make one. */
  | { kind: 'create'; path: string }
  /** The file was moved or renamed in the vault: do the same to the cloud document. */
  | { kind: 'renameCloud'; id: string; from: string; to: string }
  /** The document was moved or renamed in the account and the file was not changed: follow it. */
  | { kind: 'moveLocal'; id: string; from: string; to: string }
  /** Deleted in the account, and the file was not changed: delete it here too. */
  | { kind: 'deleteLocal'; id: string; path: string }
  /** Deleted in the vault: move the cloud document to the account's trash. */
  | { kind: 'deleteCloud'; id: string; path: string }
  /** Gone from both: drop the link. */
  | { kind: 'forget'; id: string };

export interface VaultPlan {
  actions: VaultAction[];
  /**
   * Set when the plan would delete so much that it is more likely an accident than a decision. No deletes are in `actions`.
   * `mass-delete`: most files are missing from the folder (a drive that is not mounted, an emptied folder); `count` documents
   * would go to the trash. `mass-delete-here`: most documents are gone from the other side (storage that was cleared, a
   * memory that is not this side's); `count` files would be deleted from the folder.
   */
  blocked?: { reason: 'mass-delete' | 'mass-delete-here'; count: number };
}

/** This many deletes on one side, and at least half of all that are linked, is treated as an accident rather than a clean-up. */
export const MASS_DELETE_MIN = 10;

const unchanged = (file: LocalFile, entry: ManifestEntry): boolean => file.size === entry.size && file.mtimeMs === entry.mtimeMs;

/**
 * The files whose bytes must be hashed before planning: linked files whose size or time moved (a touch is not an
 * edit), and unlinked files the same size as a vanished linked one (it may be that file, renamed).
 */
export function needsHash(local: readonly LocalFile[], manifest: readonly ManifestEntry[]): string[] {
  const byPath = new Map(local.map((f) => [f.path, f]));
  const linked = new Set(manifest.map((m) => m.path));
  const need: string[] = [];
  const goneSizes = new Set<number>();
  for (const entry of manifest) {
    const file = byPath.get(entry.path);
    if (!file) goneSizes.add(entry.size);
    else if (!unchanged(file, entry)) need.push(entry.path);
  }
  for (const file of local) if (!linked.has(file.path) && goneSizes.has(file.size)) need.push(file.path);
  return need;
}

export function planVault(input: PlanInput): VaultPlan {
  const { local, manifest, cloud, hashes, allowMassDelete } = input;
  const localByPath = new Map(local.map((f) => [f.path, f]));
  const cloudById = new Map(cloud.map((c) => [c.id, c]));
  const linkedPaths = new Set(manifest.map((m) => m.path));

  const actions: VaultAction[] = [];
  const deletes: VaultAction[] = [];

  // Files with no link: candidates for a rename of a vanished linked file (same bytes), else new documents.
  const untracked = local.filter((f) => !linkedPaths.has(f.path));
  const taken = new Set<string>();
  const renamedTo = new Map<string, string>(); // manifest id -> new path

  for (const entry of manifest) {
    if (localByPath.has(entry.path)) continue;
    const matches = untracked.filter((f) => !taken.has(f.path) && hashes.get(f.path) === entry.hash);
    if (matches.length === 1) {
      taken.add(matches[0].path);
      renamedTo.set(entry.id, matches[0].path);
    }
  }

  for (const entry of manifest) {
    const file = localByPath.get(entry.path);
    const remote = cloudById.get(entry.id);
    const cloudChanged = remote !== undefined && remote.updatedAt !== entry.cloudUpdatedAt;

    if (file) {
      const edited = !unchanged(file, entry) && hashes.get(entry.path) !== entry.hash;
      if (edited) {
        if (remote) {
          actions.push({ kind: 'upload', id: entry.id, path: entry.path, keepCloudVersion: cloudChanged });
          if (remote.path !== entry.path) actions.push({ kind: 'moveLocal', id: entry.id, from: entry.path, to: remote.path });
        } else {
          // Deleted in the account but edited here: the edit is kept, as a new document.
          actions.push({ kind: 'create', path: entry.path }, { kind: 'forget', id: entry.id });
        }
      } else if (!remote) {
        deletes.push({ kind: 'deleteLocal', id: entry.id, path: entry.path });
      } else if (remote.path !== entry.path) {
        actions.push({ kind: 'moveLocal', id: entry.id, from: entry.path, to: remote.path });
        if (cloudChanged) actions.push({ kind: 'download', id: entry.id, path: remote.path });
      } else if (cloudChanged) {
        actions.push({ kind: 'download', id: entry.id, path: entry.path });
      }
      continue;
    }

    // The file is gone from where it was.
    const moved = renamedTo.get(entry.id);
    if (moved !== undefined) {
      if (remote) actions.push({ kind: 'renameCloud', id: entry.id, from: entry.path, to: moved });
      else actions.push({ kind: 'create', path: moved }, { kind: 'forget', id: entry.id });
    } else if (remote) deletes.push({ kind: 'deleteCloud', id: entry.id, path: entry.path });
    else actions.push({ kind: 'forget', id: entry.id });
  }

  // Documents in the account that the vault has never seen.
  const linkedIds = new Set(manifest.map((m) => m.id));
  for (const remote of cloud) {
    if (linkedIds.has(remote.id)) continue;
    if (localByPath.has(remote.path) && !linkedPaths.has(remote.path)) {
      // A file is already there (a vault that was filled before it was linked): the local file wins.
      actions.push({ kind: 'upload', id: remote.id, path: remote.path, keepCloudVersion: true });
      taken.add(remote.path);
    } else {
      actions.push({ kind: 'download', id: remote.id, path: remote.path });
    }
  }

  for (const file of untracked) if (!taken.has(file.path)) actions.push({ kind: 'create', path: file.path });

  const missing = deletes.filter((a) => a.kind === 'deleteCloud').length;
  const here = deletes.length - missing;
  const many = (count: number) => count >= MASS_DELETE_MIN && count * 2 >= manifest.length;
  // Probably a drive that is not mounted, a folder emptied by accident or a memory that is not this side's. The deletes
  // still happen, but only once the person confirms (the driver asks, then plans again with `allowMassDelete`).
  if (!allowMassDelete && many(missing)) return { actions, blocked: { reason: 'mass-delete', count: missing } };
  if (!allowMassDelete && many(here)) return { actions, blocked: { reason: 'mass-delete-here', count: here } };
  return { actions: [...actions, ...deletes] };
}

// ---- Where documents go in the vault ----

export interface CloudDoc {
  id: string;
  name: string;
  folderId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CloudFolder {
  id: string;
  name: string;
  parentId?: string | null;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** One name that every file system accepts: no separators or reserved characters, no leading dot, no trailing dot or space. */
export function safeName(name: string): string {
  let clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').replace(/^\.+/, '_');
  if (!clean || RESERVED.test(clean)) clean = `_${clean}`;
  return clean.length > 200 ? clean.slice(0, 200) : clean;
}

/**
 * Where each document lives in the vault: its folders' names, then its own. Two that would share a path (the
 * account allows it; most disks, case-insensitive ones included, do not) keep the older one's name and the
 * other gets " (2)", " (3)"... before its extension, so a document keeps the same path from one sync to the next.
 */
export function cloudPaths(docs: readonly CloudDoc[], folders: readonly CloudFolder[]): CloudFile[] {
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const folderPath = (id: string | null | undefined): string[] => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (let at = id ? folderById.get(id) : undefined; at && !seen.has(at.id); at = at.parentId ? folderById.get(at.parentId) : undefined) {
      seen.add(at.id);
      names.unshift(safeName(at.name));
    }
    return names;
  };

  const used = new Set<string>();
  const out: CloudFile[] = [];
  for (const doc of [...docs].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    const dir = folderPath(doc.folderId);
    const name = safeName(doc.name);
    const dot = name.lastIndexOf('.');
    const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    let candidate = [...dir, name].join('/');
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = [...dir, `${stem} (${n})${extension}`].join('/');
    used.add(candidate.toLowerCase());
    out.push({ id: doc.id, path: candidate, updatedAt: doc.updatedAt });
  }
  return out;
}
