// The user's folders: /api/folders[/:id], and the checks a move into one needs. A folder is a row in
// the user's own database; documents point at theirs with `folder_id` (null: the top level).

import { cleanName, failure, HttpError, ID, idList, json, MAX_BATCH } from './http.ts';
import { subscriptionRequired } from './subscriptions.ts';
import type { UserDb } from './userDb.ts';

export interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: number;
  updated_at: number;
}

export function describeFolder(row: FolderRow) {
  return { id: row.id, name: row.name, parentId: row.parent_id, createdAt: row.created_at, updatedAt: row.updated_at };
}

export const MAX_FOLDER_DEPTH = 32;

/**
 * /api/folders[/:id]: the user's folders. Clients make the ids, so a folder made offline can be
 * sent as it is (PUT is create-or-update).
 */
export async function handleFolders(request: Request, id: string | undefined, db: UserDb | null, syncing: boolean): Promise<Response> {
  if (id === undefined) {
    // GET /api/folders
    if (request.method === 'GET') return json(db ? (await db.cachedList('folders', () => db.all<FolderRow>('SELECT * FROM folders ORDER BY name'))).map(describeFolder) : []);

    // PUT /api/folders { folders: [{ id, name, parentId }] }: creates or updates several, in order
    // (so a folder may go inside one made earlier in the list). Each is reported on its own. An
    // update may leave out the name or the parent, to keep it.
    if (request.method === 'PUT') {
      if (!db || !syncing) throw subscriptionRequired();
      const body = (await request.json().catch(() => null)) as { folders?: unknown } | null;
      if (!Array.isArray(body?.folders) || body.folders.length > MAX_BATCH) throw new HttpError(400, `expected { folders: [{ id, name, parentId }] } of at most ${MAX_BATCH}`);
      const { ok, failed } = await putFolders(db, body.folders as FolderInput[]);
      return json({ ok: ok.map((r) => r.folder), failed: failed.map((f) => failure(f.id, f.cause)) });
    }

    // DELETE /api/folders { ids }: removes the folders only; what was in each moves up.
    if (request.method === 'DELETE') {
      if (!db) throw new HttpError(404, 'not found');
      const { ok, failed } = await removeFolders(db, idList(await request.json().catch(() => null)));
      return json({ ok, failed: failed.map((f) => failure(f.id, f.cause)) });
    }
    throw new HttpError(405, 'method not allowed');
  }

  // PUT /api/folders/:id { name, parentId }: creates it, or renames and moves it.
  if (request.method === 'PUT') {
    if (!db || !syncing) throw subscriptionRequired();
    const body = (await request.json().catch(() => null)) as FolderInput | null;
    const { ok, failed } = await putFolders(db, [{ ...body, id }]);
    if (failed[0]) throw failed[0].cause;
    return json(ok[0]!.folder, ok[0]!.created ? 201 : 200);
  }

  // DELETE /api/folders/:id: removes the folder only. What was in it moves up to where it was.
  if (request.method === 'DELETE') {
    if (!db) throw new HttpError(404, 'not found');
    const { failed } = await removeFolders(db, [id]);
    if (failed[0]) throw failed[0].cause;
    return new Response(null, { status: 204 });
  }

  throw new HttpError(405, 'method not allowed');
}

/** One folder of a PUT: `name` and `parentId` may be left out of an update to keep them. */
export type FolderInput = { id?: unknown; name?: unknown; parentId?: unknown };

/** An item that did not go through, and why (`failure` turns it into what the client sees). */
export interface Refused {
  id: string;
  cause: unknown;
}

/**
 * Creates or updates folders, in order (so one may go inside a folder made earlier in the list).
 * The folder table is read once and every parent and cycle is checked against that copy, then all
 * the changes go in one request to Cloudflare: two requests however many folders, where walking
 * each one's ancestors in the database cost a request per level per folder.
 */
