import { authenticate } from './auth.ts';
import { handleAuth } from './authRoutes.ts';
import type { Env, ExportedHandler } from './cf.ts';
import { accessFor, canWrite, forgetDocument, person, registerOwner, sharedWith, sharesOf, shareWith, unshare, userByEmail, type Role, type ShareRole } from './sharing.ts';
import { CloudflareError, userDb, type UserDb } from './userDb.ts';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_THUMB_BYTES = 512 * 1024;
const THUMB_TYPES = new Set(['image/webp', 'image/png', 'image/jpeg']);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface DocumentRow {
  id: string;
  name: string;
  size: number;
  r2_key: string;
  created_at: number;
  updated_at: number;
  /** When the thumbnail was last uploaded; null if there is none. */
  thumb_at: number | null;
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
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

function cleanName(raw: string | null): string | null {
  const name = raw?.trim().slice(0, 255);
  return name ? name : null;
}

async function readBody(request: Request, limit: number, what: string): Promise<ArrayBuffer> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > limit) throw new HttpError(413, `${what} too large`);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > limit) throw new HttpError(413, `${what} too large`);
  if (bytes.byteLength === 0) throw new HttpError(400, 'empty body');
  return bytes;
}

const readDocx = (request: Request) => readBody(request, MAX_BYTES, 'document');

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

