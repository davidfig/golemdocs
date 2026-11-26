// The user's documents: /api/documents[/:id[/thumbnail|/shares[/:userId]]], the batch upload and
// bulk calls on /api/documents, and /api/shared (what other people shared with this user). A document
// is a row in its owner's own database, its bytes and thumbnail are objects in R2 (see keys.ts), and
// who else may open it is kept in the directory (see sharing.ts).

import { documentIndex } from './docIndex.ts';
import { DELTA, applyDelta, deleteChunkList, deleteChunks, deltaSize, documentResponse, isChunked, previousManifest, readDocument } from './fileStore.ts';
import { isSealed } from '@golemdocs/ops';
import { DOCX, docxKey, historyKey, indexKey, pageKey, thumbKey } from './keys.ts';
import type { Env } from './cf.ts';
import { cleanName, failure, HttpError, idList, IDS_PER_QUERY, json, MAX_BATCH, perChunk, type Failure } from './http.ts';
import { checkMove, type FolderRow } from './folders.ts';
import { folderEncrypts, refuseEncrypted, requireOpen, requireSealedWith, sealedName, wrappedKey } from './sealed.ts';
import { describeTrashed, purge, purgeExpired, PURGING, trashStatements, type TrashRow } from './trash.ts';
import { checkpoint, chunksToDelete, describeVersion, prune, removeVersions, replaceVersion, retainedChunks, storedSize, versionsOf, type VersionRow } from './versions.ts';
import { editableFolder, forgetFolders } from './folderShares.ts';
import { accessFor, canWrite, dropPublicLink, dropSharing, forgetDocuments, makePublicLink, person, publicLinkOf, sharer, publicShare, registerOwner, registerOwners, sharedWith, sharesOf, shareWith, unshare, userByEmail, viewShare, viewTokenFor, type Access, type Role, type ShareRole } from './sharing.ts';
import { dropPublicListeners, endRooms, kickFromRoom, listenToRoom, rejoinRoom, roomAllowsSave, roomSaved } from './roomGate.ts';
import { requireRoom } from './storage.ts';
import { hasSync, subscriptionRequired } from './subscriptions.ts';
import { cloudStorageConfigured, existingUserDb, userDb, type UserDb } from './userDb.ts';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_THUMB_BYTES = 512 * 1024;
/** The most a page's kept results may be (its embeds and what its scripts read, as JSON). */
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const THUMB_TYPES = new Set(['image/webp', 'image/png', 'image/jpeg']);

interface DocumentRow {
  id: string;
  name: string;
  size: number;
  r2_key: string;
  created_at: number;
  updated_at: number;
  /** When the thumbnail was last uploaded; null if there is none. */
  thumb_at: number | null;
  /** The folder it is in; null at the top level. */
  folder_id: string | null;
  /** Who added it, when that was not the owner: someone editing a folder shared with them (docs/folder-sharing.md). */
  created_by?: string | null;
  /** Who saved its file last, when that was not the owner (docs/html-pages.md §1). */
  saved_by?: string | null;
  /** 1 for an encrypted document (sealed.ts): the server keeps its file, name and versions sealed, and never reads them. */
  encrypted?: number | null;
  /** An encrypted document's item key, wrapped by the person's own key. */
  wrapped_key?: string | null;
}

/** What the client sees of a document (the R2 key stays server-side). */
export function describe(row: DocumentRow, role: Role = 'owner') {
  return {
    role,
    id: row.id,
    name: row.name,
    size: row.size,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    thumbAt: row.thumb_at ?? null,
    // Folders are the owner's own arrangement: nobody else sees where a document is kept.
    folderId: role === 'owner' ? (row.folder_id ?? null) : null,
    // For the owner: another account made it or saved it last, so an HTML page in it is not only theirs (docs/html-pages.md §1).
    ...(role === 'owner' && (row.created_by || row.saved_by) ? { byOther: true } : {}),
    ...(row.encrypted ? { encrypted: true, ...(role === 'owner' && row.wrapped_key ? { wrappedKey: row.wrapped_key } : {}) } : {}),
  };
}

/** An owner's documents, newest first, from the catalogue cache when it is current. */
export function listDocuments(env: Env, ownerId: string, db: UserDb): Promise<DocumentRow[]> {
  return db.cachedList('documents', async () => {
    const rows = await db.all<DocumentRow>('SELECT * FROM documents ORDER BY updated_at DESC');
    // Documents from before sharing existed are claimed here, so rooms and shares can find them.
    // Every document made since registers its owner when it is created, so this is needed once per user.
    if (!(await ownersBackfilled(env, ownerId))) {
      await registerOwners(env, rows.map((row) => row.id), ownerId);
      await env.DIRECTORY.prepare('UPDATE users SET owners_backfilled = 1 WHERE user_id = ?').bind(ownerId).run().catch(() => {});
    }
    return rows;
  });
}

/** Whether the owner's old documents have been claimed already (see listDocuments). */
async function ownersBackfilled(env: Env, ownerId: string): Promise<boolean> {
  try {
    // Locally there is no users row, so this stays false; there the directory is not rate limited.
    const row = await env.DIRECTORY.prepare('SELECT owners_backfilled FROM users WHERE user_id = ?').bind(ownerId).first<{ owners_backfilled: number }>();
    return !!row?.owners_backfilled;
  } catch {
    // A directory without the column yet: claim them, as before.
    return false;
  }
}

/** Moves the document to a folder (null: the top level); the owner's call. */
async function moveDocument(db: UserDb, row: DocumentRow, folderId: unknown): Promise<DocumentRow> {
  const to = await checkMove(db, [row], folderId);
  await db.run('UPDATE documents SET folder_id = ? WHERE id = ?', [to, row.id]);
  return { ...row, folder_id: to };
}

/**
 * Deletes the owner's documents: the rows move to the trash (see trash.ts), their shares, search entries and rooms go, and
 * the files stay in R2 until the trash is emptied or 30 days pass. The rows are what make a document gone, so once they have moved
 * the rest is cleanup: with `defer` it is handed over to carry on after the response (it cannot fail the request), otherwise it is done
 * before returning. `also` goes in the same transaction as the rows (a folder delete's folders, so either both go or neither).
 */
export async function deleteDocuments(env: Env, ownerId: string, db: UserDb, rows: DocumentRow[], defer?: (work: Promise<unknown>) => void, also: { sql: string; params: unknown[] }[] = []): Promise<void> {
  const ids = rows.map((r) => r.id);
  // Many to a statement and all in one request to Cloudflare, which limits how many it takes.
  await db.runAll([...trashStatements(ids, Date.now()), ...perChunk(ids, (marks) => `DELETE FROM documents WHERE id IN (${marks})`), ...also]);
  // The owner and share rows are what let the bytes be read straight from R2 (see the fast read in
  // handleDocuments), so they go before answering: deferred work can be cut short, and the files would
  // stay readable. They are cheap (the directory is a binding, not the rate-limited API).
  let forgotten = true;
  try {
    await forgetDocuments(env, ids);
  } catch (error) {
    forgotten = false;
    console.error('forgetting deleted documents failed; trying again in the cleanup', error);
  }
  const cleanup = async () => {
    if (!forgotten) await forgetDocuments(env, ids);
    await endRooms(env, ids);
    await purgeExpired(env, ownerId, db);
  };
  if (defer) defer(cleanup().catch((error) => console.error('delete cleanup failed', error)));
  else await cleanup();
}

