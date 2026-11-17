// Folder sharing's routes (docs/folder-sharing.md). The rules for who may do what are in folderShares.ts and, for documents,
// `accessFor` in sharing.ts; this file only answers requests.
//
// - The owner: /api/folders/:id/shares[/:userId] (who it is shared with) and /api/folders/:id/link (its public link).
// - The people it is shared with: /api/shared-folders (the list), /api/shared-folders/:owner/:folder (PATCH their vault label, DELETE
//   to leave), …/tree (what is in it, for the app), …/folders/:id (an editor makes a folder, or renames or deletes one they made).
//   Documents are added through POST /api/documents?owner=…&folder=… and opened, saved, renamed and deleted through the document routes.
// - The viewer: /api/folder-view/:token[/file?path=…] for a person, /api/folder-public/:token[/file?path=…] for anyone. Files are
//   named by their path inside the shared folder, never their ids.

import type { Env } from './cf.ts';
import { DOCX } from './keys.ts';
import { documentResponse } from './fileStore.ts';
import {
  dropFolderLink,
  editableFolder,
  folderAccess,
  folderLinkOf,
  folderPublicShare,
  folderShareOf,
  folderSharesOf,
  foldersSharedWith,
  folderViewShare,
  forgetFolders,
  listFolders,
  makeFolderLink,
  OWNER_ID,
  setLocalName,
  shareFolderWith,
  subtree,
  unshareFolder,
  type FolderLink,
  type FolderRole,
  type FolderShare,
} from './folderShares.ts';
import { removeFolders, type FolderRow } from './folders.ts';
import { cleanName, HttpError, ID, json } from './http.ts';
import { describe, listDocuments, ownStorage } from './documents.ts';
import { kickFromRoom, rejoinRoom } from './roomGate.ts';
import { person, userByEmail } from './sharing.ts';
import { hasSync, subscriptionRequired } from './subscriptions.ts';
import { existingUserDb, type UserDb } from './userDb.ts';

/** Most documents a shared folder lists; beyond this the tree says it was cut short. */
export const MAX_TREE_DOCUMENTS = 5000;

type DocumentRow = Parameters<typeof describe>[0] & { created_by?: string | null };

/** The documents in the owner's folders under `root`, and those folders (the root included). */
async function contents(env: Env, ownerId: string, db: UserDb, root: string, folders?: Map<string, FolderLink>) {
  const all = folders ?? new Map((await listFolders<FolderRow>(db)).map((f) => [f.id, f]));
  const inside = subtree(all.values(), root);
  const documents = (await listDocuments(env, ownerId, db)).filter((row) => row.folder_id !== null && inside.has(row.folder_id)) as DocumentRow[];
  return { folders: [...inside].map((id) => all.get(id)!).filter(Boolean), documents, all };
}

/** Runs `work` for each item, a few at a time, after the response when it can (`defer`). */
function eachLater<T>(items: readonly T[], work: (item: T) => Promise<unknown>, defer?: (work: Promise<unknown>) => void): Promise<void> | void {
  const run = async () => {
    for (let i = 0; i < items.length; i += 20) await Promise.all(items.slice(i, i + 20).map((item) => work(item).catch((error) => console.error(error))));
  };
  if (defer) defer(run());
  else return run();
}

/**
 * /api/folders/:id/shares[/:userId] and /api/folders/:id/link: the owner's own folder. GET /shares lists who it is shared with, PUT
 * { email, role } shares it or changes the role, DELETE /shares/:userId takes it away (the person may leave through
 * /api/shared-folders instead). /link is as a document's (GET { token }, PUT makes one, POST replaces it, DELETE turns it off).
 */
