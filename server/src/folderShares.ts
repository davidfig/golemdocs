// Folder sharing (docs/folder-sharing.md): who a folder is shared with, its public link, and whether a document or folder is inside
// a folder shared with someone. A folder lives in its owner's own database; the directory keeps its shares (`folder_shares`) and its
// link (`folder_links`) with the owner's id beside the folder's. A share covers whatever is in the folder and below it at the time of
// the request, so membership is worked out from the owner's folders each time, never stored.

import { randomToken } from './crypto.ts';
import type { Env } from './cf.ts';
import { HttpError } from './http.ts';
import { hasSync } from './subscriptions.ts';
import { existingUserDb, type UserDb } from './userDb.ts';

export type FolderRole = 'editor' | 'viewer';

/** A folder row as the owner's database has it (folders.ts has the full type; this module needs only these). */
export interface FolderLink {
  id: string;
  name: string;
  parent_id: string | null;
  created_by?: string | null;
}

export interface FolderShare {
  folderId: string;
  ownerId: string;
  granteeId: string;
  role: FolderRole;
  viewToken: string | null;
  localName: string | null;
  createdAt: number;
}

interface FolderShareRow {
  folder_id: string;
  owner_id: string;
  grantee_id: string;
  role: FolderRole;
  view_token: string | null;
  local_name: string | null;
  created_at: number;
}

const toShare = (r: FolderShareRow): FolderShare => ({
  folderId: r.folder_id,
  ownerId: r.owner_id,
  granteeId: r.grantee_id,
  role: r.role,
  viewToken: r.view_token,
  localName: r.local_name,
  createdAt: r.created_at,
});

/** The owner's folders, from the catalogue cache when it is current (the same list and cache GET /api/folders uses). */
export const listFolders = <T extends FolderLink>(db: UserDb): Promise<T[]> => db.cachedList<T>('folders', () => db.all<T>('SELECT * FROM folders ORDER BY name'));

/** The folders from `folderId` up to the top level, nearest first (`folderId` itself included); empty for the top level. */
export function ancestry(folders: ReadonlyMap<string, FolderLink>, folderId: string | null): string[] {
  const chain: string[] = [];
  for (let at = folderId, depth = 0; at !== null && depth <= 64; depth++) {
    chain.push(at);
    at = folders.get(at)?.parent_id ?? null;
  }
  return chain;
}

/** Whether `folderId` is `root` or inside it. */
export const within = (folders: ReadonlyMap<string, FolderLink>, folderId: string | null, root: string): boolean => ancestry(folders, folderId).includes(root);

/** Every folder under `root` (itself included). */
export function subtree(folders: Iterable<FolderLink>, root: string): Set<string> {
  const list = [...folders];
  const found = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of list) {
      if (f.parent_id !== null && found.has(f.parent_id) && !found.has(f.id)) {
        found.add(f.id);
        grew = true;
      }
    }
  }
  return found;
}

/** The person's folder shares from one owner. */
export async function folderSharesFrom(env: Env, ownerId: string, granteeId: string): Promise<FolderShare[]> {
  const { results } = await env.DIRECTORY.prepare('SELECT * FROM folder_shares WHERE owner_id = ? AND grantee_id = ?').bind(ownerId, granteeId).all<FolderShareRow>();
  return results.map(toShare);
}

/** Every folder shared with the person, newest first. */
export async function foldersSharedWith(env: Env, granteeId: string): Promise<FolderShare[]> {
  const { results } = await env.DIRECTORY.prepare('SELECT * FROM folder_shares WHERE grantee_id = ? ORDER BY created_at DESC').bind(granteeId).all<FolderShareRow>();
  return results.map(toShare);
}

/** One person's share of one folder, or null. */
export async function folderShareOf(env: Env, ownerId: string, folderId: string, granteeId: string): Promise<FolderShare | null> {
  const row = await env.DIRECTORY.prepare('SELECT * FROM folder_shares WHERE owner_id = ? AND folder_id = ? AND grantee_id = ?').bind(ownerId, folderId, granteeId).first<FolderShareRow>();
  return row ? toShare(row) : null;
}

/** Who a folder is shared with, oldest first. */
export async function folderSharesOf(env: Env, ownerId: string, folderId: string): Promise<FolderShare[]> {
  const { results } = await env.DIRECTORY.prepare('SELECT * FROM folder_shares WHERE owner_id = ? AND folder_id = ? ORDER BY created_at').bind(ownerId, folderId).all<FolderShareRow>();
  return results.map(toShare);
}

/** Shares a folder, or changes the role. A view-only share gets a viewer address of its own, kept while it stays view-only (as `shareWith`). */
export async function shareFolderWith(env: Env, ownerId: string, folderId: string, granteeId: string, role: FolderRole): Promise<void> {
  await env.DIRECTORY.prepare(
    `INSERT INTO folder_shares (folder_id, owner_id, grantee_id, role, created_at, view_token) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, folder_id, grantee_id) DO UPDATE SET
       view_token = CASE WHEN excluded.role <> 'viewer' THEN NULL WHEN folder_shares.role = 'viewer' AND folder_shares.view_token IS NOT NULL THEN folder_shares.view_token ELSE excluded.view_token END,
       role = excluded.role`,
  )
    .bind(folderId, ownerId, granteeId, role, Date.now(), role === 'viewer' ? randomToken(24) : null)
    .run();
}

export async function unshareFolder(env: Env, ownerId: string, folderId: string, granteeId: string): Promise<void> {
  await env.DIRECTORY.prepare('DELETE FROM folder_shares WHERE owner_id = ? AND folder_id = ? AND grantee_id = ?').bind(ownerId, folderId, granteeId).run();
}

