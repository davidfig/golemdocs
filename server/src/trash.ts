// The trash: a deleted document keeps its files in R2 (and its history) for 30 days, and its catalogue row moves to the owner's `trash`
// table. Its owner and share rows are forgotten at once (see deleteDocuments in documents.ts), so nobody can open it meanwhile, and
// restoring it makes it the owner's again, unshared.
//
// There is no scheduler: what is older than 30 days is purged whenever the owner lists their trash or deletes something. Deleting
// for good (emptying the trash) purges at once.

import { CHUNKED_FROM, deleteChunks } from './fileStore.ts';
import { indexKey, thumbKey } from './keys.ts';
import { perChunk } from './http.ts';
import type { Env } from './cf.ts';
import { deleteMedia } from './roomMedia.ts';
import { deleteHistory, TRASH_MS } from './versions.ts';
import type { UserDb } from './userDb.ts';

export interface TrashRow {
  id: string;
  name: string;
  size: number;
  r2_key: string;
  created_at: number;
  updated_at: number;
  thumb_at: number | null;
  folder_id: string | null;
  deleted_at: number;
}

/** What the client sees of a document in the trash. */
export const describeTrashed = (row: TrashRow) => ({
  id: row.id,
  name: row.name,
  size: row.size,
  updatedAt: row.updated_at,
  thumbAt: row.thumb_at ?? null,
  deletedAt: row.deleted_at,
  purgeAt: row.deleted_at + TRASH_MS,
});

/** Moves catalogue rows to the trash: the statements to run in the same transaction as their deletion. */
export function trashStatements(ids: readonly string[], now: number): { sql: string; params: unknown[] }[] {
  return perChunk(ids, (marks) => `INSERT OR REPLACE INTO trash (id, name, size, r2_key, created_at, updated_at, thumb_at, folder_id, deleted_at) SELECT id, name, size, r2_key, created_at, updated_at, thumb_at, folder_id, ? FROM documents WHERE id IN (${marks})`, [now]);
}

/** Deletes trashed documents for good: the rows, then their files, history and chunks. */
export async function purge(env: Env, ownerId: string, db: UserDb, rows: readonly Pick<TrashRow, 'id' | 'r2_key' | 'size'>[]): Promise<void> {
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  await db.runAll(perChunk(ids, (marks) => `DELETE FROM trash WHERE id IN (${marks})`));
  // R2 refuses an empty list and more than 1000 keys at once.
  const keys = rows.flatMap((row) => [row.r2_key, thumbKey(ownerId, row.id), indexKey(ownerId, row.id)]);
  for (let i = 0; i < keys.length; i += 1000) await env.FILES.delete(keys.slice(i, i + 1000));
  for (const row of rows) await deleteMedia(env, ownerId, row.id);
  // Chunks: a document kept as chunks has some, and a checkpoint may still name some of a document that is whole now.
  const chunkedVersions = new Set((await db.all<{ doc_id: string }>(`SELECT DISTINCT doc_id FROM versions WHERE chunked = 1 AND doc_id IN (${ids.map(() => '?').join(',')})`, ids)).map((r) => r.doc_id));
  for (const row of rows) if (row.size >= CHUNKED_FROM || chunkedVersions.has(row.id)) await deleteChunks(env, ownerId, row.id);
  await deleteHistory(env, ownerId, db, ids);
}

/** Purges what has been in the trash for 30 days. Failing is not the caller's problem (it will be tried again). */
export async function purgeExpired(env: Env, ownerId: string, db: UserDb, now = Date.now()): Promise<void> {
  try {
    const old = await db.all<TrashRow>('SELECT * FROM trash WHERE deleted_at < ?', [now - TRASH_MS]);
    await purge(env, ownerId, db, old);
  } catch (error) {
    console.error('purging the trash failed', error);
  }
}
