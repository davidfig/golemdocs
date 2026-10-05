import { isAdmin, pictureOf } from './accounts.ts';
import { userAnalytics } from './analytics.ts';
import { assistantStatus, handleAssistant } from './assistant.ts';
import { authenticate } from './auth.ts';
import { handleAuth } from './authRoutes.ts';
import { billingSummary } from './billing.ts';
import type { Env, ExportedHandler } from './cf.ts';
import { handleDocuments, ownStorage, resolveAccess, type DocumentRoute } from './documents.ts';
import { MAX_FEEDBACK_CHARS, addFeedback, allFeedback, deleteFeedback, resolveFeedback } from './feedback.ts';
import { HttpError, ID, json } from './http.ts';
import { handleFolders } from './folders.ts';
import { handleRoomMedia } from './roomMedia.ts';
import { handlePreferences } from './preferences.ts';
import { Room } from './room.ts';
import { joinRoom, roomHeaders } from './roomGate.ts';
import { handleSearch } from './search.ts';
import { handlePolarWebhook, hasSync, startCheckout, startPortal, subscriptionFor, subscriptionRequired } from './subscriptions.ts';
import { CloudflareError, existingUserDb } from './userDb.ts';

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

      // A picture added while a document is edited together: its bytes, by hash.
      const mediaMatch = /^\/api\/rooms\/([^/]+)\/media\/([^/]+)$/.exec(path);
      if (mediaMatch) {
        const docId = mediaMatch[1]!;
        if (!ID.test(docId)) throw new HttpError(404, 'not found');
        const access = await resolveAccess(env, userId, docId);
        if (!access) throw new HttpError(404, 'not found');
        await requireOwnerSync(env, userId, access.ownerId);
        return await handleRoomMedia(request, env, access.ownerId, docId, access.role, mediaMatch[2]!);
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
        const headers = roomHeaders(request.headers, userId, access.role, access.ownerId, docId, roomMatch[2] ? null : await pictureOf(env, userId));
        return joinRoom(env, docId, headers, !!roomMatch[2]);
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

      // Everything under /api/admin/ is for admins only. The check is here, once, for the whole prefix, so no
      // admin route can forget it; the client hiding the menu is a convenience, not the protection.
      if (path === '/api/admin' || path.startsWith('/api/admin/')) {
        if (!(await isAdmin(env, userId))) throw new HttpError(403, 'forbidden');
      }

      // GET /api/admin/billing: what Cloudflare is charging this month.
      if (path === '/api/admin/billing' && request.method === 'GET') {
        return json(await billingSummary(env));
      }

      // GET /api/admin/analytics: how many users there are and how that grew. 
      if (path === '/api/admin/analytics' && request.method === 'GET') {
        return json(await userAnalytics(env));
      }

      // GET /api/admin/feedback: everything people have sent. 
      if (path === '/api/admin/feedback' && request.method === 'GET') {
        return json(await allFeedback(env));
      }

      // PATCH /api/admin/feedback/:id { resolved }, DELETE /api/admin/feedback/:id. 
      const feedbackMatch = /^\/api\/admin\/feedback\/(\d+)$/.exec(path);
      if (feedbackMatch) {
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

      // GET/PUT /api/preferences: the user's interface settings, kept in their account (preferences.ts).
      if (path === '/api/preferences') {
        if (env.ENVIRONMENT !== 'local' && (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || env.CF_ACCOUNT_ID.startsWith('REPLACE'))) {
          throw new HttpError(503, 'cloud storage is not configured');
        }
        const { syncing, ownDb } = await ownStorage(env, userId, request.method);
        return await handlePreferences(request, url, ownDb, syncing);
      }

      // The rest are the user's folders (folders.ts) and documents (documents.ts).
      const match = /^\/api\/(documents|shared|folders)(?:\/([^/]+)(?:\/(thumbnail|index|shares)(?:\/([^/]+))?)?)?$/.exec(path);
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
      if (collection === 'folders') {
        const { syncing, ownDb } = await ownStorage(env, userId, request.method);
        return await handleFolders(request, id, ownDb, syncing);
      }
      return await handleDocuments(request, env, userId, url, { collection, id, sub, granteeId } as DocumentRoute, ctx && ((work) => ctx.waitUntil(work)));
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