/** Records the label the person's vault gave its copy of the folder (`Shared/<owner>/<folder>`), so their other computers use it too. */
export async function setLocalName(env: Env, ownerId: string, folderId: string, granteeId: string, localName: string): Promise<void> {
  await env.DIRECTORY.prepare('UPDATE folder_shares SET local_name = ? WHERE owner_id = ? AND folder_id = ? AND grantee_id = ?').bind(localName, ownerId, folderId, granteeId).run();
}

/** The folder share a person's viewer address opens, for that person only (null otherwise: answered 404, as `viewShare`). */
export async function folderViewShare(env: Env, token: string, userId: string): Promise<FolderShare | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const row = await env.DIRECTORY.prepare("SELECT * FROM folder_shares WHERE view_token = ? AND role = 'viewer'").bind(token).first<FolderShareRow>();
  return row && row.grantee_id === userId ? toShare(row) : null;
}

/** A folder's public link, or null while it has none. */
export async function folderLinkOf(env: Env, ownerId: string, folderId: string): Promise<string | null> {
  const row = await env.DIRECTORY.prepare('SELECT token FROM folder_links WHERE owner_id = ? AND folder_id = ?').bind(ownerId, folderId).first<{ token: string }>();
  return row?.token ?? null;
}

/** Gives a folder a public link, keeping the one it has unless `reset` (as `makePublicLink`). */
export async function makeFolderLink(env: Env, ownerId: string, folderId: string, reset: boolean): Promise<string> {
  await env.DIRECTORY.prepare(
    `INSERT INTO folder_links (owner_id, folder_id, token, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(owner_id, folder_id) DO UPDATE SET token = CASE WHEN ? THEN excluded.token ELSE folder_links.token END, created_at = CASE WHEN ? THEN excluded.created_at ELSE folder_links.created_at END`,
  )
    .bind(ownerId, folderId, randomToken(24), Date.now(), reset ? 1 : 0, reset ? 1 : 0)
    .run();
  return (await folderLinkOf(env, ownerId, folderId))!;
}

export async function dropFolderLink(env: Env, ownerId: string, folderId: string): Promise<void> {
  await env.DIRECTORY.prepare('DELETE FROM folder_links WHERE owner_id = ? AND folder_id = ?').bind(ownerId, folderId).run();
}

/** The folder a public link opens, for anyone: null for an unknown or dropped token. */
export async function folderPublicShare(env: Env, token: string): Promise<{ ownerId: string; folderId: string } | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const row = await env.DIRECTORY.prepare('SELECT owner_id, folder_id FROM folder_links WHERE token = ?').bind(token).first<{ owner_id: string; folder_id: string }>();
  return row ? { ownerId: row.owner_id, folderId: row.folder_id } : null;
}

/** Forgets the shares and links of deleted folders: their contents moved up or went, so nothing is under them any more. */
export async function forgetFolders(env: Env, ownerId: string, folderIds: readonly string[]): Promise<void> {
  for (let i = 0; i < folderIds.length; i += 50) {
    await env.DIRECTORY.batch(
      folderIds.slice(i, i + 50).flatMap((id) => [
        env.DIRECTORY.prepare('DELETE FROM folder_shares WHERE owner_id = ? AND folder_id = ?').bind(ownerId, id),
        env.DIRECTORY.prepare('DELETE FROM folder_links WHERE owner_id = ? AND folder_id = ?').bind(ownerId, id),
      ]),
    );
  }
}

/** What a person may do in a place of the owner's (a folder, or null for the top level) through their folder shares: the best role of a shared folder at or above it, and that folder. */
export function bestFolderShare(shares: readonly FolderShare[], folders: ReadonlyMap<string, FolderLink>, folderId: string | null): FolderShare | null {
  const above = new Set(ancestry(folders, folderId));
  let best: FolderShare | null = null;
  for (const s of shares) if (above.has(s.folderId) && (!best || (s.role === 'editor' && best.role === 'viewer'))) best = s;
  return best;
}

/** A user id as it may appear in a path: real ids are random, development ones a hash (see accounts.ts, auth.ts). */
export const OWNER_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The owner's database and folders, and the person's best share at or above `folderId`; null when they have none there. */
export async function folderAccess(env: Env, userId: string, ownerId: string, folderId: string): Promise<{ db: UserDb; share: FolderShare; folders: Map<string, FolderLink> } | null> {
  if (!OWNER_ID.test(ownerId)) return null;
  const shares = await folderSharesFrom(env, ownerId, userId);
  if (!shares.length) return null;
  const db = await existingUserDb(env, ownerId);
  if (!db) return null;
  const folders = new Map((await listFolders<FolderLink>(db)).map((f) => [f.id, f]));
  if (!folders.has(folderId)) return null;
  const share = bestFolderShare(shares, folders, folderId);
  return share ? { db, share, folders } : null;
}

/**
 * A folder of the owner's the person may add to: inside a folder shared with them as an editor, while the owner has sync. Refuses
 * with 404 (no share there, or no such folder), 403 (view only) or 403 `subscription` (the owner's sync ended).
 */
export async function editableFolder(env: Env, userId: string, ownerId: string, folderId: string): Promise<{ db: UserDb; share: FolderShare; folders: Map<string, FolderLink> }> {
  const found = await folderAccess(env, userId, ownerId, folderId);
  if (!found) throw new HttpError(404, 'not found');
  if (found.share.role !== 'editor') throw new HttpError(403, 'this folder is read-only for you');
  if (!(await hasSync(env, ownerId))) throw new HttpError(403, 'the owner’s subscription has ended', 'subscription');
  return found;
}
