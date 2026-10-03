// Files and folders dropped from the computer. One file opens as it is; several, or a folder, are
// imported like a ZIP (see zipImport.ts): each document in the folder it was in, and a ZIP among
// them in a folder named after it.

import { isZipName, stem } from '../formats/source.ts';
import { placeFile, readZipFiles, type ZipContents, type ZipFile } from './zipImport.ts';

/** What was dropped: one file to open, or documents to import (null: nothing that is a file). */
export type Dropped = { kind: 'file'; file: File } | { kind: 'import'; name: string; read(): Promise<ZipContents> } | null;

/**
 * Takes what a drop carries. Must be called during the drop event itself (the browser empties the
 * drop's items once it returns); the folders are read afterwards, by `read`.
 */
export function takeDropped(data: DataTransfer | null): Dropped {
  if (!data) return null;
  // A folder only shows as an entry; as a File it is an empty one that can't be read.
  const entries = [...data.items].flatMap((item) => {
    const entry = item.kind === 'file' ? item.webkitGetAsEntry?.() : null;
    return entry ? [entry] : [];
  });
  const files = [...data.files];
  if (!entries.length) return files.length === 1 ? { kind: 'file', file: files[0]! } : files.length ? importOf(files.map((file) => ({ path: file.name, file: () => Promise.resolve(file) }))) : null;
  if (entries.length === 1 && entries[0]!.isFile && files.length === 1) return { kind: 'file', file: files[0]! };
  return {
    kind: 'import',
    name: names(entries.map((e) => e.name)),
    read: async () => readFiles(await walk(entries)),
  };
}

/** A folder picked with the file picker (`webkitdirectory`): its files, each with its path from the picked folder's parent. */
export function pickedFolder(files: FileList): Extract<Dropped, { kind: 'import' }> {
  const list = [...files].map((file) => ({ path: file.webkitRelativePath || file.name, file: () => Promise.resolve(file) }));
  return { kind: 'import', name: list[0]?.path.split('/')[0] ?? '', read: () => readFiles(list) };
}

/** The dropped things' names, for the progress card: the first few. */
function names(all: string[]): string {
  return all.length <= 3 ? all.join(', ') : `${all.slice(0, 3).join(', ')}…`;
}

function importOf(files: { path: string; file(): Promise<File> }[]): Dropped {
  return { kind: 'import', name: names(files.map((f) => f.path)), read: () => readFiles(files) };
}

/** Every file in the dropped entries, folders searched all the way down, with its path from what was dropped. */
async function walk(entries: FileSystemEntry[], under = ''): Promise<{ path: string; file(): Promise<File> }[]> {
  const found: { path: string; file(): Promise<File> }[] = [];
  for (const entry of entries) {
    const path = `${under}${entry.name}`;
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      found.push({ path, file: () => new Promise((resolve, reject) => fileEntry.file(resolve, reject)) });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // A directory is read in batches, until one comes back empty.
      const children: FileSystemEntry[] = [];
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        children.push(...batch);
      }
      found.push(...(await walk(children, `${path}/`)));
    }
  }
  return found;
}

/** The documents among the files, each where its path puts it (a ZIP's own in a folder of its name). */
async function readFiles(files: { path: string; file(): Promise<File> }[]): Promise<ZipContents> {
  const out: ZipFile[] = [];
  let skipped = 0;
  for (const { path, file } of files) {
    if (isZipName(path)) {
      const place = placeFile(path.replace(/\.zip$/i, '.txt')); // its folders, by the rules for any file
      if (place === 'junk' || place === 'skip') continue;
      try {
        const inner = await readZipFiles(new Uint8Array(await (await file()).arrayBuffer()));
        const folder = [...place.folders, stem(place.name)];
        out.push(...inner.files.map((f) => ({ ...f, folders: [...folder, ...f.folders] })));
        skipped += inner.skipped;
      } catch {
        skipped++; // not a ZIP after all, or a damaged one
      }
      continue;
    }
    const place = placeFile(path);
    if (place === 'junk') continue;
    if (place === 'skip') {
      skipped++;
      continue;
    }
    try {
      out.push({ ...place, bytes: new Uint8Array(await (await file()).arrayBuffer()) });
    } catch {
      skipped++; // moved or deleted since it was dropped
    }
  }
  return { files: out, skipped };
}