export async function readBody(request: Request, limit: number, what: string, allowEmpty = false): Promise<ArrayBuffer> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > limit) throw new HttpError(413, `${what} too large`);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > limit) throw new HttpError(413, `${what} too large`);
  if (bytes.byteLength === 0 && !allowEmpty) throw new HttpError(400, 'empty body');
  return bytes;
}

/**
 * Most bytes one batch upload may carry: as much as one document may, and no more, because a Worker
 * has 128 MB of memory and the whole body is held at once (a single large document must still fit).
 */
const MAX_BATCH_BYTES = MAX_BYTES + 1024 * 1024;
/** D1 allows 100 bound values in a statement (developers.cloudflare.com/d1/platform/limits): a row of documents has 7, so 14 rows fit. */
const ROWS_PER_INSERT = 14;

type Uploaded = { document: ReturnType<typeof describe> } | { error: string };

/**
 * POST /api/documents/batch: the body is a 4-byte big-endian length, that many bytes of JSON
 * `{ documents: [{ name, size, folderId? }] }`, then the documents' bytes one after the other.
 * Answers one result per document, in order: the document, or why it wasn't saved (the others
 * still are). A batch costs a few requests to Cloudflare's API however many documents it holds,
 * where one request per document would use up its rate limit.
 */
async function uploadBatch(env: Env, userId: string, db: UserDb, body: ArrayBuffer): Promise<Uploaded[]> {
  const bad = () => new HttpError(400, 'expected a batch of documents');
  if (body.byteLength < 4) throw bad();
  const headerLength = new DataView(body).getUint32(0);
  if (4 + headerLength > body.byteLength) throw bad();
  let header: { documents?: unknown };
  try {
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(body, 4, headerLength)));
  } catch {
    throw bad();
  }
  const list = header.documents;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BATCH) throw new HttpError(400, `expected at most ${MAX_BATCH} documents`);
  let offset = 4 + headerLength;
  const items = list.map((raw: { name?: unknown; size?: unknown; folderId?: unknown }) => {
    if (typeof raw?.size !== 'number' || !Number.isInteger(raw.size) || raw.size < 0 || (raw.folderId != null && typeof raw.folderId !== 'string')) throw bad();
    const item = { name: cleanName(typeof raw.name === 'string' ? raw.name : null) ?? 'Untitled.docx', folderId: (raw.folderId as string | null | undefined) ?? null, start: offset, size: raw.size };
    offset += raw.size;
    return item;
  });
  if (offset !== body.byteLength) throw bad();

  // One query for every folder named, rather than one per document.
  const wanted = [...new Set(items.flatMap((i) => (i.folderId === null ? [] : [i.folderId])))];
  const folders = new Set<string>();
  for (let i = 0; i < wanted.length; i += IDS_PER_QUERY) {
    const chunk = wanted.slice(i, i + IDS_PER_QUERY);
    // An encrypted folder takes its documents one at a time, sealed (POST /api/documents): a batch is for ordinary ones.
    for (const row of await db.all<{ id: string; encrypted: number | null }>(`SELECT id, encrypted FROM folders WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk)) if (!row.encrypted) folders.add(row.id);
  }
  // The whole batch fits in the account, or none of it goes in.
  await requireRoom(env, userId, db, items.reduce((sum, item) => sum + (item.size > MAX_BYTES ? 0 : item.size), 0));

  const results: Uploaded[] = [];
  const saved: { id: string; name: string; size: number; folderId: string | null; index: number }[] = [];
  const now = Date.now();
  await Promise.all(
    items.map(async (item, index) => {
      if (item.size > MAX_BYTES) return void (results[index] = { error: 'document too large' });
      if (item.folderId !== null && !folders.has(item.folderId)) return void (results[index] = { error: 'no such folder' });
      const id = crypto.randomUUID();
      try {
        // Bytes first: a failure leaves an unreferenced object, never a row pointing at nothing.
        await env.FILES.put(docxKey(userId, id), new Uint8Array(body, item.start, item.size), { httpMetadata: { contentType: DOCX } });
        saved.push({ id, name: item.name, size: item.size, folderId: item.folderId, index });
      } catch (error) {
        console.error(error);
        results[index] = { error: 'internal error' };
      }
    }),
  );

  const statements: { sql: string; params: unknown[] }[] = [];
  for (let i = 0; i < saved.length; i += ROWS_PER_INSERT) {
    const rows = saved.slice(i, i + ROWS_PER_INSERT);
    statements.push({
      sql: `INSERT INTO documents (id, name, size, r2_key, created_at, updated_at, folder_id) VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      params: rows.flatMap((r) => [r.id, r.name, r.size, docxKey(userId, r.id), now, now, r.folderId]),
    });
  }
  // If this fails part way the objects stay unreferenced and the caller sees a failed request.
  await db.runAll(statements);
  await registerOwners(env, saved.map((r) => r.id), userId);
  for (const r of saved) results[r.index] = { document: describe({ id: r.id, name: r.name, size: r.size, created_at: now, updated_at: now, thumb_at: null, folder_id: r.folderId } as DocumentRow) };
  return results;
}

const readDocx = (request: Request) => readBody(request, MAX_BYTES, 'document', true);

/** A save that sends only the chunks the server lacks (see fileStore.ts). */
const isDelta = (request: Request): boolean => (request.headers.get('content-type') ?? '').startsWith(DELTA);
/** The most a delta upload carries: every chunk of a document of the greatest size, and its manifest. */
const MAX_DELTA_BYTES = MAX_BYTES + 1024 * 1024;

/** Deletes the chunks a save brought that no copy of the file names, after the save failed (best effort: a stray chunk is only wasted space until the document goes). */
async function dropUnused(env: Env, ownerId: string, docId: string, key: string, hashes: readonly string[]): Promise<void> {
  try {
    const keep = new Set((await previousManifest(env, key))?.chunks.map((c) => c.h));
    await deleteChunkList(env, ownerId, docId, hashes.filter((h) => !keep.has(h)));
  } catch (error) {
    console.error('removing unused chunks failed', error);
  }
}

/**
 * The user's access to a document. Documents from before sharing existed have no owner record;
 * finding one in the user's own catalogue claims it.
 */
export async function resolveAccess(env: Env, userId: string, docId: string, knownDb?: UserDb | null, early?: Promise<Access | null>): Promise<Access | null> {
  const access = await (early ?? accessFor(env, userId, docId));
  if (access) return access;
  if (knownDb === null) return null; // no database of their own, so nothing to claim
  if (!cloudStorageConfigured(env)) return null;
  const db = knownDb ?? (await userDb(env, userId));
  if (!(await db.first('SELECT 1 FROM documents WHERE id = ?', [docId]))) return null;
  await registerOwner(env, docId, userId);
  return { role: 'owner', ownerId: userId };
}

/** A request under /api/documents or /api/shared, as the router split its path. */
export interface DocumentRoute {
  collection: 'documents' | 'shared' | 'trash';
  /** The document, or `batch` for the batch upload; undefined for the collection itself. */
  id?: string;
  sub?: 'thumbnail' | 'index' | 'shares' | 'versions' | 'link' | 'page';
  /** Whose share a DELETE /api/documents/:id/shares/:userId removes, or which version /api/documents/:id/versions/:version is. */
  granteeId?: string;
  /** `restore` for /api/documents/:id/versions/:version/restore and /api/trash/:id/restore; `file` for /api/trash/:id/file. */
  action?: 'restore' | 'file';
}