export async function handleFolderLinkOrShares(request: Request, env: Env, userId: string, folderId: string, sub: 'shares' | 'link', granteeId: string | undefined, defer?: (work: Promise<unknown>) => void): Promise<Response> {
  const { syncing, ownDb } = await ownStorage(env, userId, 'GET');
  const folder = ownDb && (await ownDb.first<FolderRow>('SELECT * FROM folders WHERE id = ?', [folderId]));
  if (!ownDb || !folder) throw new HttpError(404, 'not found');
  const requireSync = () => {
    if (!syncing) throw subscriptionRequired();
  };
  // Documents whose rooms someone may be in through this share, to send them out or back in with their new role.
  const documentsUnder = async () => (await contents(env, userId, ownDb, folderId)).documents.map((d) => d.id);

  if (sub === 'link') {
    if (granteeId !== undefined) throw new HttpError(404, 'not found');
    if (request.method === 'GET') return json({ token: await folderLinkOf(env, userId, folderId) });
    if (request.method === 'PUT' || request.method === 'POST') {
      requireSync();
      return json({ token: await makeFolderLink(env, userId, folderId, request.method === 'POST') });
    }
    if (request.method === 'DELETE') {
      await dropFolderLink(env, userId, folderId);
      return new Response(null, { status: 204 });
    }
    throw new HttpError(405, 'method not allowed');
  }

  if (granteeId === undefined && request.method === 'GET') {
    const shares = await folderSharesOf(env, userId, folderId);
    return json(await Promise.all(shares.map(async (s) => ({ ...(await person(env, s.granteeId)), role: s.role }))));
  }
  if (granteeId === undefined && request.method === 'PUT') {
    requireSync();
    const body = (await request.json().catch(() => null)) as { email?: unknown; role?: unknown } | null;
    if (typeof body?.email !== 'string' || (body.role !== 'editor' && body.role !== 'viewer')) throw new HttpError(400, 'expected { email, role: "editor" | "viewer" }');
    const target = await userByEmail(env, body.email);
    if (!target) throw new HttpError(404, 'nobody with that email has signed in to Golem Docs yet');
    if (target === userId) throw new HttpError(400, 'you already own this folder');
    const before = await folderShareOf(env, userId, folderId, target);
    const role: FolderRole = body.role;
    await shareFolderWith(env, userId, folderId, target, role);
    // Anyone already editing a document in it keeps the role they joined with until they reconnect: make them.
    if (before && before.role !== role) await eachLater(await documentsUnder(), (id) => rejoinRoom(env, id, target), defer);
    return json({ ...(await person(env, target)), role });
  }
  if (granteeId !== undefined && request.method === 'DELETE') {
    await unshareFolder(env, userId, folderId, granteeId);
    await eachLater(await documentsUnder(), (id) => kickFromRoom(env, id, granteeId), defer);
    return new Response(null, { status: 204 });
  }
  throw new HttpError(405, 'method not allowed');
}

/** What the person's list says of one folder shared with them. */
async function describeShare(env: Env, share: FolderShare, folder: FolderLink) {
  const owner = await person(env, share.ownerId);
  return {
    ownerId: share.ownerId,
    folderId: share.folderId,
    name: folder.name,
    role: share.role,
    owner: { name: owner.name, email: owner.email },
    localName: share.localName,
    createdAt: share.createdAt,
    ...(share.viewToken && { viewToken: share.viewToken }),
  };
}

export interface SharedFolderRoute {
  ownerId?: string;
  folderId?: string;
  sub?: 'tree' | 'folders';
  childId?: string;
}