const handler: ExportedHandler = {
  async fetch(request, env) {
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

      const userId = await authenticate(request, env, url);
      if (!userId) throw new HttpError(401, 'not signed in');
      // The session cookie is SameSite=Lax already; this also refuses cross-origin writes outright.
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.get('origin') !== url.origin) {
        throw new HttpError(403, 'bad origin');
      }

      const match = /^\/api\/(documents|shared)(?:\/([^/]+)(?:\/(thumbnail|shares)(?:\/([^/]+))?)?)?$/.exec(path);
      if (!match) throw new HttpError(404, 'not found');
      const [, collection, id, sub, granteeId] = match;
      if (id !== undefined && !ID.test(id)) throw new HttpError(404, 'not found');
      if (collection === 'shared' && id !== undefined) throw new HttpError(404, 'not found');

      if (env.ENVIRONMENT === 'local') throw new HttpError(503, 'cloud storage is off in local-only mode (run pnpm dev without --local)');
      if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || env.CF_ACCOUNT_ID.startsWith('REPLACE')) {
        throw new HttpError(503, 'cloud storage is not configured');
      }
      const ownDb = await userDb(env, userId);

      // GET /api/shared: documents other people shared with this user.
      if (collection === 'shared') {
        if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
        const byOwner = new Map<string, Map<string, ShareRole>>();
        for (const s of await sharedWith(env, userId)) {
          if (!byOwner.has(s.ownerId)) byOwner.set(s.ownerId, new Map());
          byOwner.get(s.ownerId)!.set(s.docId, s.role);
        }
        const out: unknown[] = [];
        for (const [ownerId, roles] of byOwner) {
          const ids = [...roles.keys()];
          const rows = await (await userDb(env, ownerId)).all<DocumentRow>(`SELECT * FROM documents WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
          const owner = await person(env, ownerId);
          for (const row of rows) out.push({ ...describe(row, roles.get(row.id)!), owner: { name: owner.name, email: owner.email } });
        }
        return json(out);
      }

      // GET /api/documents: the user's documents, newest first.
      if (!id && request.method === 'GET') {
        const rows = await ownDb.all<DocumentRow>('SELECT * FROM documents ORDER BY updated_at DESC');
        // Documents from before sharing existed are claimed here, so rooms and shares can find them.
        await Promise.all(rows.map((row) => registerOwner(env, row.id, userId)));
        return json(rows.map((row) => describe(row)));
      }

      // POST /api/documents?name=…: a new document from the request body (.docx bytes).
      if (!id && request.method === 'POST') {
        const bytes = await readDocx(request);
        const docId = crypto.randomUUID();
        const name = cleanName(url.searchParams.get('name')) ?? 'Untitled.docx';
        const now = Date.now();
        // Bytes first: a failure leaves an unreferenced object, never a row pointing at nothing.
        await env.FILES.put(`${userId}/${docId}.docx`, bytes, { httpMetadata: { contentType: DOCX } });
        await ownDb.run('INSERT INTO documents (id, name, size, r2_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
          docId,
          name,
          bytes.byteLength,
          `${userId}/${docId}.docx`,
          now,
          now,
        ]);
        await registerOwner(env, docId, userId);
        return json({ role: 'owner', id: docId, name, size: bytes.byteLength, createdAt: now, updatedAt: now, thumbAt: null }, 201);
      }

      if (!id) throw new HttpError(405, 'method not allowed');

      // Whose document is it, and what may this user do with it?
      let access = await accessFor(env, userId, id);
      if (!access && (await ownDb.first('SELECT 1 FROM documents WHERE id = ?', [id]))) {
        await registerOwner(env, id, userId);
        access = { role: 'owner', ownerId: userId };
      }
      if (!access) throw new HttpError(404, 'not found');
      const { role, ownerId } = access;
      const db: UserDb = ownerId === userId ? ownDb : await userDb(env, ownerId);
      const thumbKeyFor = (docId: string) => `${ownerId}/${docId}.thumb`;

      const row = await db.first<DocumentRow>('SELECT * FROM documents WHERE id = ?', [id]);
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
          const body = (await request.json().catch(() => null)) as { email?: unknown; role?: unknown } | null;
          if (typeof body?.email !== 'string' || (body.role !== 'editor' && body.role !== 'viewer')) throw new HttpError(400, 'expected { email, role: "editor" | "viewer" }');
          const target = await userByEmail(env, body.email);
          if (!target) throw new HttpError(404, 'nobody with that email has signed in to Golem Docs yet');
          if (target === userId) throw new HttpError(400, 'you already own this document');
          await shareWith(env, id, target, body.role);
          return json({ ...(await person(env, target)), role: body.role });
        }
        if (granteeId !== undefined && request.method === 'DELETE') {
          if (role !== 'owner' && granteeId !== userId) throw new HttpError(403, 'only the owner can remove other people');
          await unshare(env, id, granteeId);
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
            },
          });
        }
        if (request.method === 'PUT') {
          requireWrite();
          const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
          if (!THUMB_TYPES.has(type)) throw new HttpError(415, 'thumbnails are webp, png or jpeg');
          const bytes = await readBody(request, MAX_THUMB_BYTES, 'thumbnail');
          const now = Date.now();
          await env.FILES.put(thumbKeyFor(id), bytes, { httpMetadata: { contentType: type } });
          await db.run('UPDATE documents SET thumb_at = ? WHERE id = ?', [now, id]);
          return json(describe({ ...row, thumb_at: now }, role));
        }
        throw new HttpError(405, 'method not allowed');
      }

      // GET /api/documents/:id: the .docx bytes.
      if (request.method === 'GET') {
        const object = await env.FILES.get(row.r2_key);
        if (!object) throw new HttpError(404, 'document file is missing');
        return new Response(object.body, {
          headers: { 'content-type': DOCX, 'content-length': String(object.size), etag: object.httpEtag, 'cache-control': 'private, no-cache' },
        });
      }

      // PUT /api/documents/:id[?name=…]: replace the bytes (and optionally rename).
      if (request.method === 'PUT') {
        requireWrite();
        const bytes = await readDocx(request);
        const name = cleanName(url.searchParams.get('name')) ?? row.name;
        const now = Date.now();
        await env.FILES.put(row.r2_key, bytes, { httpMetadata: { contentType: DOCX } });
        await db.run('UPDATE documents SET name = ?, size = ?, updated_at = ? WHERE id = ?', [name, bytes.byteLength, now, id]);
        return json(describe({ ...row, name, size: bytes.byteLength, updated_at: now }, role));
      }

      // DELETE /api/documents/:id
      if (request.method === 'DELETE') {
        if (role !== 'owner') throw new HttpError(403, 'only the owner can delete this document');
        // Row first: a failure leaves an unreferenced object, never a row pointing at nothing.
        await db.run('DELETE FROM documents WHERE id = ?', [id]);
        await forgetDocument(env, id);
        await env.FILES.delete([row.r2_key, thumbKeyFor(id)]);
        return new Response(null, { status: 204 });
      }

      throw new HttpError(405, 'method not allowed');
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(error instanceof CloudflareError ? `${error.message} ${JSON.stringify(error.errors)}` : error);
      return json({ error: 'internal error' }, 500);
    }
  },
};

export default handler;
