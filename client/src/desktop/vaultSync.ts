// Runs one sync of the vault: reads the folder and the account, asks `planVault` what to do, does it, and records
// what it did in this computer's memory of the vault (`VaultMemory`) so the next sync can tell an edit from a file that
// was only touched. The folder itself keeps only whose it is (`.golemdocs/state.json`), because it may be shared with other
// computers (iCloud Drive, Dropbox...) that link its files to documents of their own.
//
// Everything outside (the disk, the account, the converter, hashing) comes in through `VaultHost`, so the whole
// sync runs in tests against in-memory stand-ins. One action failing is reported and the rest carry on; what failed
// is still different from the manifest, so the next sync tries it again.

import { cloudPaths, folderPaths, foldersOf, needsHash, planVault, safeName, vanishedFolders, type CloudDoc, type CloudFile, type CloudFolder, type LocalFile, type ManifestEntry, type VaultAction, type VaultPlan } from './vaultPlan.ts';

/** Failures in a row after which a sync stops: a bad file is skipped, but every file failing is a problem to show now. */
const GIVE_UP_AFTER = 5;

/** In the folder: which account the vault belongs to, with no entries. Before the memory moved to `VaultMemory` it held the
 * whole manifest, which a computer with no memory of its own still takes in once (see `adoptable`). */
export const STATE_PATH = '.golemdocs/state.json';

/** The `account` of a vault kept while nobody is signed in (its documents are the ones saved in this browser). */
export const GUEST_ACCOUNT = '@guest';

export interface VaultDisk {
  scan(): Promise<LocalFile[]>;
  read(path: string): Promise<Uint8Array>;
  /** Returns the new modification time. */
  write(path: string, bytes: Uint8Array): Promise<number>;
  remove(path: string): Promise<void>;
  /**
   * Every folder, empty ones included; null when they can't be listed (a shell older than the page). With these three the
   * vault and the account have the same folders, empty ones too; without them a folder is seen only through its files.
   */
  folders?(): Promise<string[] | null>;
  /** Makes a folder (and the ones it is in). */
  makeFolder?(path: string): Promise<void>;
  /** Removes a folder that holds nothing; false when something is in it, which is left. */
  removeFolder?(path: string): Promise<boolean>;
  /**
   * Gives a file dates (milliseconds), so it shows when its document was made, and last changed, rather than when this computer
   * wrote it. A creation date only moves earlier. Returns the modification time after, or null when files can't be dated here.
   */
  setTimes?(path: string, times: { created?: number; modified?: number }): Promise<number | null>;
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
  /** Removes an empty folder (see `vanishedFolders`). */
  removeFolder(id: string): Promise<void>;
  /** Makes the folder named by `directory` and the ones it is in, unless they are there already. */
  makeFolder(directory: string[]): Promise<void>;
}

export interface VaultCodec {
  /** The vault file for stored bytes, or null if the vault does not keep this one. */
  toFile(stored: Uint8Array, name: string): Promise<Uint8Array | null>;
  /** `previous`: what the account stores now, given only when `keepsLayout` says the file's layout is kept in it. */
  fromFile(file: Uint8Array, name: string, previous?: Uint8Array): Promise<Uint8Array>;
  /** Whether what the account stores for this file holds something the file doesn't (a CSV's column widths) to keep when it changes on disk. */
  keepsLayout?(name: string): boolean;
  /** Whether the vault keeps files with this name. */
  kept(name: string): boolean;
}

/** Where this computer keeps its memory of the vault between syncs, as text (vaultMemory.ts). */
export interface VaultMemory {
  /** Null when there is none yet; throws when the memory can't be read, which stops the sync before it changes anything. */
  load(): Promise<string | null>;
  save(text: string): Promise<void>;
}

