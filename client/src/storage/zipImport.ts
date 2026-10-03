// Import ▸ ZIP: the documents in a ZIP go in the same folders here as they were in there, making
// the folders that don't exist yet and reusing the ones that do. A file identical to the document
// already there is left alone. For one that differs, the user chooses (once, or for all of them) to
// overwrite it, keep both (the new one gets " (2)", " (3)"…) or skip it.
import { ZipArchive } from '@golemdocs/docx';
import { cleanDocumentName } from '../documentName.ts';
import { keptPictureName } from '../formats/images.ts';
import { sourceFromFile } from '../formats/source.ts';
import type { Folder } from '../folders.ts';
import { uniqueName } from './uniqueName.ts';

export interface ZipFile {
  /** The names of the folders it is in, outermost first; empty at the top level. */
  folders: string[];
  name: string;
  bytes: Uint8Array;
}

/** What is in a ZIP that can be imported, and how many files there were that can't be opened here. */
export interface ZipContents {
  files: ZipFile[];
  skipped: number;
}

/** Folder names the system adds to a ZIP, or a name that is hidden: not the user's documents. */
const isJunk = (segments: readonly string[]): boolean => segments[0] === '__MACOSX' || segments.some((s) => s.startsWith('.'));

/**
 * Where a file at `path` (in a ZIP, or a folder dropped from the computer) goes: its folders and the
 * name it is kept under. 'junk' for what the system adds or hides (left out, unmentioned), 'skip' for
 * a type that doesn't open here (counted).
 */
export function placeFile(path: string): { folders: string[]; name: string } | 'junk' | 'skip' {
  const segments = path.split(/[\\/]/).filter((s) => s !== '' && s !== '.' && s !== '..');
  if (!segments.length || isJunk(segments)) return 'junk';
  // Under the name it is kept as (a GIF as a PNG), so " (2)" is added where that one is taken.
  const name = keptPictureName(cleanDocumentName(segments.pop()!));
  if (!name || sourceFromFile(name, new ArrayBuffer(0)) === null) return 'skip';
  return { folders: segments.map(cleanDocumentName).filter(Boolean), name };
}

/** The documents in a ZIP, with the folders they were in. Hidden files, and files of types that don't open here, are left out. */
export async function readZipFiles(bytes: Uint8Array, progress: { signal?: AbortSignal; onProgress?(done: number, total: number): void } = {}): Promise<ZipContents> {
  // One file that can't be read (encrypted, say) is skipped, not the reason the rest aren't imported.
  const archive = ZipArchive.read(bytes, { lenient: true });
  const files: ZipFile[] = [];
  let skipped = archive.unreadable.filter((path) => placeFile(path) !== 'junk').length;
  let done = 0;
  for (const [path, entry] of archive.entries) {
    // An abort rejects with its AbortError; what was read is dropped.
    progress.signal?.throwIfAborted();
    progress.onProgress?.(done++, archive.entries.size);
    const place = placeFile(path);
    if (place === 'junk') continue;
    if (place === 'skip') {
      skipped++;
      continue;
    }
    try {
      files.push({ ...place, bytes: await entry.read() });
    } catch {
      skipped++; // damaged
    }
  }
  return { files, skipped };
}

