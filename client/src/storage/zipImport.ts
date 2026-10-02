// Import ▸ ZIP: the documents in a ZIP go in the same folders here as they were in there, making
// the folders that don't exist yet and reusing the ones that do. A document never replaces
// another: one with a name already taken in its folder gets " (2)", " (3)"…
import { ZipArchive } from '@golemdocs/docx';
import { cleanDocumentName } from '../documentName.ts';
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

/** The documents in a ZIP, with the folders they were in. Hidden files, and files of types that don't open here, are left out. */
export async function readZipFiles(bytes: Uint8Array): Promise<ZipContents> {
  const archive = ZipArchive.read(bytes);
  const files: ZipFile[] = [];
  let skipped = 0;
  for (const [path, entry] of archive.entries) {
    const segments = path.split(/[\\/]/).filter((s) => s !== '' && s !== '.' && s !== '..');
    if (!segments.length || isJunk(segments)) continue;
    const name = cleanDocumentName(segments.pop()!);
    if (!name || sourceFromFile(name, new ArrayBuffer(0)) === null) {
      skipped++;
      continue;
    }
    files.push({ folders: segments.map(cleanDocumentName).filter(Boolean), name, bytes: await entry.read() });
  }
  return { files, skipped };
}

/** What importing needs from the app: where the documents go now, and how to make folders and save. */
export interface ImportTarget {
  /** The folders that exist. */
  folders: readonly Folder[];
  /** The documents that exist, with the folder each is in (null: the top level), so their names aren't taken. */
  documents: readonly { name: string; folderId: string | null }[];
  /** The folder the ZIP's own top level goes in (null: the top level). */
  root: string | null;
  makeFolder(name: string, parentId: string | null): Promise<Folder>;
  /** Saves a document. Returns false if it couldn't be (a picture that can't be read, say), and it is counted as skipped. */
  save(name: string, bytes: Uint8Array, folderId: string | null): Promise<boolean>;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  /** Folders that had to be made. */
  folders: number;
}

/** Puts the files in their folders. A failure to make a folder or save stops it (what was done stays). */
export async function importFiles(files: readonly ZipFile[], target: ImportTarget): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: 0, folders: 0 };
  const known = new Map<string, string>(); // "parent\0name" lowercase → folder id
  for (const f of target.folders) known.set(`${f.parentId ?? ''}\0${f.name.toLowerCase()}`, f.id);
  const taken = new Map<string, Set<string>>(); // folder id ("" top level) → lowercase names
  const namesIn = (id: string | null): Set<string> => {
    let set = taken.get(id ?? '');
    if (!set) taken.set(id ?? '', (set = new Set()));
    return set;
  };
  for (const d of target.documents) namesIn(d.folderId).add(d.name.toLowerCase());

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

  for (const file of files) {
    const folderId = await folderFor(file.folders);
    const name = uniqueName(file.name, namesIn(folderId));
    if (await target.save(name, file.bytes, folderId)) result.imported++;
    else result.skipped++;
  }
  return result;
}
