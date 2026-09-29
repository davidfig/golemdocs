import { authenticate } from './auth.ts';
import { handleAuth } from './authRoutes.ts';
import type { ExportedHandler } from './cf.ts';
import { CloudflareError, userDb } from './userDb.ts';

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
function describe(row: DocumentRow) {
  return {
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

const handler: ExportedHandler = {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === 'GET' && path === '/api/health') return json({ ok: true });

      if (path.startsWith('/api/auth/')) return await handleAuth(request, env, url);

      const userId = await authenticate(request, env, url);
      if (!userId) throw new HttpError(401, 'not signed in');
      // The session cookie is SameSite=Lax already; this also refuses cross-origin writes outright.
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.get('origin') !== url.origin) {
        throw new HttpError(403, 'bad origin');
      }

      const match = /^\/api\/documents(?:\/([^/]+)(\/thumbnail)?)?$/.exec(path);
      if (!match) throw new HttpError(404, 'not found');
      const id = match[1];
      const thumbnail = match[2] !== undefined;
      if (id !== undefined && !ID.test(id)) throw new HttpError(404, 'not found');

      if (env.ENVIRONMENT === 'local') throw new HttpError(503, 'cloud storage is off in local-only mode (run pnpm dev without --local)');
      if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || env.CF_ACCOUNT_ID.startsWith('REPLACE')) {
        throw new HttpError(503, 'cloud storage is not configured');
      }
      const db = await userDb(env, userId);
      const keyFor = (docId: string) => `${userId}/${docId}.docx`;
      const thumbKeyFor = (docId: string) => `${userId}/${docId}.thumb`;

      // GET /api/documents: the user's documents, newest first.
      if (!id && request.method === 'GET') {
        const rows = await db.all<DocumentRow>('SELECT * FROM documents ORDER BY updated_at DESC');
        return json(rows.map(describe));
      }

      // POST /api/documents?name=…: a new document from the request body (.docx bytes).
      if (!id && request.method === 'POST') {
        const bytes = await readDocx(request);
        const docId = crypto.randomUUID();
        const name = cleanName(url.searchParams.get('name')) ?? 'Untitled.docx';
        const now = Date.now();
        // Bytes first: a failure leaves an unreferenced object, never a row pointing at nothing.
        await env.FILES.put(keyFor(docId), bytes, { httpMetadata: { contentType: DOCX } });
        await db.run('INSERT INTO documents (id, name, size, r2_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
          docId,
          name,
          bytes.byteLength,
          keyFor(docId),
          now,
          now,
        ]);
        return json({ id: docId, name, size: bytes.byteLength, createdAt: now, updatedAt: now, thumbAt: null }, 201);
      }

      if (!id) throw new HttpError(405, 'method not allowed');

      const row = await db.first<DocumentRow>('SELECT * FROM documents WHERE id = ?', [id]);
      if (!row) throw new HttpError(404, 'not found');

      // GET/PUT /api/documents/:id/thumbnail: a small image of the first page, made by the client.
      // The client asks for it as `?v=<thumbAt>`, so a given URL never changes and can be cached hard.
      if (thumbnail) {
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
          const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
          if (!THUMB_TYPES.has(type)) throw new HttpError(415, 'thumbnails are webp, png or jpeg');
          const bytes = await readBody(request, MAX_THUMB_BYTES, 'thumbnail');
          const now = Date.now();
          await env.FILES.put(thumbKeyFor(id), bytes, { httpMetadata: { contentType: type } });
          await db.run('UPDATE documents SET thumb_at = ? WHERE id = ?', [now, id]);
          return json(describe({ ...row, thumb_at: now }));
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
        const bytes = await readDocx(request);
        const name = cleanName(url.searchParams.get('name')) ?? row.name;
        const now = Date.now();
        await env.FILES.put(row.r2_key, bytes, { httpMetadata: { contentType: DOCX } });
        await db.run('UPDATE documents SET name = ?, size = ?, updated_at = ? WHERE id = ?', [name, bytes.byteLength, now, id]);
        return json(describe({ ...row, name, size: bytes.byteLength, updated_at: now }));
      }

      // DELETE /api/documents/:id
      if (request.method === 'DELETE') {
        // Row first: a failure leaves an unreferenced object, never a row pointing at nothing.
        await db.run('DELETE FROM documents WHERE id = ?', [id]);
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
