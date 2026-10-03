// The folder hierarchy of the dashboard: folders nest through `parentId` (null: the top level), and
// a document is in one folder (or at the top level). Pure rules only; where the folders are kept
// (this browser, or the account) is folderOps.ts.

export interface Folder {
  id: string;
  name: string;
  /** The folder it is in; null at the top level. */
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** What says where a document is: the cloud's record when it has one, else this browser's. */
interface Placed {
  cloud?: { folderId?: string | null } | null;
  local?: { folderId?: string | null } | null;
}

/** Folders by name, so the order doesn't jump around as they are used. */
function byName(a: Folder, b: Folder): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/** The folders directly inside `parentId` (null: the top level). */
export function childFolders(folders: readonly Folder[], parentId: string | null): Folder[] {
  return folders.filter((f) => f.parentId === parentId).sort(byName);
}

/**
 * Where a document is, as a folder that exists: one that has been deleted, or isn't known on this
 * device yet, counts as the top level, so a document is never lost from view.
 */
export function folderOf(item: Placed, folders: readonly Folder[]): string | null {
  const id = (item.cloud ? item.cloud.folderId : item.local?.folderId) ?? null;
  return id !== null && folders.some((f) => f.id === id) ? id : null;
}

/** The documents directly in `folderId` (null: the top level). */
export function itemsIn<T extends Placed>(items: readonly T[], folders: readonly Folder[], folderId: string | null): T[] {
  return items.filter((item) => folderOf(item, folders) === folderId);
}

/** A folder and every folder inside it (deepest first, so each can be deleted in turn), and every item in any of them. */
export function folderContents<T extends Placed>(folders: readonly Folder[], items: readonly T[], folder: Folder): { folders: Folder[]; items: T[] } {
  const all: Folder[] = [];
  const walk = (f: Folder) => {
    for (const child of childFolders(folders, f.id)) walk(child);
    all.push(f);
  };
  walk(folder);
  const ids = new Set(all.map((f) => f.id));
  return { folders: all, items: items.filter((item) => ids.has(folderOf(item, folders) ?? '')) };
}

/** The folders from the top level down to `id`, inclusive; empty for the top level. */
export function folderPath(folders: readonly Folder[], id: string | null): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: Folder[] = [];
  for (let at = id === null ? undefined : byId.get(id); at && path.length < folders.length; at = at.parentId === null ? undefined : byId.get(at.parentId)) path.unshift(at);
  return path;
}

/** Whether folder `id` is `ancestorId` or inside it (so `ancestorId` can't be moved into `id`). */
export function isInside(folders: readonly Folder[], id: string | null, ancestorId: string): boolean {
  return folderPath(folders, id).some((f) => f.id === ancestorId);
}

/**
 * Of the folders and items picked together (ticked, in a search across every folder), those not
 * inside another picked folder: moving one moves what is in it, so the rest would be pulled out of it.
 */
export function outermost<T extends Placed>(folders: readonly Folder[], picked: { folders: readonly Folder[]; items: readonly T[] }): { folders: Folder[]; items: T[] } {
  const inPicked = (id: string | null, self?: string) => picked.folders.some((f) => f.id !== self && isInside(folders, id, f.id));
  return {
    folders: picked.folders.filter((f) => !inPicked(f.parentId, f.id)),
    items: picked.items.filter((item) => !inPicked(folderOf(item, folders))),
  };
}

/** Every folder, as a tree walked depth-first, each with how deep it is: for pickers. */
export function folderTree(folders: readonly Folder[]): { folder: Folder; depth: number }[] {
  const out: { folder: Folder; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const folder of childFolders(folders, parentId)) {
      out.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** The folders with parents before the folders inside them (what a server needs them in to accept them). */
export function parentsFirst(folders: readonly Folder[]): Folder[] {
  return folderTree(folders).map((n) => n.folder);
}

/** One line of the files sidebar's tree. */
export type TreeRow<T> = { kind: 'folder'; folder: Folder; depth: number; open: boolean } | { kind: 'file'; item: T; depth: number };

/**
 * The tree the files sidebar shows, as rows from the top: each folder's own folders, then its
 * documents (by name). Only the folders in `expanded` show what is inside them.
 */
export function treeRows<T extends Placed & { name: string }>(folders: readonly Folder[], items: readonly T[], expanded: ReadonlySet<string>): TreeRow<T>[] {
  const rows: TreeRow<T>[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const folder of childFolders(folders, parentId)) {
      const open = expanded.has(folder.id);
      rows.push({ kind: 'folder', folder, depth, open });
      if (open) walk(folder.id, depth + 1);
    }
    const files = itemsIn(items, folders, parentId).sort((a, b) => a.name.localeCompare(b.name));
    for (const item of files) rows.push({ kind: 'file', item, depth });
  };
  walk(null, 0);
  return rows;
}

/**
 * What deleting `roots` (folders, with everything in them) and `docs` removes, as lines for the
 * confirmation: each folder as "A/B/" and each document as "A/B/name", paths from where the
 * deleted folder sat. A document inside a deleted folder is listed once, and not as a document alone.
 */
export function deletionList<T extends Placed & { name: string }>(folders: readonly Folder[], items: readonly T[], roots: readonly Folder[], docs: readonly T[]): string[] {
  const top = roots.filter((r) => !roots.some((o) => o !== r && isInside(folders, r.id, o.id) && r.id !== o.id));
  const lines: string[] = [];
  const seen = new Set<T>();
  const pathFrom = (from: Folder | null, id: string | null) => {
    const base = from ? folderPath(folders, from.parentId).length : 0;
    return folderPath(folders, id).slice(base).map((f) => f.name);
  };
  for (const root of top) {
    const inside = folderContents(folders, items, root);
    const list: { sort: string; line: string }[] = [];
    for (const f of inside.folders) list.push({ sort: pathFrom(root, f.id).join('/') + '/', line: pathFrom(root, f.id).join('/') + '/' });
    for (const item of inside.items) {
      seen.add(item);
      const line = [...pathFrom(root, folderOf(item, folders)), item.name].join('/');
      list.push({ sort: line, line });
    }
    list.sort((a, b) => a.sort.localeCompare(b.sort));
    lines.push(...list.map((l) => l.line));
  }
  for (const doc of docs) if (!seen.has(doc)) lines.push(doc.name);
  return lines;
}