/** The user's own storage: whether they sync, and their database if they have one (or get one now). */
export async function ownStorage(env: Env, userId: string, method: string): Promise<{ syncing: boolean; ownDb: UserDb | null }> {
  // Whether this user may keep documents in the cloud. Without it they get no database of their
  // own (so nothing is created for people who only open what a subscriber shares), and what
  // they already have can be read and deleted but not changed.
  const syncing = await hasSync(env, userId);
  // A database is made on the first change, not the first look: a list of nothing needs none, and
  // each one made counts against the account's limit on databases.
  const ownDb = syncing && method !== 'GET' ? await userDb(env, userId) : await existingUserDb(env, userId);
  return { syncing, ownDb };
}

/**
 * Answers a request under /api/documents or /api/shared for a signed-in user. The router has already
 * checked the ids in the path and that cloud storage is configured. `defer` hands work over to carry
 * on after the response (a delete's cleanup); without it that work is done before answering.
 */
/**
 * GET /api/view/:token and /api/view/:token/file: a document shared view-only, as the read-only viewer (/view?s=<token>) reads it:
 * its name and who shared it (`owner`: their name and picture, shown in the page's header), and its file (304 for `If-None-Match`
 * while unchanged). The token is the share's own (`shares.view_token`), and only the
 * person it was shared with may use it; anyone else, and a token dropped by unsharing or a role change, gets 404. Nothing answered
 * names the document's id. GET /api/view/:token/live is the WebSocket that tells the page of each save (`listenToRoom`).
 */