/** Whether two byte sequences are identical. */
export function sameBytes(a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array): boolean {
  const x = a instanceof Uint8Array ? a : new Uint8Array(a);
  const y = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** What importing needs from the app: where the documents go now, and how to make folders and save. */
export interface ImportTarget {
  /** The folders that exist. */
  folders: readonly Folder[];
  /** The documents that exist, with the folder each is in (null: the top level), so their names aren't taken. */
  documents: readonly { name: string; folderId: string | null; id?: string }[];
  /** The folder the ZIP's own top level goes in (null: the top level). */
  root: string | null;
  makeFolder(name: string, parentId: string | null): Promise<Folder>;
  /** Saves a document. Returns false if it couldn't be (a picture that can't be read, say), and it is counted as skipped. */
  save(name: string, bytes: Uint8Array, folderId: string | null): Promise<boolean>;
  /** Whether the document `id` already holds exactly these bytes (false when it isn't loaded here, so can't be compared). */
  same?(id: string, name: string, bytes: Uint8Array): Promise<boolean>;
  /** Replaces the contents of the document `id`. Returns false if it couldn't be, and it is counted as skipped. */
  replace?(id: string, name: string, bytes: Uint8Array): Promise<boolean>;
  /** Asks what to do with a file whose name is taken by a document with other contents. Without it, both are kept. */
  ask?(duplicate: Duplicate): Promise<DuplicateChoice>;
  /** Stops after the file being saved when it aborts; what was done stays. */
  signal?: AbortSignal;
  /** Called before each file, with how many are done. */
  onProgress?(done: number, total: number): void;
}

/** A file whose name is taken in its folder, by a document with other contents. */
export interface Duplicate {
  name: string;
  /** The folders it is in, outermost first; empty at the top level. */
  folders: string[];
}

export type DuplicateAction = 'overwrite' | 'rename' | 'skip';

/** What the user chose: `all` applies it to every later duplicate too; 'cancel' stops the import. */
export type DuplicateChoice = { action: DuplicateAction; all: boolean } | 'cancel';

export interface ImportResult {
  imported: number;
  /** Of those imported, how many replaced a document. */
  replaced: number;
  /** Files not imported because the document there was identical, or the user chose to skip them. */
  unchanged: number;
  skipped: number;
  /** Folders that had to be made. */
  folders: number;
  /** It was stopped before the last file. */
  cancelled: boolean;
}

/** Puts the files in their folders. A failure to make a folder or save stops it (what was done stays). */
export async function importFiles(files: readonly ZipFile[], target: ImportTarget): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, replaced: 0, unchanged: 0, skipped: 0, folders: 0, cancelled: false };
  const known = new Map<string, string>(); // "parent\0name" lowercase → folder id
  for (const f of target.folders) known.set(`${f.parentId ?? ''}\0${f.name.toLowerCase()}`, f.id);
  const taken = new Map<string, Set<string>>(); // folder id ("" top level) → lowercase names
  const namesIn = (id: string | null): Set<string> => {
    let set = taken.get(id ?? '');
    if (!set) taken.set(id ?? '', (set = new Set()));
    return set;
  };
  const existing = new Map<string, string>(); // "folder\0name" lowercase → document id
  const keyOf = (folderId: string | null, name: string) => `${folderId ?? ''}\0${name.toLowerCase()}`;
  for (const d of target.documents) {
    namesIn(d.folderId).add(d.name.toLowerCase());
    if (d.id !== undefined && !existing.has(keyOf(d.folderId, d.name))) existing.set(keyOf(d.folderId, d.name), d.id);
  }
  // Names already settled, so a second file of that name in the same import is only renamed.
  const settled = new Set<string>();
  let always: DuplicateAction | null = null;

  const folderFor = async (names: readonly string[]): Promise<string | null> => {
    let parent = target.root;
    for (const name of names) {
      const key = `${parent ?? ''}\0${name.toLowerCase()}`;
      let id = known.get(key);
      if (!id) {
        id = (await target.makeFolder(name, parent)).id;
        known.set(key, id);
        result.folders++;
      }
      parent = id;
    }
    return parent;
  };

  for (const [i, file] of files.entries()) {
    if (target.signal?.aborted) {
      result.cancelled = true;
      break;
    }
    target.onProgress?.(i, files.length);
    const folderId = await folderFor(file.folders);
    const key = keyOf(folderId, file.name);
    const id = existing.get(key);
    if (id !== undefined && !settled.has(key)) {
      settled.add(key);
      if (await target.same?.(id, file.name, file.bytes)) {
        result.unchanged++;
        continue;
      }
      let action: DuplicateAction = 'rename';
      if (always) action = always;
      else if (target.ask) {
        const choice = await target.ask({ name: file.name, folders: file.folders });
        if (choice === 'cancel') {
          result.cancelled = true;
          break;
        }
        action = choice.action;
        if (choice.all) always = action;
      }
      if (action === 'skip') {
        result.unchanged++;
        continue;
      }
      if (action === 'overwrite' && target.replace) {
        if (await target.replace(id, file.name, file.bytes)) {
          result.imported++;
          result.replaced++;
        } else result.skipped++;
        continue;
      }
    }
    const name = uniqueName(file.name, namesIn(folderId));
    if (await target.save(name, file.bytes, folderId)) result.imported++;
    else result.skipped++;
  }
  return result;
}
