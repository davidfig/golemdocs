// Runs one sync of the vault: reads the folder and the account, asks `planVault` what to do, does it, and records
// what it did in `.golemdocs/state.json` so the next sync can tell an edit from a file that was only touched.
//
// Everything outside (the disk, the account, the converter, hashing) comes in through `VaultHost`, so the whole
// sync runs in tests against in-memory stand-ins. One action failing is reported and the rest carry on; what failed
// is still different from the manifest, so the next sync tries it again.

import { cloudPaths, needsHash, planVault, type CloudDoc, type CloudFile, type CloudFolder, type LocalFile, type ManifestEntry, type VaultAction } from './vaultPlan.ts';

/** Failures in a row after which a sync stops: a bad file is skipped, but every file failing is a problem to show now. */
const GIVE_UP_AFTER = 5;

export const STATE_PATH = '.golemdocs/state.json';

/** The `account` of a vault kept while nobody is signed in (its documents are the ones saved in this browser). */
export const GUEST_ACCOUNT = '@guest';

export interface VaultDisk {
  scan(): Promise<LocalFile[]>;
  read(path: string): Promise<Uint8Array>;
  /** Returns the new modification time. */
  write(path: string, bytes: Uint8Array): Promise<number>;
  remove(path: string): Promise<void>;
}

export interface VaultCloud {
  list(): Promise<{ docs: CloudDoc[]; folders: CloudFolder[] }>;
  download(id: string): Promise<Uint8Array>;
  /** Replaces a document's bytes, whatever the account has now. */
  replace(id: string, bytes: Uint8Array): Promise<{ updatedAt: number }>;
  /** Makes a document in the folder named by `directory` (made if missing). */
  create(directory: string[], name: string, bytes: Uint8Array): Promise<{ id: string; updatedAt: number }>;
  /** Renames and/or moves a document. */
  place(id: string, directory: string[], name: string): Promise<void>;
  /** Keeps the document as it is now, so a replacement can be undone. */
  keepVersion(id: string): Promise<void>;
  /** Moves a document to the account's trash. */
  trash(id: string): Promise<void>;
}

export interface VaultCodec {
  /** The vault file for stored bytes, or null if the vault does not keep this one. */
  toFile(stored: Uint8Array, name: string): Promise<Uint8Array | null>;
  fromFile(file: Uint8Array, name: string): Promise<Uint8Array>;
  /** Whether the vault keeps files with this name. */
  kept(name: string): boolean;
}

export interface VaultHost {
  disk: VaultDisk;
  cloud: VaultCloud;
  codec: VaultCodec;
  /** Hex SHA-256. */
  hash(bytes: Uint8Array): Promise<string>;
  /** The signed-in account, or `GUEST_ACCOUNT`. A vault belongs to one account; another's files are never mixed in. */
  account: string;
}

interface State {
  version: 1;
  account: string;
  entries: ManifestEntry[];
}

/** Where a running sync is, for the dialog: the step, and for the last one how many of the changes are done and which file is being worked on. */
export interface SyncProgress {
  phase: 'access' | 'uploads' | 'account' | 'folder' | 'compare' | 'apply';
  /** Documents the account listed (once `account` is done) and files found in the folder (once `folder` is done). */
  accountDocs?: number;
  folderFiles?: number;
  done?: number;
  total?: number;
  /** Actions that have failed so far, and the latest reason. */
  failed?: number;
  lastError?: string;
  /** The vault path being worked on. */
  path?: string;
}

export interface SyncReport {
  /** Documents the account has, and files the folder has, when the sync looked (before it changed anything). */
  accountDocs: number;
  folderFiles: number;
  downloaded: number;
  uploaded: number;
  created: number;
  renamed: number;
  movedHere: number;
  deletedHere: number;
  trashed: number;
  /** Documents the vault does not keep (a name with no file format the app opens) and so left alone, plus any that had no file to write. */
  skipped: number;
  errors: { action: VaultAction; message: string }[];
  /** The documents (by the other side's id) whose content, name or place the sync changed there or deleted: one open in an editor is out of date. */
  touched: string[];
  /** The plan was not run because it would delete most of the vault; confirm and sync again with `allowMassDelete`. */
  blocked?: { reason: 'mass-delete'; count: number };
  /** Documents the account lists but has no file for (paths they would have): not copied. */
  missing: string[];
  /** The sync gave up after this many failures in a row (something is wrong for every file, so going on would only repeat it); the rest was not tried. */
  gaveUp?: number;
  /** The vault belongs to another account (or, signed out, to an account at all); nothing was done. */
  wrongAccount?: boolean;
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const directoryOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')).split('/') : []);

async function loadState(host: VaultHost): Promise<State | null> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(await host.disk.read(STATE_PATH))) as State;
    return parsed?.version === 1 && Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null; // none yet, or unreadable: a vault with no memory, which the plan treats as filled before it was linked
  }
}