export interface VaultHost {
  disk: VaultDisk;
  memory: VaultMemory;
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
  /**
   * The folders in the vault after the last sync, so one removed from the vault can be told from one never in it (and, with
   * `mirrored`, one removed from the account from one new in the vault). Before `mirrored`, only those that held files.
   */
  folders?: string[];
  /** The vault has had all of the account's folders, empty ones too, since the last sync (see `mirrorFolders`). */
  mirrored?: boolean;
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
  /** Files that were already the same as their document, found by path when the vault had no memory of them: linked, not uploaded. */
  linked: number;
  /** Folders removed from the account because they were removed from the vault. */
  foldersRemoved: number;
  /** Folders made in the account because they were made in the vault (empty ones: a file's folder comes with it). */
  foldersMade: number;
  /** Documents the vault does not keep (a name with no file format the app opens) and so left alone, plus any that had no file to write. */
  skipped: number;
  errors: { action: VaultAction; message: string }[];
  /** The documents (by the other side's id) whose content, name or place the sync changed there or deleted: one open in an editor is out of date. */
  touched: string[];
  /** The plan was not run because it would delete most of the vault; confirm and sync again with `allowMassDelete`. */
  blocked?: VaultPlan['blocked'];
  /** Documents the account lists but has no file for (paths they would have): not copied. */
  missing: string[];
  /** The sync gave up after this many failures in a row (something is wrong for every file, so going on would only repeat it); the rest was not tried. */
  gaveUp?: number;
  /** The vault belongs to another account (or, signed out, to an account at all); nothing was done. */
  wrongAccount?: boolean;
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const directoryOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')).split('/') : []);

function parseState(text: string | null): State | null {
  try {
    const parsed = text === null ? null : (JSON.parse(text) as State);
    return parsed?.version === 1 && typeof parsed.account === 'string' && Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null; // unreadable: a vault with no memory, which the plan treats as filled before it was linked
  }
}

async function readFolderState(host: VaultHost): Promise<State | null> {
  try {
    return parseState(new TextDecoder().decode(await host.disk.read(STATE_PATH)));
  } catch {
    return null; // none yet
  }
}

/**
 * Whether remembered entries are this side's. Signed out, the ids are documents saved in this browser: entries none of whose
 * documents are here were written by another computer (a folder state from before `VaultMemory`, brought by iCloud or Dropbox)
 * or outlived this browser's storage, and planning with them would delete every file as "deleted on the other side". They are
 * dropped, so the files are taken in as new documents. An account's ids are the same on every computer, so its entries are kept.
 */
function adoptable(entries: ManifestEntry[], account: string, listed: ReadonlySet<string>): ManifestEntry[] {
  if (account !== GUEST_ACCOUNT || entries.some((e) => listed.has(e.id))) return entries;
  return [];
}

export async function syncVault(host: VaultHost, options: { allowMassDelete?: boolean; progress?: (progress: SyncProgress) => void } = {}): Promise<SyncReport> {
  const report: SyncReport = { accountDocs: 0, folderFiles: 0, downloaded: 0, uploaded: 0, linked: 0, created: 0, renamed: 0, movedHere: 0, deletedHere: 0, trashed: 0, foldersRemoved: 0, foldersMade: 0, skipped: 0, errors: [], touched: [], missing: [] };
  const { disk, cloud, codec } = host;

  const remembered = parseState(await host.memory.load());
  const folderState = await readFolderState(host);
  // A vault kept while signed out is taken over by the account that signs in: with no memory, the plan matches files to
  // documents by path and the file wins, so nothing is lost. A vault linked to an account is never given to another
  // account, nor to a signed-out browser (that would copy its files into documents the account would then duplicate). The
  // folder says whose it is to every computer that shares it; this computer's memory says it here.
  const refuses = (owner: State | null) => !!owner && owner.account !== host.account && (owner.account !== GUEST_ACCOUNT || host.account === GUEST_ACCOUNT);
  if (refuses(remembered) || refuses(folderState)) return { ...report, wrongAccount: true };
  // This computer's memory, or (once, with none) the manifest an older version kept in the folder.
  const saved = remembered ?? folderState;
  const state: State = saved && saved.account === host.account ? { ...saved } : { version: 1, account: host.account, entries: [] };

  const tell = options.progress ?? (() => {});
  tell({ phase: 'account' });
  const listing = await cloud.list();
  report.accountDocs = listing.docs.length;
  state.entries = adoptable(state.entries, host.account, new Set(listing.docs.map((d) => d.id)));
  tell({ phase: 'folder', accountDocs: report.accountDocs });
  const all = cloudPaths(listing.docs, listing.folders);
  const nameOf = new Map(listing.docs.map((d) => [d.id, d.name]));
  const kept: CloudFile[] = all.filter((c) => codec.kept(nameOf.get(c.id) ?? ''));
  report.skipped = all.length - kept.length;
  const scanned = await disk.scan();
  // Taken with the files, before the sync changes anything: a folder missing from this was removed by the person, not by this sync.
  const diskFolders = disk.folders && disk.makeFolder && disk.removeFolder ? await disk.folders() : null;
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
  const removedHere = new Set<string>(); // files this sync deleted or moved away

  const record = (id: string, path: string, bytes: Uint8Array, mtimeMs: number, cloudUpdatedAt: number, hash: string, dated = entries.get(id)?.dated) =>
    entries.set(id, { id, path, hash, size: bytes.byteLength, mtimeMs, cloudUpdatedAt, ...(dated ? { dated } : {}) });
  /** Dates a file the sync just wrote. Null when it can't be: the file keeps the date the disk gave it, and is not `dated`. */
  const date = async (path: string, times: { created?: number; modified?: number }): Promise<number | null> => (disk.setTimes ? disk.setTimes(path, times).catch(() => null) : null);

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
        // The same file (only what the account keeps beside it changed, such as a CSV's column widths): it is left as it is, so nothing watching the folder sees a change.
        const hash = await host.hash(file);
        const same = existing?.path === action.path && existing.hash === hash && localByPath.has(action.path);
        const remote = remoteById.get(action.id);
        let mtime = same ? existing.mtimeMs : await disk.write(action.path, file);
        let dated = same ? existing.dated : undefined;
        if (!same) {
          // Made when the account made it. Changed when the account changed it, unless the bytes are the ones it had (a document
          // moved or renamed in the account, whose time there moves too): then it keeps the time it had.
          const after = await date(action.path, { created: remote?.createdAt, modified: existing?.hash === hash ? existing.mtimeMs : remote?.updatedAt });
          if (after !== null) [mtime, dated] = [after, remote?.createdAt !== undefined];
        }
        taken.add(action.path);
        record(action.id, action.path, file, mtime, remote?.updatedAt ?? 0, hash, dated);
        report.downloaded++;
        return;
      }
      case 'upload': {
        const file = await disk.read(action.path);
        if (action.unlinked) {
          // A file that was there before the vault knew this document (a folder used signed out, or new to this computer). When it is
          // what the account would write, the two are only linked: no upload, and no version of an unchanged document. Any doubt (no
          // copy, a format the vault doesn't write) uploads as before; the file still wins.
          const remote = remoteById.get(action.id);
          const ours = await cloud
            .download(action.id)
            .then((stored) => codec.toFile(stored, baseName(action.path)))
            .catch(() => null);
          const hash = await host.hash(file);
          if (ours && remote && (await host.hash(ours)) === hash) {
            record(action.id, action.path, file, localByPath.get(action.path)?.mtimeMs ?? 0, remote.updatedAt, hash);
            report.linked++;
            return;
          }
        }
        const previous = codec.keepsLayout?.(baseName(action.path)) ? await cloud.download(action.id).catch(() => undefined) : undefined;
        const stored = await codec.fromFile(file, baseName(action.path), previous);
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
        const entry = entries.get(action.id)!;
        const remote = remoteById.get(action.id);
        let mtime = await disk.write(action.to, file);
        // Moving a file changes neither when it was made nor when it was last changed.
        const after = await date(action.to, { created: remote?.createdAt, modified: entry.mtimeMs });
        if (after !== null) mtime = after;
        const dated = after !== null ? remote?.createdAt !== undefined : entry.dated;
        await disk.remove(action.from);
        removedHere.add(action.from);
        taken.delete(action.from);
        taken.add(action.to);
        entries.set(action.id, { ...entry, path: action.to, mtimeMs: mtime, cloudUpdatedAt: remote?.updatedAt ?? entry.cloudUpdatedAt, ...(dated ? { dated } : {}) });
        report.movedHere++;
        return;
      }
      case 'deleteLocal':
        await disk.remove(action.path);
        removedHere.add(action.path);
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
      case 'removeFolder':
        await cloud.removeFolder(action.id);
        report.foldersRemoved++;
        return;
      case 'makeFolder':
        if (action.where === 'local') return void (await disk.makeFolder!(action.path));
        await cloud.makeFolder(action.path.split('/'));
        report.foldersMade++;
        return;
      case 'removeLocalFolder':
        if (!(await disk.removeFolder!(action.path))) leftHere.add(action.path);
        return;
    }
  }
  /** Folders removed from the account that still hold something in the vault, so they stay here (see `mirrorFolders`). */
  const leftHere = new Set<string>();

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

  // Files linked before files were dated (or by a shell that couldn't date them) get the account's creation date, once. Only that
  // date: the modification time is the file's own, and the sync tells edits by it. A file made here keeps its own creation date,
  // which is earlier than the account's. One that isn't there now (a failed action) is tried again next time.
  for (const entry of entries.values()) {
    const created = remoteById.get(entry.id)?.createdAt;
    if (entry.dated || created === undefined || !disk.setTimes) continue;
    let after: number | null;
    try {
      after = await disk.setTimes(entry.path, { created });
    } catch {
      continue;
    }
    if (after === null) break; // this shell can't date files
    entries.set(entry.id, { ...entry, dated: true });
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

  const attempt = (action: VaultAction): Promise<boolean> =>
    run(action).then(
      () => true,
      (error) => {
        report.errors.push({ action, message: error instanceof Error ? error.message : String(error) });
        return false;
      },
    );

  // Folders removed from the vault (deleted, or renamed: their files are in the new one by now) go from the account once empty there.
  // Only those the vault had at the last sync: with no memory of folders yet, nothing is removed. One that is not removed yet
  // (it still holds documents, say a held-back delete's, or the account could not be reached) is looked at again next time.
  const onDisk = new Set([...foldersOf(scanned.map((f) => f.path)), ...(diskFolders ?? [])]);
  const stillGone = new Set((state.folders ?? []).filter((path) => !onDisk.has(path)));
  // With the vault's folders listed, the two sides have the same folders, empty ones included (`mirrorFolders`).
  let mirrored: string[] | null = null;
  if (stillGone.size || diskFolders) {
    try {
      const after = await cloud.list();
      // The first sync to do so, of a vault synced before, takes the account's folders the vault does not have for removed from
      // it: until then only folders that held files were written, so one missing here was removed from the vault or emptied in it.
      const firstMirror = !!diskFolders && !state.mirrored && saved?.account === host.account;
      const missing = firstMirror ? [...folderPaths(after.folders).values()].filter((path) => !onDisk.has(path)) : [];
      const removed = new Set<string>();
      for (const { id, path } of vanishedFolders([...stillGone, ...missing], onDisk, after.docs, after.folders)) {
        if (await attempt({ kind: 'removeFolder', id, path })) {
          stillGone.delete(path);
          removed.add(id);
        }
      }
      const inAccount = new Set(folderPaths(after.folders.filter((f) => !removed.has(f.id))).values());
      for (const path of stillGone) if (!inAccount.has(path)) stillGone.delete(path);
      if (diskFolders) mirrored = await mirrorFolders(new Set(state.folders ?? []), onDisk, inAccount, stillGone);
    } catch {
      /* the account could not be listed: try again next time */
    }
  }

  /**
   * Gives each side the folders the other has, empty ones too, and returns the folders the vault has now that the account has
   * as well (with those left on one side on purpose), to remember for the next sync. `remembered` is what both had at the last
   * sync, so a folder only one side has now was either made there (and is made on the other side) or removed from the other
   * (and is removed here too, if nothing is left in it).
   */
  async function mirrorFolders(remembered: ReadonlySet<string>, onDisk: ReadonlySet<string>, inAccount: Set<string>, stillGone: ReadonlySet<string>): Promise<string[]> {
    const depth = (path: string) => path.split('/').length;
    for (const path of [...remembered].filter((p) => onDisk.has(p) && !inAccount.has(p)).sort((a, b) => depth(b) - depth(a))) {
      await attempt({ kind: 'removeLocalFolder', path });
    }
    // A name the account would spell differently (`a:b` is `a_b` there) would be made again on every sync: such a folder is left out.
    const spelledAlike = (path: string) => path.split('/').every((name) => safeName(name) === name);
    for (const path of [...onDisk].filter((p) => !remembered.has(p) && !inAccount.has(p) && spelledAlike(p)).sort((a, b) => depth(a) - depth(b))) {
      if (await attempt({ kind: 'makeFolder', path, where: 'cloud' })) inAccount.add(path);
    }
    // In the account and not here: new there, or emptied by this sync's moves and deletes (a file's folder goes with its last file).
    const here = new Set((await disk.folders!()) ?? []);
    const inGone = (path: string) => [...foldersOf([path]), path].some((p) => stillGone.has(p));
    for (const path of [...inAccount].filter((p) => !here.has(p) && !inGone(p)).sort((a, b) => depth(a) - depth(b))) {
      if (await attempt({ kind: 'makeFolder', path, where: 'local' })) here.add(path);
    }
    return [...inAccount].filter((p) => here.has(p));
  }

  state.entries = [...entries.values()];
  const filesNow = [...scanned.map((f) => f.path).filter((path) => !removedHere.has(path)), ...state.entries.map((e) => e.path)];
  if (mirrored) state.mirrored = true;
  // Not compared this time (the account could not be listed): what was remembered stays, so no folder is taken for new or removed.
  const known = mirrored ?? [...foldersOf(filesNow), ...(diskFolders && state.mirrored ? (state.folders ?? []) : [])];
  state.folders = [...new Set([...known, ...leftHere, ...stillGone])].sort();
  await host.memory.save(JSON.stringify(state));
  if (folderState?.account !== host.account || folderState.entries.length) {
    await disk.write(STATE_PATH, new TextEncoder().encode(JSON.stringify({ version: 1, account: host.account, entries: [] } satisfies State)));
  }
  return report;
}
