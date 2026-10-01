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