/** What a shared HTML page showed when last opened by someone who may change it (docs/html-pages.md §5); 404 when there is none. */
async function pageResults(env: Env, ownerId: string, docId: string): Promise<Response> {
  const object = await env.FILES.get(pageKey(ownerId, docId));
  if (!object) throw new HttpError(404, 'not found');
  return new Response(object.body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' } });
}

export async function handleView(request: Request, env: Env, userId: string, token: string, part: 'file' | 'live' | 'page' | undefined): Promise<Response> {
  if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
  const share = await viewShare(env, token, userId);
  if (!share) throw new HttpError(404, 'not found');
  if (!(await hasSync(env, share.ownerId))) throw new HttpError(403, 'the owner’s subscription has ended', 'subscription');
  const db = await userDb(env, share.ownerId);
  const row = db && (await db.first<DocumentRow>('SELECT * FROM documents WHERE id = ?', [share.docId]));
  if (!row) throw new HttpError(404, 'not found');
  if (!part) return json({ name: row.name, updatedAt: row.updated_at, owner: await sharer(env, share.ownerId) });
  if (part === 'live') return listenToRoom(env, share.docId, request, userId, share.ownerId);
  if (part === 'page') return pageResults(env, share.ownerId, share.docId);
  const response = await documentResponse(env, row.r2_key, share.ownerId, share.docId, DOCX, request.headers.get('if-none-match'));
  if (!response) throw new HttpError(404, 'not found');
  return response;
}

/**
 * GET /api/public/:token and /api/public/:token/file: a document's public link (`public_links`), as the viewer reads it at
 * /view?p=<token> (and embedded in other sites, /view?p=<token>&embed), for anyone, signed in or not. The same answers as
 * `handleView`. A dropped or reset link, a deleted document and an owner whose sync ended all get 404, so a link says
 * nothing about why it stopped. Browsers may keep an answer for a minute, which is how long a dropped link can still show.
 * GET /api/public/:token/live is the WebSocket that tells the page of each save (`listenToRoom`).
 */
/** The document a public link opens, while its owner has sync; null for an unknown, dropped or lapsed link. */
export async function publicDocument(env: Env, token: string): Promise<{ ownerId: string; docId: string; row: DocumentRow } | null> {
  const link = await publicShare(env, token);
  if (!link || !(await hasSync(env, link.ownerId))) return null;
  const db = await userDb(env, link.ownerId);
  const row = db && (await db.first<DocumentRow>('SELECT * FROM documents WHERE id = ?', [link.docId]));
  return row ? { ...link, row } : null;
}

/** GET /api/public/:token, /file and /thumbnail: a document's public link, for anyone. */
export async function handlePublic(request: Request, env: Env, token: string, part: 'file' | 'thumbnail' | 'live' | 'page' | undefined): Promise<Response> {
  if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
  const found = await publicDocument(env, token);
  if (!found) throw new HttpError(404, 'not found');
  const { ownerId, docId, row } = found;
  if (part === 'live') return listenToRoom(env, docId, request, null, ownerId);
  if (part === 'page') return pageResults(env, ownerId, docId);
  const cache = 'public, max-age=60';
  if (part === 'thumbnail') {
    // Link previews (sharePreview.ts) ask for it by the version in its address, so it may be kept a while.
    const object = row.thumb_at == null ? null : await env.FILES.get(thumbKey(ownerId, docId));
    if (!object) throw new HttpError(404, 'not found');
    return new Response(object.body, {
      headers: {
        'content-type': object.httpMetadata?.contentType ?? 'image/webp',
        'content-length': String(object.size),
        'cache-control': 'public, max-age=3600',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  if (!part) return json({ name: row.name, updatedAt: row.updated_at }, 200, { 'cache-control': cache });
  const response = await documentResponse(env, row.r2_key, ownerId, docId, DOCX, request.headers.get('if-none-match'));
  if (!response) throw new HttpError(404, 'not found');
  const headers = new Headers(response.headers);
  headers.set('cache-control', cache);
  return new Response(response.body, { status: response.status, headers });
}

export async function handleDocuments(request: Request, env: Env, userId: string, url: URL, route: DocumentRoute, defer?: (work: Promise<unknown>) => void): Promise<Response> {
  const { collection, id, sub, granteeId, action } = route;
  const batchUpload = collection === 'documents' && id === 'batch' && sub === undefined;
  // Who may open the document doesn't depend on the user's database, so both are looked up together.
  const earlyAccess = id !== undefined && collection === 'documents' ? accessFor(env, userId, id) : undefined;
  earlyAccess?.catch(() => {}); // reported where it is awaited
  // Reading a document's bytes or thumbnail needs only who owns it (the directory knows) and the
  // object in R2, whose key follows from both. So the common read skips the user's own database
  // (and the catalogue) altogether; a document stored under another key takes the full route below.
  if (earlyAccess && id !== undefined && request.method === 'GET' && (sub === undefined || sub === 'thumbnail')) {
    const access = await earlyAccess;
    if (access && (access.ownerId === userId || (await hasSync(env, access.ownerId)))) {
      if (sub === 'thumbnail') {
        const object = await env.FILES.get(thumbKey(access.ownerId, id));
        if (object) {
          return new Response(object.body, {
            headers: {
              'content-type': object.httpMetadata?.contentType ?? 'image/webp',
              'content-length': String(object.size),
              etag: object.httpEtag,
              'cache-control': url.searchParams.has('v') ? 'private, max-age=31536000, immutable' : 'private, no-cache',
              'x-content-type-options': 'nosniff',
            },
          });
        }
      } else {
        // The file, whole or put together from its chunks (see fileStore.ts).
        const response = await documentResponse(env, docxKey(access.ownerId, id), access.ownerId, id, DOCX, request.headers.get('if-none-match'));
        if (response) return response;
      }
    }
  }
  const { syncing, ownDb } = await ownStorage(env, userId, request.method);

  // GET /api/shared: documents other people shared with this user.
  if (collection === 'shared') {
    if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
    const byOwner = new Map<string, Map<string, ShareRole>>();
    for (const s of await sharedWith(env, userId)) {
      if (!byOwner.has(s.ownerId)) byOwner.set(s.ownerId, new Map());
      byOwner.get(s.ownerId)!.set(s.docId, s.role);
    }
    const perOwner = await Promise.all(
      [...byOwner].map(async ([ownerId, roles]) => {
        // A share lasts while its owner has sync.
        if (!(await hasSync(env, ownerId))) return [];
        const [rows, owner] = await Promise.all([listDocuments(env, ownerId, await userDb(env, ownerId)), person(env, ownerId)]);
        return Promise.all(
          rows
            .filter((row) => roles.has(row.id))
            .map(async (row) => {
              const role = roles.get(row.id)!;
              // A view-only share opens in the viewer at its own address (see handleView), never the document's id.
              const viewToken = role === 'viewer' ? await viewTokenFor(env, row.id, userId) : null;
              return { ...describe(row, role), owner: { name: owner.name, email: owner.email }, ...(viewToken && { viewToken }) };
            }),
        );
      }),
    );
    return json(perOwner.flat());
  }

  // /api/trash[/:id[/restore]]: what the owner deleted in the last 30 days (see trash.ts).
  if (collection === 'trash') {
    if (!ownDb) {
      if (request.method === 'GET' && !id) return json([]);
      throw new HttpError(404, 'not found');
    }
    if (!id) {
      if (request.method === 'GET') {
        await purgeExpired(env, userId, ownDb);
        return json((await ownDb.all<TrashRow>(`SELECT * FROM trash WHERE deleted_at <> ${PURGING} ORDER BY deleted_at DESC`)).map(describeTrashed));
      }
      // DELETE /api/trash: empty it.
      if (request.method === 'DELETE') {
        await purge(env, userId, ownDb, await ownDb.all<TrashRow>('SELECT * FROM trash'));
        return new Response(null, { status: 204 });
      }
      throw new HttpError(405, 'method not allowed');
    }
    const trashed = await ownDb.first<TrashRow>('SELECT * FROM trash WHERE id = ?', [id]);
    if (!trashed) throw new HttpError(404, 'not found');
    // GET /api/trash/:id/file: the trashed document's bytes, to look at before restoring it. Only its owner reaches this (`ownDb`).
    if (request.method === 'GET' && action === 'file') {
      if (trashed.deleted_at === PURGING) throw new HttpError(404, 'not found');
      const response = await documentResponse(env, trashed.r2_key, userId, id, DOCX, request.headers.get('if-none-match'));
      if (!response) throw new HttpError(404, 'document file is missing');
      return response;
    }
    if (request.method === 'DELETE' && !action) {
      await purge(env, userId, ownDb, [trashed]);
      return new Response(null, { status: 204 });
    }
    if (request.method === 'POST' && action === 'restore') {
      if (!syncing) throw subscriptionRequired();
      if (trashed.deleted_at === PURGING) throw new HttpError(404, 'not found');
      // Its folder may have been deleted since: then it comes back at the top level. So does an ordinary document whose folder has been
      // encrypted since (an encrypted folder takes only encrypted documents).
      const kept = trashed.folder_id !== null && (await ownDb.first('SELECT 1 FROM folders WHERE id = ?', [trashed.folder_id])) ? trashed.folder_id : null;
      const folderId = kept !== null && !trashed.encrypted && (await folderEncrypts(ownDb, kept)) ? null : kept;
      await ownDb.runAll([
        { sql: 'INSERT INTO documents (id, name, size, r2_key, created_at, updated_at, thumb_at, folder_id, encrypted, wrapped_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', params: [trashed.id, trashed.name, trashed.size, trashed.r2_key, trashed.created_at, trashed.updated_at, trashed.thumb_at, folderId, trashed.encrypted ? 1 : 0, trashed.wrapped_key ?? null] },
        { sql: 'DELETE FROM trash WHERE id = ?', params: [id] },
      ]);
      await registerOwner(env, id, userId);
      return json(describe({ ...trashed, folder_id: folderId }));
    }
    throw new HttpError(405, 'method not allowed');
  }

  // GET /api/documents: the user's documents, newest first.
  if (!id && request.method === 'GET') {
    if (!ownDb) return json([]);
    return json((await listDocuments(env, userId, ownDb)).map((row) => describe(row)));
  }

  // POST /api/documents/batch: many new documents in one request (see uploadBatch).
  if (batchUpload) {
    if (request.method !== 'POST') throw new HttpError(405, 'method not allowed');
    if (!ownDb || !syncing) throw subscriptionRequired();
    return json({ results: await uploadBatch(env, userId, ownDb, await readBody(request, MAX_BATCH_BYTES, 'upload')) }, 201);
  }

  // POST /api/documents?name=…: a new document from the request body (.docx bytes).
  // With `owner` (someone else's id) the document goes in a folder of theirs shared with this user as an editor (docs/folder-sharing.md):
  // it is the owner's, in the owner's storage, recorded as added by this user. That needs the owner's sync, not this user's.
  if (!id && request.method === 'POST') {
    const folderId = url.searchParams.get('folder');
    const ownerParam = url.searchParams.get('owner');
    const owner = ownerParam ?? userId;
    let db: UserDb;
    if (owner !== userId) {
      if (folderId === null) throw new HttpError(400, 'expected a folder');
      db = (await editableFolder(env, userId, owner, folderId)).db;
    } else {
      if (!ownDb || !syncing) throw subscriptionRequired();
      db = ownDb;
      if (folderId !== null && !(await ownDb.first('SELECT 1 FROM folders WHERE id = ?', [folderId]))) throw new HttpError(400, 'no such folder');
    }
    // An encrypted document (sealed.ts) comes sealed, file and name, with its wrapped key (`key`); in an encrypted folder every one is.
    const encrypted = url.searchParams.has('key') || (await folderEncrypts(db, folderId));
    if (encrypted && owner !== userId) throw new HttpError(404, 'no such folder');
    const key = encrypted ? wrappedKey(url.searchParams.get('key')) : null;
    const delta = isDelta(request);
    const bytes = delta ? await readBody(request, MAX_DELTA_BYTES, 'document') : await readDocx(request);
    if (encrypted && !delta) requireSealedWith(bytes, key);
    const docId = crypto.randomUUID();
    const name = encrypted ? sealedName(url.searchParams.get('name')) : (cleanName(url.searchParams.get('name')) ?? 'Untitled.docx');
    await requireRoom(env, owner, db, delta ? deltaSize(bytes, MAX_DELTA_BYTES) : bytes.byteLength, { own: owner === userId });
    const now = Date.now();
    const createdBy = owner === userId ? null : userId;
    // Bytes first: a failure leaves an unreferenced object, never a row pointing at nothing.
    let size = bytes.byteLength;
    if (delta) size = (await applyDelta(env, owner, docId, docxKey(owner, docId), bytes, null, { maxBytes: MAX_BYTES, ...(encrypted ? { sealedWith: key } : {}) })).manifest.size;
    else await env.FILES.put(docxKey(owner, docId), bytes, { httpMetadata: { contentType: DOCX } });
    if (createdBy) await db.run('INSERT INTO documents (id, name, size, r2_key, created_at, updated_at, folder_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [docId, name, size, docxKey(owner, docId), now, now, folderId, createdBy]);
    else await db.run('INSERT INTO documents (id, name, size, r2_key, created_at, updated_at, folder_id, encrypted, wrapped_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [docId, name, size, docxKey(owner, docId), now, now, folderId, encrypted ? 1 : 0, key]);
    await registerOwner(env, docId, owner);
    if (createdBy) return json({ role: 'editor', id: docId, name, size, createdAt: now, updatedAt: now, thumbAt: null, folderId, createdByYou: true }, 201);
    return json({ role: 'owner', id: docId, name, size, createdAt: now, updatedAt: now, thumbAt: null, folderId, ...(key ? { encrypted: true, wrappedKey: key } : {}) }, 201);
  }

  // DELETE /api/documents { ids?, folders? } and PATCH /api/documents { ids, folderId }: the same
  // as the calls below for one document, for several at once. Each is reported on its own. A
  // delete may name folders too: they go with everything inside them (documents and subfolders).
  if (!id && (request.method === 'DELETE' || request.method === 'PATCH')) {
    const body = await request.json().catch(() => null);
    const deleting = request.method === 'DELETE';
    const folderIds = deleting ? idList(body, 'folders', true) : [];
    const ids = idList(body, 'ids', deleting && folderIds.length > 0);
    if (!deleting && !syncing) throw subscriptionRequired();
    const ok: string[] = [];
    const failed: Failure[] = [];
    const doomed: DocumentRow[] = [];
    // One query per 90 ids rather than one per id (each is a request to Cloudflare, which limits them).
    const owned = new Map<string, DocumentRow>();
    if (ownDb) {
      for (let i = 0; i < ids.length; i += IDS_PER_QUERY) {
        const chunk = ids.slice(i, i + IDS_PER_QUERY);
        for (const row of await ownDb.all<DocumentRow>(`SELECT * FROM documents WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk)) owned.set(row.id, row);
      }
    }
    const moving: string[] = [];
    for (const docId of ids) {
      try {
        const own = owned.get(docId) ?? null;
        if (!own || !ownDb) {
          const access = await accessFor(env, userId, docId);
          throw access ? new HttpError(403, `only the owner can ${deleting ? 'delete' : 'move'} this document`) : new HttpError(404, 'not found');
        }
        if (deleting) doomed.push(own);
        else moving.push(docId);
      } catch (error) {
        failed.push(failure(docId, error));
      }
    }
    // A move is checked once and made in one request to Cloudflare, however many documents.
    // (It leaves updated_at alone, as a single move does: it is not an edit, and clients compare
    // updated_at to tell whether a document's contents changed.)
    if (moving.length && ownDb) {
      try {
        const to = await checkMove(ownDb, moving.map((docId) => owned.get(docId)!), (body as { folderId?: unknown }).folderId);
        await ownDb.runAll(perChunk(moving, (marks) => `UPDATE documents SET folder_id = ? WHERE id IN (${marks})`, [to]));
        ok.push(...moving);
      } catch (error) {
        failed.push(...moving.map((docId) => failure(docId, error)));
        if (!(error instanceof HttpError)) console.error(error);
      }
    }
    // The folders asked for, and every folder inside them, with the documents in any of them.
    const doomedFolders = new Set<string>();
    const asked: string[] = [];
    if (folderIds.length && ownDb) {
      const all = await ownDb.all<FolderRow>('SELECT * FROM folders');
      for (const folderId of folderIds) {
        if (!all.some((f) => f.id === folderId)) {
          failed.push({ id: folderId, error: 'not found' });
          continue;
        }
        asked.push(folderId);
        const walk = (at: string) => {
          doomedFolders.add(at);
          for (const child of all) if (child.parent_id === at && !doomedFolders.has(child.id)) walk(child.id);
        };
        walk(folderId);
      }
      if (doomedFolders.size) {
        const already = new Set(doomed.map((d) => d.id));
        for (const row of await ownDb.all<DocumentRow>('SELECT * FROM documents')) {
          if (row.folder_id !== null && doomedFolders.has(row.folder_id) && !already.has(row.id)) doomed.push(row);
        }
      }
    } else for (const folderId of folderIds) failed.push({ id: folderId, error: 'not found' });
    if (ownDb && (doomed.length || asked.length)) {
      try {
        // The folders go in the same transaction as the documents: a failure leaves both, never documents gone from folders that stay.
        const folderDeletes = perChunk([...doomedFolders], (marks) => `DELETE FROM folders WHERE id IN (${marks})`);
        await deleteDocuments(env, userId, ownDb, doomed, defer, folderDeletes);
        await forgetFolders(env, userId, [...doomedFolders]);
        ok.push(...doomed.map((row) => row.id).filter((docId) => ids.includes(docId)), ...asked);
      } catch (error) {
        failed.push(...[...ids.filter((docId) => doomed.some((d) => d.id === docId)), ...asked].map((x) => failure(x, error)));
        console.error(error);
      }
    }
    return json({ ok, failed });
  }

  if (!id) throw new HttpError(405, 'method not allowed');

  // Whose document is it, and what may this user do with it?
  const access = await resolveAccess(env, userId, id, ownDb, earlyAccess);
  if (!access) throw new HttpError(404, 'not found');
  const { role, ownerId } = access;
  // Someone else's document is theirs to keep only while they have sync; reading your own never lapses.
  const ownerSyncs = ownerId === userId ? syncing : await hasSync(env, ownerId);
  const leaving = sub === 'shares' && request.method === 'DELETE'; // anyone may still remove themselves
  if (!ownerSyncs && ownerId !== userId && !leaving) throw new HttpError(403, 'the owner’s subscription has ended', 'subscription');
  const requireStorage = () => {
    if (!ownerSyncs) throw subscriptionRequired();
  };
  const db: UserDb | null = ownerId === userId ? ownDb : await userDb(env, ownerId);
  if (!db) throw new HttpError(404, 'not found');
  const thumbKeyFor = (docId: string) => thumbKey(ownerId, docId);

  // Reads take the row from the cached catalogue (one native query) instead of asking the user's
  // own database over the network. Writes always read it afresh: they check what is current.
  const reading = request.method === 'GET' && (sub === undefined || sub === 'thumbnail');
  // A save with a base notes the file's version before reading the row (see the PUT below), so a
  // save that lands in between changes one or the other and this one is refused, not lost.
  const savedKey = docxKey(ownerId, id);
  const fileBefore = request.method === 'PUT' && sub === undefined && url.searchParams.has('base') ? await env.FILES.head(savedKey) : undefined;
  const row =(reading ? (await db.peekList<DocumentRow>('documents'))?.find((r) => r.id === id) : undefined) ?? (await db.first<DocumentRow>('SELECT * FROM documents WHERE id = ?', [id]));
  if (!row) throw new HttpError(404, 'not found');
  const requireWrite = () => {
    if (!canWrite(role)) throw new HttpError(403, 'this document is read-only for you');
  };

  // /api/documents/:id/shares[/:userId]: who else can open it. Only the owner manages this
  // (anyone may remove themselves).
  if (sub === 'shares') {
    if (granteeId === undefined && request.method === 'GET') {
      if (role !== 'owner') throw new HttpError(403, 'only the owner can see who has access');
      return json(await sharesOf(env, id));
    }
    if (granteeId === undefined && request.method === 'PUT') {
      if (role !== 'owner') throw new HttpError(403, 'only the owner can share this document');
      refuseEncrypted(row, 'sharing');
      requireStorage();
      const body = (await request.json().catch(() => null)) as { email?: unknown; role?: unknown } | null;
      if (typeof body?.email !== 'string' || (body.role !== 'editor' && body.role !== 'viewer')) throw new HttpError(400, 'expected { email, role: "editor" | "viewer" }');
      const target = await userByEmail(env, body.email);
      if (!target) throw new HttpError(404, 'nobody with that email has signed in to Golem Docs yet');
      if (target === userId) throw new HttpError(400, 'you already own this document');
      const before = await accessFor(env, target, id);
      await shareWith(env, id, target, body.role);
      // Someone already in the room keeps the role they joined with until they reconnect:
      // make them, so a viewer made an editor (or the other way round) takes effect now.
      if (before && before.role !== body.role) await rejoinRoom(env, id, target);
      return json({ ...(await person(env, target)), role: body.role });
    }
    if (granteeId !== undefined && request.method === 'DELETE') {
      if (role !== 'owner' && granteeId !== userId) throw new HttpError(403, 'only the owner can remove other people');
      await unshare(env, id, granteeId);
      await kickFromRoom(env, id, granteeId);
      return new Response(null, { status: 204 });
    }
    throw new HttpError(405, 'method not allowed');
  }

  // /api/documents/:id/link: its public link, which anyone may open read-only. Only the owner sees or changes it. GET answers
  // { token } (null while there is none), PUT makes one (or keeps the one there is), POST makes a new one in place of the old, DELETE
  // turns it off.
  if (sub === 'link') {
    if (role !== 'owner') throw new HttpError(403, 'only the owner can manage the public link');
    if (granteeId !== undefined) throw new HttpError(404, 'not found');
    if (request.method === 'GET') return json({ token: await publicLinkOf(env, id) });
    if (request.method === 'PUT' || request.method === 'POST') {
      refuseEncrypted(row, 'a public link');
      requireStorage();
      const token = await makePublicLink(env, id, request.method === 'POST');
      // A new link in place of the old: the pages that came through the old one stop hearing of saves.
      if (request.method === 'POST') await dropPublicListeners(env, id).catch((error) => console.error('telling the room failed', error));
      return json({ token });
    }
    if (request.method === 'DELETE') {
      await dropPublicLink(env, id);
      await dropPublicListeners(env, id).catch((error) => console.error('telling the room failed', error));
      return new Response(null, { status: 204 });
    }
    throw new HttpError(405, 'method not allowed');
  }

  // GET /api/documents/:id/index: the search index, made on demand (docIndex.ts). The row is read
  // afresh (not from the cached catalogue) because its `updatedAt` is what the index is stamped with.
  if (sub === 'index') {
    if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
    refuseEncrypted(row, 'the search index');
    return documentIndex(env, ownerId, row);
  }

  // /api/documents/:id/versions[/:version[/restore]]: the document's history (versions.ts). Anyone who can open the document may look
  // at it; anyone who can edit may save a version, rename or restore one. Restoring never touches the document: it makes a new one, in
  // the restorer's own account, from the version's bytes.
  if (sub === 'versions') {
    const rest = granteeId;
    if (rest === undefined) {
      if (request.method === 'GET') return json((await versionsOf(db, id)).map(describeVersion));
      // POST { name? }: keep the document as it is now (as a named version if it has a name).
      if (request.method === 'POST') {
        requireWrite();
        requireStorage();
        const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
        const name = typeof body?.name === 'string' ? (row.encrypted ? sealedName(body.name) : cleanName(body.name)) : null;
        if (typeof body?.name === 'string' && !name) throw new HttpError(400, 'expected a name');
        // A named version counts against the account like a document (as its whole size: whether the file is kept as chunks is not known here).
        if (name) await requireRoom(env, ownerId, db, row.size, { own: ownerId === userId });
        if (!(await checkpoint(env, ownerId, db, row, { force: true, ...(name ? { name } : {}) }))) throw new HttpError(503, 'could not save the version; try again');
        const saved = await db.first<VersionRow>('SELECT * FROM versions WHERE doc_id = ? AND version = ?', [id, row.updated_at]);
        return json(saved ? describeVersion(saved) : { version: row.updated_at }, 201);
      }
      throw new HttpError(405, 'method not allowed');
    }
    if (!/^\d{1,16}$/.test(rest)) throw new HttpError(404, 'not found');
    const version = Number(rest);
    const kept = await db.first<VersionRow>('SELECT * FROM versions WHERE doc_id = ? AND version = ?', [id, version]);
    if (!kept) throw new HttpError(404, 'not found');
    if (!action) {
      if (request.method === 'GET') {
        const response = await documentResponse(env, historyKey(ownerId, id, version), ownerId, id, DOCX);
        if (!response) throw new HttpError(404, 'version file is missing');
        return response;
      }
      // PATCH { name }: names a version, or (null) lets it be thinned like the others.
      if (request.method === 'PATCH') {
        requireWrite();
        const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
        const name = body?.name === null ? null : typeof body?.name === 'string' ? (row.encrypted ? sealedName(body.name) : cleanName(body.name)) : undefined;
        if (name === undefined || (typeof body?.name === 'string' && !name)) throw new HttpError(400, 'expected { name }');
        // Naming an automatic version makes it count against the account.
        if (kept.name === null && name !== null) await requireRoom(env, ownerId, db, storedSize(kept), { own: ownerId === userId, alreadyStored: true });
        await db.run('UPDATE versions SET name = ? WHERE doc_id = ? AND version = ?', [name, id, version]);
        return json(describeVersion({ ...kept, name }));
      }
      // PUT: replaces the version's file in place, sealed or readable as the document now is: converting it (docs/encrypted-folders.md).
      // With `name`, its name too (sealed likewise). The owner's call.
      if (request.method === 'PUT') {
        if (role !== 'owner') throw new HttpError(403, 'only the owner can encrypt or decrypt this document');
        requireStorage();
        const bytes = new Uint8Array(await readDocx(request));
        if (row.encrypted) requireSealedWith(bytes, row.wrapped_key);
        else requireOpen(bytes);
        const given = url.searchParams.get('name');
        const name = given === null ? kept.name : row.encrypted ? sealedName(given) : cleanName(given);
        let next = await replaceVersion(env, ownerId, db, id, kept, bytes, !!row.encrypted);
        if (given !== null) {
          await db.run('UPDATE versions SET name = ? WHERE doc_id = ? AND version = ?', [name, id, version]);
          next = { ...next, name };
        }
        return json(describeVersion(next));
      }
      if (request.method === 'DELETE') {
        requireWrite();
        await removeVersions(env, ownerId, db, id, [kept]);
        return new Response(null, { status: 204 });
      }
      throw new HttpError(405, 'method not allowed');
    }
    if (request.method === 'POST' && action === 'restore') {
      requireWrite();
      // The new document is the restorer's own, so it needs their sync (not the owner's).
      if (!ownDb || !syncing) throw subscriptionRequired();
      const bytes = await readDocument(env, historyKey(ownerId, id, version), ownerId, id, MAX_BYTES);
      if (bytes === null) throw new HttpError(404, 'version file is missing');
      if (bytes === 'too-large') throw new HttpError(413, 'document too large');
      await requireRoom(env, userId, ownDb, bytes.byteLength);
      const docId = crypto.randomUUID();
      // An encrypted document's version stays sealed, with the same key, so it comes back beside the document.
      const encrypted = !!row.encrypted;
      if (encrypted && ownerId !== userId) throw new HttpError(403, 'only the owner can restore an encrypted document’s version');
      // A version not converted yet (a conversion cut short) is not restored as the other kind: a readable one would become an
      // encrypted document the server could read, a sealed one an ordinary document nobody could open. Opening the document with
      // its key finishes converting its versions (docs/encrypted-folders.md).
      if (encrypted) requireSealedWith(new Uint8Array(bytes), row.wrapped_key);
      else if (isSealed(new Uint8Array(bytes))) throw new HttpError(409, 'this version is still encrypted: open the document with its key to finish decrypting it', 'encrypted');
      const name = encrypted ? (url.searchParams.has('name') ? sealedName(url.searchParams.get('name')) : row.name) : (cleanName(url.searchParams.get('name')) ?? row.name);
      const folderId = encrypted ? row.folder_id : null;
      const now = Date.now();
      await env.FILES.put(docxKey(userId, docId), bytes, { httpMetadata: { contentType: DOCX } });
      await ownDb.run('INSERT INTO documents (id, name, size, r2_key, created_at, updated_at, folder_id, encrypted, wrapped_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [docId, name, bytes.byteLength, docxKey(userId, docId), now, now, folderId, encrypted ? 1 : 0, encrypted ? row.wrapped_key : null]);
      await registerOwner(env, docId, userId);
      return json({ role: 'owner', id: docId, name, size: bytes.byteLength, createdAt: now, updatedAt: now, thumbAt: null, folderId, ...(encrypted ? { encrypted: true, wrappedKey: row.wrapped_key } : {}) }, 201);
    }
    throw new HttpError(405, 'method not allowed');
  }

  // GET/PUT /api/documents/:id/page: what an HTML page showed when it was last opened by someone who may change it (its embeds and
  // what its scripts read), for the people it is shared with, whose own app can't read the owner's vault (docs/html-pages.md §5).
  // JSON the client makes; the server only keeps it. DELETE drops it (a page with nothing to show).
  if (sub === 'page') {
    if (request.method === 'GET') {
      const object = await env.FILES.get(pageKey(ownerId, id));
      if (!object) throw new HttpError(404, 'no page results');
      return new Response(object.body, { headers: { 'content-type': 'application/json', 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff' } });
    }
    if (request.method === 'PUT' || request.method === 'DELETE') {
      requireWrite();
      refuseEncrypted(row, 'page results');
      if (request.method === 'DELETE') {
        await env.FILES.delete(pageKey(ownerId, id));
        return json({ ok: true });
      }
      requireStorage();
      const bytes = await readBody(request, MAX_PAGE_BYTES, 'page results');
      try {
        JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new HttpError(400, 'page results are JSON');
      }
      await env.FILES.put(pageKey(ownerId, id), bytes, { httpMetadata: { contentType: 'application/json' } });
      return json({ ok: true });
    }
    throw new HttpError(405, 'method not allowed');
  }

  // GET/PUT /api/documents/:id/thumbnail: a small image of the first page, made by the client.
  // The client asks for it as `?v=<thumbAt>`, so a given URL never changes and can be cached hard.
  if (sub === 'thumbnail') {
    if (request.method === 'GET') {
      if (row.thumb_at == null) throw new HttpError(404, 'no thumbnail');
      const object = await env.FILES.get(thumbKeyFor(id));
      if (!object) throw new HttpError(404, 'no thumbnail');
      return new Response(object.body, {
        headers: {
          'content-type': object.httpMetadata?.contentType ?? 'image/webp',
          'content-length': String(object.size),
          etag: object.httpEtag,
          'cache-control': url.searchParams.has('v') ? 'private, max-age=31536000, immutable' : 'private, no-cache',
          // The bytes are whatever the client uploaded: never let a browser guess them into HTML.
          'x-content-type-options': 'nosniff',
        },
      });
    }
    if (request.method === 'PUT') {
      requireWrite();
      refuseEncrypted(row, 'a thumbnail');
      requireStorage();
      const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!THUMB_TYPES.has(type)) throw new HttpError(415, 'thumbnails are webp, png or jpeg');
      const bytes = await readBody(request, MAX_THUMB_BYTES, 'thumbnail');
      const now = Date.now();
      await env.FILES.put(thumbKeyFor(id), bytes, { httpMetadata: { contentType: type } });
      const updated = await db.run('UPDATE documents SET thumb_at = ? WHERE id = ? RETURNING id', [now, id]);
      if (!updated.length) {
        // Deleted while the thumbnail was on its way: don't leave its image behind.
        await env.FILES.delete(thumbKeyFor(id));
        throw new HttpError(404, 'not found');
      }
      return json(describe({ ...row, thumb_at: now }, role));
    }
    throw new HttpError(405, 'method not allowed');
  }

  // GET /api/documents/:id: the .docx bytes.
  if (request.method === 'GET') {
    const response = await documentResponse(env, row.r2_key, ownerId, id, DOCX, request.headers.get('if-none-match'));
    if (!response) throw new HttpError(404, 'document file is missing');
    return response;
  }

  // PUT /api/documents/:id[?name=…][&base=…]: replace the bytes (and optionally rename). With
  // `base` (the `updatedAt` the client's copy started from), a document changed elsewhere since
  // is refused with 409 instead of overwritten.
  if (request.method === 'PUT') {
    requireWrite();
    requireStorage();
    // While several people are editing, the room writes the file; an upload would be overwritten.
    // (423, not 409: 409 already means "changed elsewhere", which clients answer with a copy.)
    if (!(await roomAllowsSave(env, id))) {
      throw new HttpError(423, 'this document is being edited by several people; the server is saving it');
    }
    const base = url.searchParams.get('base');
    if (base !== null && Number(base) !== row.updated_at) throw new HttpError(409, 'changed elsewhere');
    // Converting (docs/encrypted-folders.md): `encrypt=<wrapped key>` makes it an encrypted document, `decrypt=1` an ordinary one. The owner's
    // call, the file and name sent whole and as they will be kept, and what they replace is not kept as a version (it would be the readable,
    // or the sealed, copy); the browser then converts each kept version (PUT .../versions/:version).
    const encrypting = url.searchParams.get('encrypt');
    const decrypting = url.searchParams.get('decrypt') === '1';
    const converting = encrypting !== null || decrypting;
    if (converting) {
      if (role !== 'owner') throw new HttpError(403, 'only the owner can encrypt or decrypt this document');
      if (isDelta(request)) throw new HttpError(400, 'a conversion sends the whole file');
      if (encrypting !== null && row.encrypted) throw new HttpError(409, 'it is encrypted already');
      if (decrypting && !row.encrypted) throw new HttpError(409, 'it is not encrypted');
      if (decrypting && (await folderEncrypts(db, row.folder_id))) throw new HttpError(409, 'everything in an encrypted folder is encrypted: move it out first', 'encrypted');
    }
    // Only its owner saves an encrypted document: nobody else can have its key, and a share of one is ended when it is encrypted.
    if (row.encrypted && role !== 'owner') throw new HttpError(403, 'only the owner can save an encrypted document');
    const encrypted = encrypting !== null || (!!row.encrypted && !decrypting);
    // An ordinary document left in an encrypted folder (its folder's encryption was cut short) takes no readable save: it is encrypted
    // first (`?encrypt=`), which the browser finishes when it is next unlocked (docs/encrypted-folders.md).
    if (!encrypted && !decrypting && row.folder_id !== null && (await folderEncrypts(db, row.folder_id))) {
      throw new HttpError(409, 'everything in an encrypted folder is encrypted: encrypt it first', 'encrypted');
    }
    const key = encrypting !== null ? wrappedKey(encrypting) : encrypted ? (row.wrapped_key ?? null) : null;
    // Someone editing a shared folder renames only what they added (docs/folder-sharing.md); their saves keep the name.
    const given = url.searchParams.get('name');
    const renaming = encrypted ? (given !== null || encrypting !== null ? sealedName(given) : null) : decrypting ? cleanName(given) : cleanName(given);
    if (decrypting && renaming === null) throw new HttpError(400, 'expected the readable name');
    if (renaming !== null && renaming !== row.name && access.folder && row.created_by !== userId) throw new HttpError(403, 'only the owner can rename this document');
    const delta = isDelta(request);
    const body = delta ? await readBody(request, MAX_DELTA_BYTES, 'document') : await readDocx(request);
    if (encrypted && !delta) requireSealedWith(body, key);
    if (decrypting) requireOpen(body);
    const name = renaming ?? row.name;
    const nextSize = delta ? deltaSize(body, MAX_DELTA_BYTES) : body.byteLength;
    // Only what the save adds counts: one that keeps the size or shrinks the document goes in however full the account is.
    await requireRoom(env, ownerId, db, nextSize - row.size, { own: ownerId === userId });
    // With a base, the bytes go in only if nobody else's did since the row was read: two saves
    // from the same base both pass the check above, and without this the later one's bytes would
    // replace the earlier one's while the row still described the earlier one.
    const current = base === null ? null : row.r2_key === savedKey ? (fileBefore ?? null) : await env.FILES.head(row.r2_key);
    // Was the file kept as chunks? Those are removed once a whole file replaces it (and a delta drops the ones it no longer names).
    const before = current ?? (await env.FILES.head(row.r2_key));
    let size = body.byteLength;
    let added: string[] = [];
    let dropped: string[] = [];
    // Keep what this save replaces, when the rules say it is due (versions.ts). Before the bytes go in, and never a reason to refuse the save.
    if (!converting) await checkpoint(env, ownerId, db, row, { nextSize, ...(current ? { etag: current.etag } : {}) });
    if (delta) {
      const saved = await applyDelta(env, ownerId, id, row.r2_key, body, await previousManifest(env, row.r2_key), { maxBytes: MAX_BYTES, ...(encrypted ? { sealedWith: key } : {}), ...(current ? { etagMatches: current.etag } : {}) });
      ({ added, dropped } = saved);
      size = saved.manifest.size;
      if (current && saved.written === null) {
        await dropUnused(env, ownerId, id, row.r2_key, added);
        throw new HttpError(409, 'changed elsewhere');
      }
    } else {
      const written = await env.FILES.put(row.r2_key, body, { httpMetadata: { contentType: DOCX }, ...(current ? { onlyIf: { etagMatches: current.etag } } : {}) });
      if (current && written === null) throw new HttpError(409, 'changed elsewhere');
    }
    // Strictly increasing, so two saves in the same millisecond still tell versions apart. With a
    // base it also has to be the version the save started from; and the row may be gone (deleted
    // meanwhile), which RETURNING tells apart from success.
    const updated = await db.run<{ updated_at: number }>(
      `UPDATE documents SET name = ?, size = ?, encrypted = ?, wrapped_key = ?, saved_by = ?, thumb_at = ${encrypting !== null ? 'NULL' : 'thumb_at'}, updated_at = MAX(?, updated_at + 1) WHERE id = ?${base !== null ? ' AND updated_at = ?' : ''} RETURNING updated_at`,
      [name, size, encrypted ? 1 : 0, key, userId === ownerId ? null : userId, Date.now(), id, ...(base !== null ? [row.updated_at] : [])],
    );
    if (!updated[0]) {
      if (base !== null && (await db.first('SELECT 1 FROM documents WHERE id = ?', [id]))) {
        if (delta) await dropUnused(env, ownerId, id, row.r2_key, added);
        throw new HttpError(409, 'changed elsewhere');
      }
      // Deleted while this save was on its way. In the trash, the file is its (restorable) file, bytes just written and all; if the row is
      // gone altogether (emptied meanwhile) or being purged, the bytes belong to nothing.
      if (!(await db.first(`SELECT 1 FROM trash WHERE id = ? AND deleted_at <> ${PURGING}`, [id]))) {
        await env.FILES.delete(row.r2_key);
        await deleteChunks(env, ownerId, id).catch((error) => console.error('removing chunks failed', error));
      }
      throw new HttpError(404, 'not found');
    }
    // Encrypted now (docs/encrypted-folders.md): nothing readable made from it stays, and nobody else keeps a way in. Its thumbnail and
    // search index (its text) go; its shares and public link end, so decrypting it later gives no access back; a room it had is ended,
    // which forgets the edits it kept.
    if (encrypting !== null) {
      await env.FILES.delete([thumbKey(ownerId, id), indexKey(ownerId, id), pageKey(ownerId, id)]);
      await dropSharing(env, id);
      await endRooms(env, [id]);
    }
    // The save is in: what it replaced is cleanup, which can wait until after the response.
    // Chunks a checkpoint still names stay; then the checkpoints the rules no longer keep go.
    const cleanup = (async () => {
      if (delta) await deleteChunkList(env, ownerId, id, await chunksToDelete(env, ownerId, db, id, dropped));
      else if (isChunked(before)) await deleteChunks(env, ownerId, id, await retainedChunks(env, ownerId, db, id));
      await prune(env, ownerId, db, id, size);
    })().catch((error) => console.error('chunk cleanup failed', error));
    // Anyone watching it (a document one person edits at a time) opens it again. Before answering, not deferred: whoever saved this
    // to hand the document over says so only once the answer is back, and the room must have told the watchers first.
    await roomSaved(env, id, updated[0].updated_at).catch((error) => console.error('telling the room failed', error));
    if (defer) defer(cleanup);
    else await cleanup;
    return json(describe({ ...row, name, size, encrypted: encrypted ? 1 : 0, wrapped_key: key, ...(encrypting !== null ? { thumb_at: null } : {}), updated_at: updated[0].updated_at }, role));
  }

  // PATCH /api/documents/:id { folderId?, name? }: moves it to a folder (null: the top level),
  // and/or renames it. Only the owner arranges their documents; neither counts as editing one
  // (so a save based on the version before still goes through). A rename this way works while
  // several people are editing it too, when the file itself can't be uploaded.
  if (request.method === 'PATCH') {
    const body = (await request.json().catch(() => null)) as { folderId?: unknown; name?: unknown } | null;
    // Someone editing a shared folder may rename what they added there, and move nothing (docs/folder-sharing.md).
    const ownAddition = !!access.folder && role === 'editor' && row.created_by === userId;
    if (role !== 'owner' && !(ownAddition && body?.name !== undefined && body.folderId === undefined)) throw new HttpError(403, 'only the owner can move this document');
    requireStorage();
    let next = row;
    if (body?.name !== undefined) {
      const name = typeof body.name === 'string' ? (row.encrypted ? sealedName(body.name) : cleanName(body.name)) : null;
      if (!name) throw new HttpError(400, 'expected a name');
      await db.run('UPDATE documents SET name = ? WHERE id = ?', [name, id]);
      next = { ...next, name };
    }
    if (body?.folderId !== undefined || body?.name === undefined) next = await moveDocument(db, next, body?.folderId);
    return json(describe(next, role));
  }

  // DELETE /api/documents/:id
  if (request.method === 'DELETE') {
    // Someone editing a shared folder may delete what they added there; it goes to the owner's trash.
    if (role !== 'owner' && !(access.folder && role === 'editor' && row.created_by === userId)) throw new HttpError(403, 'only the owner can delete this document');
    await deleteDocuments(env, ownerId, db, [row]);
    return new Response(null, { status: 204 });
  }

  throw new HttpError(405, 'method not allowed');
}
