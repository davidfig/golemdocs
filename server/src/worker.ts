import { isAdmin, pictureOf } from './accounts.ts';
import { DOCX, docxKey, thumbKey } from './keys.ts';
import { assistantStatus, handleAssistant } from './assistant.ts';
import { authenticate } from './auth.ts';
import { handleAuth } from './authRoutes.ts';
import { billingSummary } from './billing.ts';
import type { Env, ExportedHandler } from './cf.ts';
import { MAX_FEEDBACK_CHARS, addFeedback, allFeedback, deleteFeedback, resolveFeedback } from './feedback.ts';
import { cleanName, failure, HttpError, ID, idList, IDS_PER_QUERY, json, MAX_BATCH, perChunk, type Failure } from './http.ts';
import { checkFolder, handleFolders, type FolderRow } from './folders.ts';
import { Room } from './room.ts';
import { handleSearch, removeManyFromIndex } from './search.ts';
import { accessFor, canWrite, forgetDocuments, person, registerOwner, registerOwners, sharedWith, sharesOf, shareWith, unshare, userByEmail, type Access, type Role, type ShareRole } from './sharing.ts';
import { handlePolarWebhook, hasSync, startCheckout, startPortal, subscriptionFor, subscriptionRequired } from './subscriptions.ts';
import { CloudflareError, existingUserDb, userDb, type UserDb } from './userDb.ts';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_THUMB_BYTES = 512 * 1024;
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
}

/** What the client sees of a document (the R2 key stays server-side). */
function describe(row: DocumentRow, role: Role = 'owner') {
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
  };
}

/** An owner's documents, newest first, from the catalogue cache when it is current. */
function listDocuments(env: Env, ownerId: string, db: UserDb): Promise<DocumentRow[]> {
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
  const to = await checkFolder(db, folderId);
  await db.run('UPDATE documents SET folder_id = ? WHERE id = ?', [to, row.id]);
  return { ...row, folder_id: to };
}

const ROOMS_AT_ONCE = 25;

/**
 * Deletes the owner's documents: the rows, then their shares, search entries, rooms and files. The
 * rows are what make a document gone, so once they are deleted the rest is cleanup: with `defer`
 * it is handed over to carry on after the response (it cannot fail the request; a failure leaves
 * unreferenced objects, never a row pointing at nothing), otherwise it is done before returning.
 * `also` goes in the same transaction as the rows (a folder delete's folders, so either both go or neither).
 */
async function deleteDocuments(env: Env, ownerId: string, db: UserDb, rows: DocumentRow[], defer?: (work: Promise<unknown>) => void, also: { sql: string; params: unknown[] }[] = []): Promise<void> {
  const ids = rows.map((r) => r.id);
  // Many to a statement and all in one request to Cloudflare, which limits how many it takes.
  await db.runAll([...perChunk(ids, (marks) => `DELETE FROM documents WHERE id IN (${marks})`), ...also]);
  // The owner and share rows are what let the bytes be read straight from R2 (see the fast read in
  // the handler), so they go before answering: deferred work can be cut short, and the files would
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
    await removeManyFromIndex(env, ids);
    // Each room is told in its own request: a few dozen at a time rather than one after another.
    if (env.ROOMS) {
      for (let i = 0; i < rows.length; i += ROOMS_AT_ONCE) {
        await Promise.all(rows.slice(i, i + ROOMS_AT_ONCE).map((row) => roomFor(env, row.id).fetch(new Request('https://room/end'))));
      }
    }
    // R2 refuses an empty list (a folder with no documents) and more than 1000 keys at once.
    const keys = rows.flatMap((row) => [row.r2_key, thumbKey(ownerId, row.id)]);
    for (let i = 0; i < keys.length; i += 1000) await env.FILES.delete(keys.slice(i, i + 1000));
  };
  if (defer) defer(cleanup().catch((error) => console.error('delete cleanup failed', error)));
  else await cleanup();
}