/** /api/shared-folders[…]: folders other people shared with this user (see the top of this file). */
export async function handleSharedFolders(request: Request, env: Env, userId: string, route: SharedFolderRoute, defer?: (work: Promise<unknown>) => void): Promise<Response> {
  const { ownerId, folderId, sub, childId } = route;

  // GET /api/shared-folders: every folder shared with the person whose owner still has sync, with its role and owner.
  if (ownerId === undefined) {
    if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
    const byOwner = new Map<string, FolderShare[]>();
    for (const s of await foldersSharedWith(env, userId)) byOwner.set(s.ownerId, [...(byOwner.get(s.ownerId) ?? []), s]);
    const perOwner = await Promise.all(
      [...byOwner].map(async ([owner, shares]) => {
        if (!(await hasSync(env, owner))) return [];
        const db = await existingUserDb(env, owner);
        if (!db) return [];
        const folders = new Map((await listFolders<FolderLink>(db)).map((f) => [f.id, f]));
        return Promise.all(shares.filter((s) => folders.has(s.folderId)).map((s) => describeShare(env, s, folders.get(s.folderId)!)));
      }),
    );
    return json(perOwner.flat());
  }

  if (!OWNER_ID.test(ownerId) || !folderId || !ID.test(folderId)) throw new HttpError(404, 'not found');

  // DELETE /api/shared-folders/:owner/:folder: the person leaves it (whether or not the owner still has sync).
  if (sub === undefined && request.method === 'DELETE') {
    const share = await folderShareOf(env, ownerId, folderId, userId);
    if (!share) throw new HttpError(404, 'not found');
    await unshareFolder(env, ownerId, folderId, userId);
    const db = await existingUserDb(env, ownerId);
    if (db) await eachLater((await contents(env, ownerId, db, folderId)).documents.map((d) => d.id), (id) => kickFromRoom(env, id, userId), defer);
    return new Response(null, { status: 204 });
  }

  // The rest need the share itself (not one above it: the person's list names what was shared) and the owner's sync.
  const share = await folderShareOf(env, ownerId, folderId, userId);
  if (!share) throw new HttpError(404, 'not found');
  if (!(await hasSync(env, ownerId))) throw new HttpError(403, 'the owner’s subscription has ended', 'subscription');
  const found = await folderAccess(env, userId, ownerId, folderId);
  if (!found) throw new HttpError(404, 'not found');
  const { db } = found;
  const role = found.share.role;

  // PATCH /api/shared-folders/:owner/:folder { localName }: the label their vault gave its copy (Shared/<owner>/<folder>).
  if (sub === undefined && request.method === 'PATCH') {
    const body = (await request.json().catch(() => null)) as { localName?: unknown } | null;
    const localName = typeof body?.localName === 'string' ? cleanName(body.localName) : null;
    if (!localName || localName.length > 512) throw new HttpError(400, 'expected { localName }');
    await setLocalName(env, ownerId, folderId, userId, localName);
    return json({ ok: true });
  }
  if (sub === undefined && request.method === 'GET') return json(await describeShare(env, share, found.folders.get(folderId)!));

  // GET …/tree: the folders and documents in it, as the app shows them. Ids are given here: the person opens and saves them.
  if (sub === 'tree') {
    if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
    const { folders, documents } = await contents(env, ownerId, db, folderId, found.folders);
    const listed = documents.slice(0, MAX_TREE_DOCUMENTS);
    // Each document's path inside the shared folder, as the viewer's address names it (a viewer opens documents there).
    const paths = new Map([...pathsOf(folderId, folders as FolderRow[], listed).byPath].map(([path, id]) => [id, path]));
    return json({
      ...(await describeShare(env, share, found.folders.get(folderId)!)),
      role,
      folders: folders.map((f) => ({ id: f.id, name: f.name, parentId: f.id === folderId ? null : f.parent_id, createdByYou: f.created_by === userId })),
      documents: listed.map((row) => ({ ...describe(row, role), folderId: row.folder_id, path: paths.get(row.id), createdByYou: row.created_by === userId })),
      truncated: documents.length > listed.length,
    });
  }

  // PUT …/folders/:id { name, parentId }: an editor makes a folder inside, or renames one they made. DELETE …/folders/:id: deletes one
  // they made (what is in it moves up, as when the owner deletes a folder). Nothing is moved, and the owner's folders are left alone.
  if (sub === 'folders') {
    if (!childId || !ID.test(childId)) throw new HttpError(404, 'not found');
    const existing = found.folders.get(childId);
    const inside = subtree(found.folders.values(), folderId);
    if (existing && !inside.has(childId)) throw new HttpError(404, 'not found');
    if (request.method === 'PUT') {
      const body = (await request.json().catch(() => null)) as { name?: unknown; parentId?: unknown } | null;
      const name = typeof body?.name === 'string' ? cleanName(body.name) : null;
      if (!name) throw new HttpError(400, 'expected { name, parentId }');
      if (existing) {
        if (existing.created_by !== userId) throw new HttpError(403, 'only the owner can rename this folder');
        if (body?.parentId !== undefined && body.parentId !== existing.parent_id) throw new HttpError(403, 'only the owner can move this folder');
        await editableFolder(env, userId, ownerId, childId);
        await db.run('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?', [name, Date.now(), childId]);
        return json({ id: childId, name, parentId: existing.parent_id, createdByYou: true });
      }
      const parentId = body?.parentId;
      if (typeof parentId !== 'string' || !inside.has(parentId)) throw new HttpError(400, 'no such folder');
      await editableFolder(env, userId, ownerId, parentId);
      const now = Date.now();
      await db.run('INSERT INTO folders (id, name, parent_id, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?)', [childId, name, parentId, now, now, userId]);
      return json({ id: childId, name, parentId, createdByYou: true }, 201);
    }
    if (request.method === 'DELETE') {
      if (!existing) throw new HttpError(404, 'not found');
      if (existing.created_by !== userId || childId === folderId) throw new HttpError(403, 'only the owner can delete this folder');
      await editableFolder(env, userId, ownerId, childId);
      const { failed } = await removeFolders(db, [childId]);
      if (failed[0]) throw failed[0].cause;
      await forgetFolders(env, ownerId, [childId]);
      return new Response(null, { status: 204 });
    }
    throw new HttpError(405, 'method not allowed');
  }
  throw new HttpError(405, 'method not allowed');
}

/** A name as a path part: no slashes, which would split it. */
const pathPart = (name: string): string => name.replace(/[/\\]/g, '-').trim() || 'Untitled';

