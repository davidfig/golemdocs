// A shared folder in the viewer (/view?f=… and /view?pf=…, docs/folder-sharing.md): which of its files a link in one of them goes
// to, and its files as a tree. Only the folder's own files are ever found, so a link to anything outside it goes nowhere.

import { parseDocAddress } from '@golemdocs/docx';
import { findByTitle, normalizeTitle } from '../formats/wikiLinks.ts';

/** A file of the folder: its path inside it (`Notes/Plan.md`). */
export interface FolderFile {
  path: string;
}

const segments = (path: string): string[] => path.split('/');

/**
 * The file a `doc:Title#Section` link in the file at `from` goes to, and the section, or null when it isn't one of the folder's
 * (`root` is the shared folder's name). Links resolve as in the app (`findByTitle`), with every file's folders starting at the shared
 * folder. A link from the top of the owner's vault (`/Projects/Shared/Notes/Plan`) is read from the shared folder's name on, its
 * last mention in the link: the viewer doesn't know (and isn't told) where the folder sits in the owner's vault.
 */
export function resolveFolderLink<T extends FolderFile>(address: string, root: string, files: readonly T[], from: string): { file: T; section: string } | null {
  const parsed = parseDocAddress(address);
  if (!parsed) return null;
  let title = parsed.title;
  if (title.startsWith('/')) {
    const parts = segments(title.slice(1));
    const name = parts.pop() ?? '';
    const at = parts.map(normalizeTitle).lastIndexOf(normalizeTitle(root));
    if (at < 0) return null;
    title = `/${[...parts.slice(at), name].join('/')}`;
  }
  const folderNames = (file: T): string[] => [root, ...segments(file.path).slice(0, -1)];
  const named = files.map((file) => ({ file, name: segments(file.path).pop() ?? '' }));
  const found = findByTitle(title, named, { folderNames: (d) => folderNames(d.file), from: [root, ...segments(from).slice(0, -1)] });
  return found ? { file: found.file, section: parsed.section } : null;
}

/** A folder of the tree: its name, the folders in it and its files, in the order the server listed them. */
export interface TreeFolder<T> {
  name: string;
  path: string;
  folders: TreeFolder<T>[];
  files: T[];
}

/** The folder's paths as a tree (`folders` are the paths of its subfolders, empty ones too). */
export function folderTree<T extends FolderFile>(folders: readonly string[], files: readonly T[]): TreeFolder<T> {
  const top: TreeFolder<T> = { name: '', path: '', folders: [], files: [] };
  const byPath = new Map<string, TreeFolder<T>>([['', top]]);
  const folderAt = (path: string): TreeFolder<T> => {
    const known = byPath.get(path);
    if (known) return known;
    const cut = path.lastIndexOf('/');
    const parent = folderAt(cut < 0 ? '' : path.slice(0, cut));
    const made: TreeFolder<T> = { name: path.slice(cut + 1), path, folders: [], files: [] };
    parent.folders.push(made);
    byPath.set(path, made);
    return made;
  };
  for (const path of folders) folderAt(path);
  for (const file of files) {
    const cut = file.path.lastIndexOf('/');
    folderAt(cut < 0 ? '' : file.path.slice(0, cut)).files.push(file);
  }
  return top;
}

/** The file to show first when the address names none: a README or index at the top, else the first file at the top, else any. */
export function firstFile<T extends FolderFile>(files: readonly T[]): T | undefined {
  const top = files.filter((f) => !f.path.includes('/'));
  return top.find((f) => /^(readme|index)\b/i.test(f.path)) ?? top[0] ?? files[0];
}
