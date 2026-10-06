// The assistant's tools for the person's library: their documents and folders, as the Documents
// screen and the Files Sidebar show them. Each takes a list, so a request about many files is one
// call (and one round trip of the conversation). The page's own state arrives through the host.

import { createFolders, moveEntries, removeFolderTree, updateFolders } from '../folderOps.ts';
import { folderContents, isInside, type Folder } from '../folders.ts';
import type { LibraryEntry } from '../sync.ts';

export interface FileToolsHost {
  /** Whether the folders are the account's (signed in) rather than this browser's. */
  cloud(): boolean;
  entries(): LibraryEntry[];
  folders(): Promise<Folder[]>;
  /** Deletes documents and folders, the same as the Documents screen's Delete. */
  deleteEntries(entries: LibraryEntry[], folderIds: string[]): Promise<void>;
  /** The account's trash (deleted documents kept for 30 days); null when there is no account to have one. */
  trash(): Promise<{ id: string; name: string; deletedAt: number; purgeAt: number }[] | null>;
  /** Puts trashed documents back; each id that could not be is reported with why. */
  restoreFromTrash(ids: string[]): Promise<{ restored: string[]; failed: string[] }>;
  /** Lists everything again and redraws the screens that show it. */
  changed(): Promise<void> | void;
}

type Args = Record<string, unknown>;