async function readBody(request: Request, limit: number, what: string, allowEmpty = false): Promise<ArrayBuffer> {
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
    for (const row of await db.all<{ id: string }>(`SELECT id FROM folders WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk)) folders.add(row.id);
  }

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

/**
 * The request's URL as the browser sees it. In development the client's Vite server proxies
 * /api to this Worker, which would otherwise see its own address; production never trusts this.
 */
function publicUrl(request: Request, env: Env): URL {
  const url = new URL(request.url);
  const development = env.ENVIRONMENT === 'local' || env.ENVIRONMENT === 'dev';
  const devOrigin = development ? request.headers.get('x-dev-origin') : null;
  if (!devOrigin) return url;
  const origin = new URL(devOrigin);
  url.protocol = origin.protocol;
  url.host = origin.host;
  return url;
}

/** Refuses (402 to the owner, 403 to anyone else) unless the document's owner has sync. */
async function requireOwnerSync(env: Env, userId: string, ownerId: string): Promise<void> {
  if (await hasSync(env, ownerId)) return;
  if (ownerId === userId) throw subscriptionRequired();
  throw new HttpError(403, 'the owner’s subscription has ended', 'subscription');
}

/** The room object for a document. */
const roomFor = (env: Env, docId: string) => env.ROOMS.get(env.ROOMS.idFromName(docId));

const roomHeaders = (headers: Headers, userId: string, role: Role, ownerId: string, docId: string, picture: string | null): Headers => {
  const out = new Headers(headers);
  // Set here and nowhere else: whatever the client sent is replaced.
  out.set('x-user', userId);
  out.set('x-role', role);
  out.set('x-owner', ownerId);
  out.set('x-doc', docId);
  out.delete('x-picture');
  if (picture) out.set('x-picture', picture);
  return out;
};

/**
 * The user's access to a document. Documents from before sharing existed have no owner record;
 * finding one in the user's own catalogue claims it.
 */
async function resolveAccess(env: Env, userId: string, docId: string, knownDb?: UserDb | null, early?: Promise<Access | null>): Promise<Access | null> {
  const access = await (early ?? accessFor(env, userId, docId));
  if (access) return access;
  if (knownDb === null) return null; // no database of their own, so nothing to claim
  if (env.ENVIRONMENT !== 'local' && !env.CF_API_TOKEN) return null;
  const db = knownDb ?? (await userDb(env, userId));
  if (!(await db.first('SELECT 1 FROM documents WHERE id = ?', [docId]))) return null;
  await registerOwner(env, docId, userId);
  return { role: 'owner', ownerId: userId };
}

const handler: ExportedHandler = {
  async fetch(request, env, ctx) {
    try {
      const url = publicUrl(request, env);
      const path = url.pathname;
      // Production is https only: sign-in redirects and secure cookies are built from this URL.
      if (env.ENVIRONMENT === 'production' && url.protocol === 'http:') {
        url.protocol = 'https:';
        return new Response(null, { status: 308, headers: { location: url.href } });
      }

      if (request.method === 'GET' && path === '/api/health') return json({ ok: true });

      if (path.startsWith('/api/auth/')) return await handleAuth(request, env, url);

      // Polar's webhook has no session or origin; its signature is checked inside.
      if (path === '/api/webhooks/polar' && request.method === 'POST') return await handlePolarWebhook(request, env);

      const userId = await authenticate(request, env, url);
      if (!userId) throw new HttpError(401, 'not signed in');
      // The session cookie is SameSite=Lax already; this also refuses cross-origin writes outright.
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.get('origin') !== url.origin) {
        throw new HttpError(403, 'bad origin');
      }

      const roomMatch = /^\/api\/rooms\/([^/]+)(\/document)?$/.exec(path);
      if (roomMatch) {
        const docId = roomMatch[1]!;
        if (!ID.test(docId) || request.method !== 'GET') throw new HttpError(404, 'not found');
        // Cookies ride along on cross-site WebSocket handshakes, so their origin is checked here
        // (a same-origin GET carries none, and the document is readable like any other GET).
        if (!roomMatch[2] && request.headers.get('origin') !== url.origin) throw new HttpError(403, 'bad origin');
        if (!env.ROOMS) throw new HttpError(503, 'multiplayer is not configured');
        const access = await resolveAccess(env, userId, docId);
        if (!access) throw new HttpError(404, 'not found');
        // The room saves into the owner's storage, so the owner must have sync (whoever is joining).
        await requireOwnerSync(env, userId, access.ownerId);
        const room = roomFor(env, docId);
        const headers = roomHeaders(request.headers, userId, access.role, access.ownerId, docId, roomMatch[2] ? null : await pictureOf(env, userId));
        return room.fetch(new Request(`https://room/${roomMatch[2] ? 'document' : 'ws'}`, { headers }));
      }

      // GET /api/subscription: whether this user has paid for sync.
      if (path === '/api/subscription' && request.method === 'GET') return json({ ...((await subscriptionFor(env, userId)) ?? { status: 'none', active: false, currentPeriodEnd: null, cancelAtPeriodEnd: false }), sync: await hasSync(env, userId) });

      // POST /api/checkout: the Polar page where this user pays for sync. POST /api/portal: where they manage it.
      if (path === '/api/checkout' && request.method === 'POST') return json(await startCheckout(env, userId, `${url.origin}/?subscribed=1`));
      if (path === '/api/portal' && request.method === 'POST') return json(await startPortal(env, userId));
      // GET /api/assistant: whether the assistant is on, and this user's credits. POST: one model turn (subscribers).
      if (path === '/api/assistant') {
        if (request.method === 'GET') return json(await assistantStatus(env, userId));
        if (request.method === 'POST') return await handleAssistant(request, env, userId, json);
        throw new HttpError(405, 'method not allowed');
      }

      // GET /api/assistant/search?q=…: which of this user's documents are about something (see search.ts).
      if (path === '/api/assistant/search' && request.method === 'GET') return json(await handleSearch(env, userId, url.searchParams.get('q') ?? '', await existingUserDb(env, userId)));

      // GET /api/admin/billing: what Cloudflare is charging this month. Admins only.
      if (path === '/api/admin/billing' && request.method === 'GET') {
        if (!(await isAdmin(env, userId))) throw new HttpError(403, 'forbidden');
        return json(await billingSummary(env));
      }

      // GET /api/admin/feedback: everything people have sent. Admins only.
      if (path === '/api/admin/feedback' && request.method === 'GET') {
        if (!(await isAdmin(env, userId))) throw new HttpError(403, 'forbidden');
        return json(await allFeedback(env));
      }

      // PATCH /api/admin/feedback/:id { resolved }, DELETE /api/admin/feedback/:id. Admins only.
      const feedbackMatch = /^\/api\/admin\/feedback\/(\d+)$/.exec(path);
      if (feedbackMatch) {
        if (!(await isAdmin(env, userId))) throw new HttpError(403, 'forbidden');
        const id = Number(feedbackMatch[1]);
        if (request.method === 'DELETE') {
          if (!(await deleteFeedback(env, id))) throw new HttpError(404, 'not found');
          return json({ ok: true });
        }
        if (request.method === 'PATCH') {
          const body = (await request.json().catch(() => null)) as { resolved?: unknown } | null;
          if (typeof body?.resolved !== 'boolean') throw new HttpError(400, 'expected { resolved: boolean }');
          if (!(await resolveFeedback(env, id, body.resolved))) throw new HttpError(404, 'not found');
          return json({ ok: true });
        }
        throw new HttpError(405, 'method not allowed');
      }

      // POST /api/feedback { message }: send feedback to the admins.
      if (path === '/api/feedback' && request.method === 'POST') {
        const body = (await request.json().catch(() => null)) as { message?: unknown } | null;
        const message = typeof body?.message === 'string' ? body.message.trim() : '';
        if (!message) throw new HttpError(400, 'expected { message }');
        if (message.length > MAX_FEEDBACK_CHARS) throw new HttpError(413, 'feedback is too long');
        await addFeedback(env, userId, message);
        return json({ ok: true }, 201);
      }

      const match = /^\/api\/(documents|shared|folders)(?:\/([^/]+)(?:\/(thumbnail|shares)(?:\/([^/]+))?)?)?$/.exec(path);
      if (!match) throw new HttpError(404, 'not found');
      const [, collection, id, sub, granteeId] = match;
      const batchUpload = collection === 'documents' && id === 'batch' && sub === undefined;
      if (id !== undefined && !batchUpload && !ID.test(id)) throw new HttpError(404, 'not found');
      if (collection === 'shared' && id !== undefined) throw new HttpError(404, 'not found');
      if (collection === 'folders' && sub !== undefined) throw new HttpError(404, 'not found');

      // Locally, catalogues live in the simulated directory database (see userDb.ts).
      if (env.ENVIRONMENT !== 'local' && (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || env.CF_ACCOUNT_ID.startsWith('REPLACE'))) {
        throw new HttpError(503, 'cloud storage is not configured');
      }
      // Who may open the document doesn't depend on the user's database, so both are looked up together.
      const earlyAccess = id !== undefined && collection === 'documents' ? accessFor(env, userId, id) : undefined;
      earlyAccess?.catch(() => {}); // reported where it is awaited
      // Reading a document's bytes or thumbnail needs only who owns it (the directory knows) and the
      // object in R2, whose key follows from both. So the common read skips the user's own database
      // (and the catalogue) altogether; a document stored under another key takes the full route below.
      if (earlyAccess && request.method === 'GET' && (sub === undefined || sub === 'thumbnail')) {
        const access = await earlyAccess;
        if (access && (access.ownerId === userId || (await hasSync(env, access.ownerId)))) {
          const thumb = sub === 'thumbnail';
          const object = await env.FILES.get(thumb ? thumbKey(access.ownerId, id) : docxKey(access.ownerId, id));
          if (object) {
            return new Response(object.body, {
              headers: thumb
                ? {
                    'content-type': object.httpMetadata?.contentType ?? 'image/webp',
                    'content-length': String(object.size),
                    etag: object.httpEtag,
                    'cache-control': url.searchParams.has('v') ? 'private, max-age=31536000, immutable' : 'private, no-cache',
                    'x-content-type-options': 'nosniff',
                  }
                : { 'content-type': DOCX, 'content-length': String(object.size), etag: object.httpEtag, 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff' },
            });
          }
        }
      }
      // Whether this user may keep documents in the cloud. Without it they get no database of their
      // own (so nothing is created for people who only open what a subscriber shares), and what
      // they already have can be read and deleted but not changed.
      const syncing = await hasSync(env, userId);
      // A database is made on the first change, not the first look: a list of nothing needs none, and
      // each one made counts against the account's limit on databases.
      const ownDb = syncing && request.method !== 'GET' ? await userDb(env, userId) : await existingUserDb(env, userId);

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
            return rows.filter((row) => roles.has(row.id)).map((row) => ({ ...describe(row, roles.get(row.id)!), owner: { name: owner.name, email: owner.email } }));
          }),
        );
        return json(perOwner.flat());
      }

      if (collection === 'folders') return await handleFolders(request, id, ownDb, syncing);

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
      if (!id && request.method === 'POST') {
        if (!ownDb || !syncing) throw subscriptionRequired();
        const bytes = await readDocx(request);
        const docId = crypto.randomUUID();
        const name = cleanName(url.searchParams.get('name')) ?? 'Untitled.docx';
        const folderId = url.searchParams.get('folder');
        if (folderId !== null && !(await ownDb.first('SELECT 1 FROM folders WHERE id = ?', [folderId]))) throw new HttpError(400, 'no such folder');
        const now = Date.now();
        // Bytes first: a failure leaves an unreferenced object, never a row pointing at nothing.
        await env.FILES.put(docxKey(userId, docId), bytes, { httpMetadata: { contentType: DOCX } });
        await ownDb.run('INSERT INTO documents (id, name, size, r2_key, created_at, updated_at, folder_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [
          docId,
          name,
          bytes.byteLength,
          docxKey(userId, docId),
          now,
          now,
          folderId,
        ]);
        await registerOwner(env, docId, userId);
        return json({ role: 'owner', id: docId, name, size: bytes.byteLength, createdAt: now, updatedAt: now, thumbAt: null, folderId }, 201);
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
            const to = await checkFolder(ownDb, (body as { folderId?: unknown }).folderId);
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
            await deleteDocuments(env, userId, ownDb, doomed, ctx && ((work) => ctx.waitUntil(work)), folderDeletes);
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
          if (before && before.role !== body.role && env.ROOMS) await roomFor(env, id).fetch(new Request(`https://room/rejoin?user=${encodeURIComponent(target)}`));
          return json({ ...(await person(env, target)), role: body.role });
        }
        if (granteeId !== undefined && request.method === 'DELETE') {
          if (role !== 'owner' && granteeId !== userId) throw new HttpError(403, 'only the owner can remove other people');
          await unshare(env, id, granteeId);
          if (env.ROOMS) await roomFor(env, id).fetch(new Request(`https://room/kick?user=${encodeURIComponent(granteeId)}`));
          return new Response(null, { status: 204 });
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
        const object = await env.FILES.get(row.r2_key);
        if (!object) throw new HttpError(404, 'document file is missing');
        return new Response(object.body, {
          headers: { 'content-type': DOCX, 'content-length': String(object.size), etag: object.httpEtag, 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff' },
        });
      }

      // PUT /api/documents/:id[?name=…][&base=…]: replace the bytes (and optionally rename). With
      // `base` (the `updatedAt` the client's copy started from), a document changed elsewhere since
      // is refused with 409 instead of overwritten.
      if (request.method === 'PUT') {
        requireWrite();
        requireStorage();
        // While several people are editing, the room writes the file; an upload would be overwritten.
        // (423, not 409: 409 already means "changed elsewhere", which clients answer with a copy.)
        if (env.ROOMS && !((await (await roomFor(env, id).fetch(new Request('https://room/state'))).json()) as { maySave: boolean }).maySave) {
          throw new HttpError(423, 'this document is being edited by several people; the server is saving it');
        }
        const base = url.searchParams.get('base');
        if (base !== null && Number(base) !== row.updated_at) throw new HttpError(409, 'changed elsewhere');
        const bytes = await readDocx(request);
        const name = cleanName(url.searchParams.get('name')) ?? row.name;
        // With a base, the bytes go in only if nobody else's did since the row was read: two saves
        // from the same base both pass the check above, and without this the later one's bytes would
        // replace the earlier one's while the row still described the earlier one.
        const current = base === null ? null : row.r2_key === savedKey ? (fileBefore ?? null) : await env.FILES.head(row.r2_key);
        const written = await env.FILES.put(row.r2_key, bytes, { httpMetadata: { contentType: DOCX }, ...(current ? { onlyIf: { etagMatches: current.etag } } : {}) });
        if (current && written === null) throw new HttpError(409, 'changed elsewhere');
        // Strictly increasing, so two saves in the same millisecond still tell versions apart. With a
        // base it also has to be the version the save started from; and the row may be gone (deleted
        // meanwhile), which RETURNING tells apart from success.
        const updated = await db.run<{ updated_at: number }>(
          `UPDATE documents SET name = ?, size = ?, updated_at = MAX(?, updated_at + 1) WHERE id = ?${base !== null ? ' AND updated_at = ?' : ''} RETURNING updated_at`,
          [name, bytes.byteLength, Date.now(), id, ...(base !== null ? [row.updated_at] : [])],
        );
        if (!updated[0]) {
          if (base !== null && (await db.first('SELECT 1 FROM documents WHERE id = ?', [id]))) throw new HttpError(409, 'changed elsewhere');
          // Deleted while this save was on its way: the bytes just written belong to nothing.
          await env.FILES.delete(row.r2_key);
          throw new HttpError(404, 'not found');
        }
        return json(describe({ ...row, name, size: bytes.byteLength, updated_at: updated[0].updated_at }, role));
      }

      // PATCH /api/documents/:id { folderId?, name? }: moves it to a folder (null: the top level),
      // and/or renames it. Only the owner arranges their documents; neither counts as editing one
      // (so a save based on the version before still goes through). A rename this way works while
      // several people are editing it too, when the file itself can't be uploaded.
      if (request.method === 'PATCH') {
        if (role !== 'owner') throw new HttpError(403, 'only the owner can move this document');
        requireStorage();
        const body = (await request.json().catch(() => null)) as { folderId?: unknown; name?: unknown } | null;
        let next = row;
        if (body?.name !== undefined) {
          const name = typeof body.name === 'string' ? cleanName(body.name) : null;
          if (!name) throw new HttpError(400, 'expected a name');
          await db.run('UPDATE documents SET name = ? WHERE id = ?', [name, id]);
          next = { ...next, name };
        }
        if (body?.folderId !== undefined || body?.name === undefined) next = await moveDocument(db, next, body?.folderId);
        return json(describe(next, role));
      }

      // DELETE /api/documents/:id
      if (request.method === 'DELETE') {
        if (role !== 'owner') throw new HttpError(403, 'only the owner can delete this document');
        await deleteDocuments(env, ownerId, db, [row]);
        return new Response(null, { status: 204 });
      }

      throw new HttpError(405, 'method not allowed');
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
      console.error(error instanceof CloudflareError ? `${error.message} ${JSON.stringify(error.errors)}` : error);
      // Cloudflare's API is rate limited: tell the page to wait and try again, not that the server broke.
      if (error instanceof CloudflareError && error.status === 429) {
        // Past its limit Cloudflare blocks the API for five minutes.
        const wait = Math.min(Math.ceil(error.retryAfter ?? 30), 300);
        return new Response(JSON.stringify({ error: 'busy, try again shortly' }), { status: 429, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': String(wait) } });
      }
      return json({ error: 'internal error' }, 500);
    }
  },
};

export { Room };
export default handler;
