// Keeping links working when documents are renamed or moved, as Obsidian does: a note's `[[Plan]]` or
// `[[Notes/Plan]]` names the document by title or folder path (see formats/wikiLinks.ts), so renaming
// the document, renaming or moving a folder it is in, or moving the note that holds a relative link,
// can make it name nothing (or another document). This is the pure part: from where documents were and
// are, which links must be written differently. Finding the documents that hold links (the search
// index lists them) and writing the new links into them is main.ts's, through formats/docLinks.ts.

import { folderPath, type Folder } from './folders.ts';
import { findByTitle, normalizeTitle, splitLink, titleOfName } from './formats/wikiLinks.ts';

/** A document and the folders it is in, from the top level down. */
export interface PlacedDoc {
  key: string;
  name: string;
  folders: string[];
}

/** The documents as the library has them: each in a folder (null: the top level). */
export interface LibrarySnapshot {
  docs: { key: string; name: string; folderId: string | null }[];
  folders: Folder[];
}

/** What was done to the library. */
export type LibraryChange =
  | { kind: 'folders'; changes: { id: string; name?: string; parentId?: string | null }[] }
  | { kind: 'move'; keys: string[]; to: string | null }
  | { kind: 'rename'; key: string; name: string };

/** The snapshot as it is once `change` is made. */
export function afterChange(before: LibrarySnapshot, change: LibraryChange): LibrarySnapshot {
  if (change.kind === 'folders') {
    const by = new Map(change.changes.map((c) => [c.id, c]));
    return {
      docs: before.docs,
      folders: before.folders.map((f) => {
        const c = by.get(f.id);
        return c ? { ...f, ...(c.name !== undefined && { name: c.name }), ...(c.parentId !== undefined && { parentId: c.parentId }) } : f;
      }),
    };
  }
  if (change.kind === 'move') {
    const keys = new Set(change.keys);
    return { ...before, docs: before.docs.map((d) => (keys.has(d.key) ? { ...d, folderId: change.to } : d)) };
  }
  return { ...before, docs: before.docs.map((d) => (d.key === change.key ? { ...d, name: change.name } : d)) };
}

/** The documents of a snapshot with the names of the folders they are in. */
export function placedDocs(snapshot: LibrarySnapshot): PlacedDoc[] {
  return snapshot.docs.map((d) => ({ key: d.key, name: d.name, folders: folderPath(snapshot.folders, d.folderId).map((f) => f.name) }));
}

/** Whether any document is under another name or in other folders (`retargets` has nothing to do when none is). */
export function anyMoved(before: readonly PlacedDoc[], after: readonly PlacedDoc[]): boolean {
  const byKey = new Map(after.map((d) => [d.key, d]));
  return before.some((d) => movedOrRenamed(d, byKey.get(d.key)));
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The folders and name of a document as they are in the snapshot's other state, to see whether it moved. */
const movedOrRenamed = (a: PlacedDoc, b: PlacedDoc | undefined) => !!b && (a.name !== b.name || !same(a.folders, b.folders));

/** How to write a link to `doc` from a document in `from`, in the style (name, `/path` or `./relative`) of the link it replaces. */
function titleFor(old: string, was: PlacedDoc, doc: PlacedDoc, documents: readonly PlacedDoc[], from: readonly string[]): string {
  const { name: oldName, folders: oldFolders, exact } = splitLink(old, from);
  // `Plan.md` stays `Plan.md`, and `Plan` stays `Plan`.
  const whole = normalizeTitle(titleOfName(was.name)) !== normalizeTitle(oldName) && normalizeTitle(was.name) === normalizeTitle(oldName);
  const name = whole ? doc.name : titleOfName(doc.name);
  if (exact) {
    if (old.startsWith('/')) return `/${[...doc.folders, name].join('/')}`;
    let common = 0;
    while (common < from.length && common < doc.folders.length && from[common] === doc.folders[common]) common++;
    const up = from.length - common;
    return [...(up ? Array<string>(up).fill('..') : ['.']), ...doc.folders.slice(common), name].join('/');
  }
  return shortestTitle(doc, documents, from, oldFolders.length, name);
}

/**
 * How to write a link to `doc` from a document in `from` so that it means this document: its name when that is enough, else with as few
 * folders before it as will do (at least `folders`). `name` is the document's name as the link shows it (default: without its extension).
 */
export function shortestTitle(doc: PlacedDoc, documents: readonly PlacedDoc[], from: readonly string[], folders = 0, name = titleOfName(doc.name)): string {
  const places = { folderNames: (d: PlacedDoc) => d.folders, from };
  for (let k = Math.min(folders, doc.folders.length); k <= doc.folders.length; k++) {
    const candidate = [...doc.folders.slice(doc.folders.length - k), name].join('/');
    if (findByTitle(candidate, documents, places)?.key === doc.key) return candidate;
  }
  return `/${[...doc.folders, name].join('/')}`;
}

/**
 * The links to write differently, for each document that has links: its link titles, as written, to what each becomes. `links` is the
 * titles each document links to; `before` and `after` are where the documents were and are. A link is left alone while it still means
 * the document it meant.
 */
export function retargets(before: readonly PlacedDoc[], after: readonly PlacedDoc[], links: ReadonlyMap<string, readonly string[]>): Map<string, Map<string, string>> {
  const afterByKey = new Map(after.map((d) => [d.key, d]));
  const beforeByKey = new Map(before.map((d) => [d.key, d]));
  if (!anyMoved(before, after)) return new Map();
  const out = new Map<string, Map<string, string>>();
  for (const [key, titles] of links) {
    const linkerBefore = beforeByKey.get(key);
    const linkerAfter = afterByKey.get(key);
    if (!linkerBefore || !linkerAfter) continue;
    const fromBefore = { folderNames: (d: PlacedDoc) => d.folders, from: linkerBefore.folders };
    const fromAfter = { folderNames: (d: PlacedDoc) => d.folders, from: linkerAfter.folders };
    for (const title of titles) {
      const was = findByTitle(title, before, fromBefore);
      const now = was && afterByKey.get(was.key);
      if (!was || !now || findByTitle(title, after, fromAfter)?.key === now.key) continue;
      const next = titleFor(title, was, now, after, linkerAfter.folders);
      if (next === title) continue;
      if (!out.has(key)) out.set(key, new Map());
      out.get(key)!.set(title, next);
    }
  }
  return out;
}