export async function putFolders(db: UserDb, items: FolderInput[]): Promise<{ ok: { folder: ReturnType<typeof describeFolder>; created: boolean }[]; failed: Refused[] }> {
  const folders = new Map((await db.all<FolderRow>('SELECT * FROM folders')).map((row) => [row.id, row]));
  const ok: { folder: ReturnType<typeof describeFolder>; created: boolean }[] = [];
  const failed: Refused[] = [];
  const statements: { sql: string; params: unknown[] }[] = [];
  const now = Date.now();
  for (const item of items) {
    const id = typeof item?.id === 'string' ? item.id : '';
    try {
      if (!ID.test(id)) throw new HttpError(400, 'expected an id');
      const existing = folders.get(id);
      const name = item.name === undefined && existing ? existing.name : typeof item.name === 'string' ? cleanName(item.name) : null;
      const parentId = item.parentId === undefined ? (existing?.parent_id ?? null) : item.parentId;
      if (!name || (parentId !== null && typeof parentId !== 'string')) throw new HttpError(400, 'expected { name, parentId }');
      // The parent must exist, and must not be this folder or inside it.
      let at: string | null = parentId;
      for (let depth = 0; at !== null; depth++) {
        if (at === id || depth > MAX_FOLDER_DEPTH) throw new HttpError(400, 'a folder cannot go inside itself');
        const parent: FolderRow | undefined = folders.get(at);
        if (!parent) throw new HttpError(400, 'no such folder');
        at = parent.parent_id;
      }
      const row: FolderRow = { id, name, parent_id: parentId, created_at: existing?.created_at ?? now, updated_at: now };
      folders.set(id, row);
      statements.push({
        sql: 'INSERT INTO folders (id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id, updated_at = excluded.updated_at',
        params: [id, name, parentId, now, now],
      });
      ok.push({ folder: describeFolder(row), created: !existing });
    } catch (error) {
      failed.push({ id, cause: error });
    }
  }
  try {
    await db.runAll(statements);
  } catch (error) {
    // One transaction, so none of them was saved.
    failed.push(...ok.splice(0).map((r) => ({ id: r.folder.id, cause: error })));
    console.error(error);
  }
  return { ok, failed };
}

/**
 * Deletes the folders only: what was in each moves up to where it was. Two requests to Cloudflare
 * however many: the table is read once, and the moves and deletes go together as one transaction.
 */
export async function removeFolders(db: UserDb, ids: string[]): Promise<{ ok: string[]; failed: Refused[] }> {
  const folders = new Map((await db.all<FolderRow>('SELECT * FROM folders')).map((row) => [row.id, { ...row }]));
  const ok: string[] = [];
  const failed: Refused[] = [];
  const statements: { sql: string; params: unknown[] }[] = [];
  for (const id of ids) {
    const row = folders.get(id);
    if (!row) {
      failed.push({ id, cause: new HttpError(404, 'not found') });
      continue;
    }
    // The copy follows the changes, so removing a folder and then its parent moves what was in it up twice.
    folders.delete(id);
    for (const child of folders.values()) if (child.parent_id === id) child.parent_id = row.parent_id;
    statements.push(
      { sql: 'UPDATE folders SET parent_id = ? WHERE parent_id = ?', params: [row.parent_id, id] },
      { sql: 'UPDATE documents SET folder_id = ? WHERE folder_id = ?', params: [row.parent_id, id] },
      { sql: 'DELETE FROM folders WHERE id = ?', params: [id] },
    );
    ok.push(id);
  }
  try {
    await db.runAll(statements);
  } catch (error) {
    failed.push(...ok.splice(0).map((id) => ({ id, cause: error })));
    console.error(error);
  }
  return { ok, failed };
}

/** Checks a move's destination: a folder of the owner's, or null for the top level. */
export async function checkFolder(db: UserDb, folderId: unknown): Promise<string | null> {
  if (folderId !== null && typeof folderId !== 'string') throw new HttpError(400, 'expected { folderId }');
  if (folderId !== null && !(await db.first('SELECT 1 FROM folders WHERE id = ?', [folderId]))) throw new HttpError(400, 'no such folder');
  return folderId;
}