/** Keeps two items of one folder with the same name apart: "Plan.md", "Plan (2).md", by creation order. */
function distinct<T extends { name: string; created_at: number }>(items: T[]): Map<T, string> {
  const seen = new Set<string>();
  const names = new Map<T, string>();
  for (const item of [...items].sort((a, b) => a.created_at - b.created_at)) {
    const base = pathPart(item.name);
    let name = base;
    for (let n = 2; seen.has(name.toLowerCase()); n++) {
      const dot = base.lastIndexOf('.');
      name = dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})`;
    }
    seen.add(name.toLowerCase());
    names.set(item, name);
  }
  return names;
}

export interface TreeEntry {
  path: string;
  updatedAt: number;
  size: number;
}

/** The shared folder's files and folders as paths inside it, as the viewer names them; and the document behind each file's path. */
export function pathsOf(root: string, folders: readonly (FolderLink & { created_at: number })[], documents: readonly DocumentRow[]) {
  const children = new Map<string | null, (FolderLink & { created_at: number })[]>();
  for (const f of folders) if (f.id !== root) children.set(f.parent_id, [...(children.get(f.parent_id) ?? []), f]);
  const documentsIn = new Map<string, DocumentRow[]>();
  for (const d of documents) documentsIn.set(d.folder_id!, [...(documentsIn.get(d.folder_id!) ?? []), d]);
  const folderPaths: string[] = [];
  const files: TreeEntry[] = [];
  const byPath = new Map<string, string>();
  const walk = (folderId: string, prefix: string, depth: number) => {
    if (depth > 64) return;
    // Folders and files share a folder's names, as they do on a disk.
    const here = [...(children.get(folderId) ?? []).map((f) => ({ kind: 'folder' as const, item: f, name: f.name, created_at: f.created_at })), ...(documentsIn.get(folderId) ?? []).map((d) => ({ kind: 'file' as const, item: d, name: d.name, created_at: d.created_at }))];
    for (const [entry, name] of distinct(here)) {
      const path = prefix + name;
      if (entry.kind === 'folder') {
        folderPaths.push(path);
        walk(entry.item.id, `${path}/`, depth + 1);
      } else {
        const d = entry.item as DocumentRow;
        files.push({ path, updatedAt: d.updated_at, size: d.size });
        byPath.set(path, d.id);
      }
    }
  };
  walk(root, '', 0);
  folderPaths.sort();
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { folders: folderPaths, files, byPath };
}

/**
 * GET /api/folder-view/:token (a person's view-only share, `userId` set) and /api/folder-public/:token (its public link, for anyone):
 * the folder's name and tree (`{ name, folders: [path], files: [{ path, updatedAt, size }], truncated }`). With /file?path=…, that
 * file (304 for `If-None-Match` while unchanged). Paths are inside the shared folder; nothing answered names an id. An unknown, dropped
 * or someone else's token, a folder that is gone, an owner without sync and a path that is not in the tree all answer 404. Public
 * answers may be kept a minute and are never indexed.
 */
export async function handleFolderView(request: Request, env: Env, url: URL, userId: string | null, token: string, file: boolean): Promise<Response> {
  if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
  const target = userId === null ? await folderPublicShare(env, token) : await folderViewShare(env, token, userId);
  if (!target) throw new HttpError(404, 'not found');
  if (!(await hasSync(env, target.ownerId))) {
    if (userId === null) throw new HttpError(404, 'not found');
    throw new HttpError(403, 'the owner’s subscription has ended', 'subscription');
  }
  const db = await existingUserDb(env, target.ownerId);
  if (!db) throw new HttpError(404, 'not found');
  const all = new Map((await listFolders<FolderRow>(db)).map((f) => [f.id, f]));
  const root = all.get(target.folderId);
  if (!root) throw new HttpError(404, 'not found');
  const { folders, documents } = await contents(env, target.ownerId, db, target.folderId, all);
  const listed = documents.slice(0, MAX_TREE_DOCUMENTS);
  const tree = pathsOf(target.folderId, folders as FolderRow[], listed);
  const headers: Record<string, string> = { 'x-robots-tag': 'noindex, nofollow', ...(userId === null ? { 'cache-control': 'public, max-age=60' } : {}) };
  if (!file) return json({ name: root.name, folders: tree.folders, files: tree.files, truncated: documents.length > listed.length }, 200, headers);
  const docId = tree.byPath.get(url.searchParams.get('path') ?? '');
  const row = docId && listed.find((d) => d.id === docId);
  if (!row) throw new HttpError(404, 'not found');
  const response = await documentResponse(env, row.r2_key, target.ownerId, row.id, DOCX, request.headers.get('if-none-match'));
  if (!response) throw new HttpError(404, 'not found');
  const out = new Headers(response.headers);
  for (const [k, v] of Object.entries(headers)) out.set(k, v);
  return new Response(response.body, { status: response.status, headers: out });
}