/** `args[key]` as a list of strings (nothing given is an empty list). */
function strings(args: Args, key: string): string[] {
  const v = args[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`\`${key}\` must be a list of ids.`);
  return [...new Set(v as string[])];
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What was done and what wasn't, as the tool's reply. */
function report(done: string[], skipped: string[]): string {
  if (!done.length && !skipped.length) return 'Error: nothing was given to change.';
  return [done.length ? `Done: ${done.join(', ')}.` : 'Nothing was changed.', skipped.length ? `Not done: ${skipped.join('; ')}.` : ''].filter(Boolean).join(' ');
}

export function fileTools(host: FileToolsHost): Record<string, (args: Args) => Promise<string>> {
  /** The documents and folders these ids name; the ids that name nothing are left over in `unknown`. */
  async function resolve(args: Args, fileKey = 'files', folderKey = 'folders') {
    const entries = host.entries();
    const folders = await host.folders();
    const files: LibraryEntry[] = [];
    const named: Folder[] = [];
    const unknown: string[] = [];
    for (const id of strings(args, fileKey)) {
      const entry = entries.find((e) => e.key === id);
      if (entry) files.push(entry);
      else unknown.push(`no document ${id}`);
    }
    for (const id of strings(args, folderKey)) {
      const folder = folders.find((f) => f.id === id);
      if (folder) named.push(folder);
      else unknown.push(`no folder ${id}`);
    }
    return { entries, folders, files, named, unknown };
  }

  /** `to` as a folder that exists (null: the top level). */
  function destination(args: Args, folders: Folder[]): string | null {
    const to = args.to;
    if (to === undefined) throw new Error('`to` is the folder id to move into, or null for the top level.');
    if (to === null) return null;
    if (typeof to !== 'string' || !folders.some((f) => f.id === to)) throw new Error(`There is no folder ${String(to)}.`);
    return to;
  }

  return {
    async list_files() {
      const folders = await host.folders();
      const entries = host.entries();
      const lines = [
        ...folders.map((f) => `folder ${f.id} "${f.name}" in ${f.parentId ?? 'top level'}`),
        ...entries.map((e) => `document ${e.key} "${e.name}" in ${e.folderId !== null && folders.some((f) => f.id === e.folderId) ? e.folderId : 'top level'}`),
      ];
      return lines.length ? lines.join('\n') : 'There are no documents or folders yet.';
    },

    async create_folders(args) {
      const list = args.folders;
      if (!Array.isArray(list) || !list.length) throw new Error('`folders` must be a list of { name, parent?, parent_index? }.');
      const existing = await host.folders();
      const made: { id: string; name: string; parentId: string | null }[] = [];
      list.forEach((item: { name?: unknown; parent?: unknown; parent_index?: unknown }, i) => {
        if (typeof item?.name !== 'string' || !item.name.trim()) throw new Error(`Folder ${i} needs a \`name\`.`);
        let parentId: string | null = null;
        if (item.parent_index !== undefined) {
          const at = item.parent_index;
          if (typeof at !== 'number' || !Number.isInteger(at) || at < 0 || at >= i) throw new Error(`Folder ${i}: \`parent_index\` must be the position of an earlier folder in this list.`);
          parentId = made[at]!.id;
        } else if (item.parent !== undefined && item.parent !== null) {
          if (typeof item.parent !== 'string' || !existing.some((f) => f.id === item.parent)) throw new Error(`Folder ${i}: there is no folder ${String(item.parent)}.`);
          parentId = item.parent;
        }
        made.push({ id: crypto.randomUUID(), name: item.name.trim(), parentId });
      });
      const folders = await createFolders(host.cloud(), made);
      await host.changed();
      return `Created ${count(folders.length, 'folder')}: ${folders.map((f) => `"${f.name}" (id ${f.id})`).join(', ')}.`;
    },

    async rename_folders(args) {
      const list = args.folders;
      if (!Array.isArray(list) || !list.length) throw new Error('`folders` must be a list of { id, name }.');
      const folders = await host.folders();
      const changes: { folder: Folder; name: string }[] = [];
      const skipped: string[] = [];
      for (const item of list as { id?: unknown; name?: unknown }[]) {
        const folder = folders.find((f) => f.id === item?.id);
        if (!folder) skipped.push(`no folder ${String(item?.id)}`);
        else if (typeof item.name !== 'string' || !item.name.trim()) skipped.push(`"${folder.name}" needs a name`);
        else changes.push({ folder, name: item.name.trim() });
      }
      if (changes.length) {
        await updateFolders(host.cloud(), changes);
        await host.changed();
      }
      return report(changes.length ? [`renamed ${count(changes.length, 'folder')}`] : [], skipped);
    },

    async move_files(args) {
      const { folders, files, named, unknown } = await resolve(args);
      const to = destination(args, folders);
      const skipped = [...unknown];
      const movable = named.filter((f) => {
        const bad = to !== null && (f.id === to || isInside(folders, to, f.id));
        if (bad) skipped.push(`"${f.name}" cannot go inside itself`);
        return !bad;
      });
      // A document moves with a folder that is moving: only the ones that stay behind are moved on their own.
      const alone = files.filter((e) => !movable.some((f) => folderContents(folders, [e], f).items.length));
      if (alone.length) await moveEntries(alone, to);
      if (movable.length) await updateFolders(host.cloud(), movable.map((folder) => ({ folder, parentId: to })));
      if (alone.length || movable.length) await host.changed();
      const done = [alone.length ? `moved ${count(alone.length, 'document')}` : '', movable.length ? `moved ${count(movable.length, 'folder')}` : ''].filter(Boolean);
      return report(done, skipped);
    },

    async list_trash() {
      const items = await host.trash();
      if (items === null) return "Error: the trash is part of the person's account, and nobody with sync is signed in.";
      return items.length ? items.map((i) => `trashed document ${i.id} "${i.name}", deleted ${new Date(i.deletedAt).toISOString()}, kept until ${new Date(i.purgeAt).toISOString()}`).join('\n') : 'The trash is empty.';
    },

    async restore_from_trash(args) {
      const ids = strings(args, 'files');
      if (!ids.length) throw new Error('`files` must list the ids of trashed documents (see the trash action).');
      const { restored, failed } = await host.restoreFromTrash(ids);
      if (restored.length) await host.changed();
      return report(restored.length ? [`restored ${count(restored.length, 'document')}`] : [], failed);
    },

    async delete_files(args) {
      const { entries, folders, files, named, unknown } = await resolve(args);
      const inside = new Set(named.flatMap((f) => folderContents(folders, entries, f).items));
      // Folders go with everything in them; documents and folders are deleted in one call.
      const everything = [...new Set([...files, ...inside])];
      if (named.length) await removeFolderTree(folders, entries, named, (_items, folderIds) => host.deleteEntries(everything, folderIds));
      else if (everything.length) await host.deleteEntries(everything, []);
      if (everything.length || named.length) await host.changed();
      const subfolders = new Set(named.flatMap((f) => folderContents(folders, entries, f).folders.map((x) => x.id))).size;
      const done = [everything.length ? `deleted ${count(everything.length, 'document')}` : '', subfolders ? `deleted ${count(subfolders, 'folder')}` : ''].filter(Boolean);
      return report(done, unknown);
    },
  };
}