const saveState = (host: VaultHost, state: State) => host.disk.write(STATE_PATH, new TextEncoder().encode(JSON.stringify(state)));

export async function syncVault(host: VaultHost, options: { allowMassDelete?: boolean; progress?: (progress: SyncProgress) => void } = {}): Promise<SyncReport> {
  const report: SyncReport = { accountDocs: 0, folderFiles: 0, downloaded: 0, uploaded: 0, created: 0, renamed: 0, movedHere: 0, deletedHere: 0, trashed: 0, skipped: 0, errors: [], touched: [], missing: [] };
  const { disk, cloud, codec } = host;

  const saved = await loadState(host);
  // A vault kept while signed out is taken over by the account that signs in: with no memory, the plan matches files to
  // documents by path and the file wins, so nothing is lost. A vault linked to an account is never given to another
  // account, nor to a signed-out browser (that would copy its files into documents the account would then duplicate).
  if (saved && saved.account !== host.account && (saved.account !== GUEST_ACCOUNT || host.account === GUEST_ACCOUNT)) return { ...report, wrongAccount: true };
  const state: State = saved && saved.account === host.account ? saved : { version: 1, account: host.account, entries: [] };

  const tell = options.progress ?? (() => {});
  tell({ phase: 'account' });
  const listing = await cloud.list();
  report.accountDocs = listing.docs.length;
  tell({ phase: 'folder', accountDocs: report.accountDocs });
  const all = cloudPaths(listing.docs, listing.folders);
  const nameOf = new Map(listing.docs.map((d) => [d.id, d.name]));
  const kept: CloudFile[] = all.filter((c) => codec.kept(nameOf.get(c.id) ?? ''));
  report.skipped = all.length - kept.length;
  const scanned = await disk.scan();
  report.folderFiles = scanned.length;
  const local = scanned.filter((f) => codec.kept(baseName(f.path)));
  const localByPath = new Map(local.map((f) => [f.path, f]));

  tell({ phase: 'compare', accountDocs: report.accountDocs, folderFiles: report.folderFiles });
  const hashes = new Map<string, string>();
  for (const path of needsHash(local, state.entries)) hashes.set(path, await host.hash(await disk.read(path)));

  const plan = planVault({ local, manifest: state.entries, cloud: kept, hashes, allowMassDelete: options.allowMassDelete });
  if (plan.blocked) report.blocked = plan.blocked;

  const entries = new Map(state.entries.map((e) => [e.id, e]));
  const remoteById = new Map(kept.map((c) => [c.id, c]));
  const touched = new Set<string>(); // documents whose metadata changed in the account without their bytes
  const taken = new Set(local.map((f) => f.path)); // paths in use, so a move or download never writes over a different file

  const record = (id: string, path: string, bytes: Uint8Array, mtimeMs: number, cloudUpdatedAt: number, hash: string) =>
    entries.set(id, { id, path, hash, size: bytes.byteLength, mtimeMs, cloudUpdatedAt });

  async function run(action: VaultAction): Promise<void> {
    switch (action.kind) {
      case 'download': {
        const name = baseName(action.path);
        const existing = entries.get(action.id);
        if (taken.has(action.path) && existing?.path !== action.path) throw new Error(`a different file is already at ${action.path}`);
        let stored: Uint8Array;
        try {
          stored = await cloud.download(action.id);
        } catch (error) {
          // The account lists the document but has no file for it: nothing to copy, and no reason to stop the others.
          if ((error as { status?: number }).status === 404) {
            report.missing.push(action.path);
            return;
          }
          throw error;
        }
        const file = await codec.toFile(stored, name);
        if (!file) {
          report.skipped++;
          return;
        }
        const mtime = await disk.write(action.path, file);
        taken.add(action.path);
        record(action.id, action.path, file, mtime, remoteById.get(action.id)?.updatedAt ?? 0, await host.hash(file));
        report.downloaded++;
        return;
      }
      case 'upload': {
        const file = await disk.read(action.path);
        const stored = await codec.fromFile(file, baseName(action.path));
        if (action.keepCloudVersion) await cloud.keepVersion(action.id);
        const { updatedAt } = await cloud.replace(action.id, stored);
        record(action.id, action.path, file, localByPath.get(action.path)?.mtimeMs ?? 0, updatedAt, await host.hash(file));
        report.uploaded++;
        report.touched.push(action.id);
        return;
      }
      case 'create': {
        const file = await disk.read(action.path);
        const stored = await codec.fromFile(file, baseName(action.path));
        const made = await cloud.create(directoryOf(action.path), baseName(action.path), stored);
        record(made.id, action.path, file, localByPath.get(action.path)?.mtimeMs ?? 0, made.updatedAt, await host.hash(file));
        report.created++;
        return;
      }
      case 'renameCloud': {
        await cloud.place(action.id, directoryOf(action.to), baseName(action.to));
        const entry = entries.get(action.id)!;
        entries.set(action.id, { ...entry, path: action.to, mtimeMs: localByPath.get(action.to)?.mtimeMs ?? entry.mtimeMs });
        touched.add(action.id);
        report.renamed++;
        report.touched.push(action.id);
        // A new extension is a new format: the account's copy has to be written in it, or it would keep the old one's extras.
        const to = codec.kept(baseName(action.to)) ? baseName(action.to) : null;
        if (to && to.slice(to.lastIndexOf('.')) !== baseName(action.from).slice(baseName(action.from).lastIndexOf('.'))) {
          await run({ kind: 'upload', id: action.id, path: action.to, keepCloudVersion: false });
        }
        return;
      }
      case 'moveLocal': {
        if (taken.has(action.to)) throw new Error(`a different file is already at ${action.to}`);
        const file = await disk.read(action.from);
        const mtime = await disk.write(action.to, file);
        await disk.remove(action.from);
        taken.delete(action.from);
        taken.add(action.to);
        const entry = entries.get(action.id)!;
        entries.set(action.id, { ...entry, path: action.to, mtimeMs: mtime, cloudUpdatedAt: remoteById.get(action.id)?.updatedAt ?? entry.cloudUpdatedAt });
        report.movedHere++;
        return;
      }
      case 'deleteLocal':
        await disk.remove(action.path);
        entries.delete(action.id);
        report.deletedHere++;
        return;
      case 'deleteCloud':
        await cloud.trash(action.id);
        entries.delete(action.id);
        report.trashed++;
        report.touched.push(action.id);
        return;
      case 'forget':
        entries.delete(action.id);
        return;
    }
  }

  let done = 0;
  let inARow = 0;
  for (const action of plan.actions) {
    if (inARow >= GIVE_UP_AFTER) {
      report.gaveUp = inARow;
      break;
    }
    const path = 'path' in action ? action.path : 'to' in action ? action.to : undefined;
    tell({ phase: 'apply', accountDocs: report.accountDocs, folderFiles: report.folderFiles, done, total: plan.actions.length, path, failed: report.errors.length, lastError: report.errors.at(-1)?.message });
    try {
      await run(action);
      inARow = 0;
    } catch (error) {
      inARow++;
      report.errors.push({ action, message: error instanceof Error ? error.message : String(error) });
    }
    done++;
  }

  // Renaming or moving a document in the account changes its time there too; take the new one, or the next sync would download it again.
  if (touched.size) {
    try {
      const fresh = new Map((await cloud.list()).docs.map((d) => [d.id, d.updatedAt]));
      for (const id of touched) {
        const entry = entries.get(id);
        const updatedAt = fresh.get(id);
        if (entry && updatedAt !== undefined) entries.set(id, { ...entry, cloudUpdatedAt: updatedAt });
      }
    } catch {
      /* the next sync downloads it once more: wasteful, not wrong */
    }
  }

  state.entries = [...entries.values()];
  await saveState(host, state);
  return report;
}
