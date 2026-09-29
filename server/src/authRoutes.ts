// /api/auth/*: sign-in with Google, Microsoft, GitHub or Apple.
//
//   GET  /api/auth/providers            which providers are configured
//   GET  /api/auth/start/:provider      redirect to the provider (?return=/path to come back to)
//   GET|POST /api/auth/callback/:provider   the provider sends the user back here (Apple POSTs)
//   GET  /api/auth/me                   the signed-in user, or { user: null }
//   POST /api/auth/logout               end the session

import { describeUser, userForProfile } from './accounts.ts';
import { authenticate } from './auth.ts';
import type { Env } from './cf.ts';
import { base64url, constantTimeEqual, fromBase64url, pkceChallenge, randomToken } from './crypto.ts';
import { AuthError, PROVIDERS, providerFor } from './providers.ts';
import { clearCookie, cookieName, createSession, destroySession, readCookie, setCookie } from './session.ts';

const FLOW_COOKIE = 'oauth_flow';
const FLOW_TTL_SECONDS = 600;

interface Flow {
  provider: string;
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}

/** Only same-site paths: never an absolute or protocol-relative URL (open redirect). */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || /[\r\n]/.test(value)) return '/';
  return value;
}

function redirect(location: string, status: number, cookies: string[] = []): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status, headers });
}

function fail(cookies: string[], reason: string): Response {
  return redirect(`/?auth_error=${encodeURIComponent(reason)}`, 303, cookies);
}

export async function handleAuth(request: Request, env: Env, url: URL): Promise<Response> {
  const parts = url.pathname.split('/').slice(3); // after /api/auth/
  const [action, providerId] = parts;

  if (action === 'providers' && request.method === 'GET') {
    return json(Object.values(PROVIDERS).filter((p) => p.enabled(env)).map((p) => ({ id: p.id, name: p.name })));
  }

  if (action === 'me' && request.method === 'GET') {
    const userId = await authenticate(request, env, url);
    return json({ user: userId ? await describeUser(env, userId) : null });
  }

  if (action === 'logout' && request.method === 'POST') {
    if (request.headers.get('origin') !== url.origin) return json({ error: 'bad origin' }, 403);
    await destroySession(env, request, url);
    return json({ ok: true }, 200, { 'set-cookie': clearCookie(url, 'session') });
  }

  const provider = providerId ? providerFor(providerId) : null;
  if (!provider || !provider.enabled(env)) return json({ error: 'not found' }, 404);
  const redirectUri = `${url.origin}/api/auth/callback/${provider.id}`;

  if (action === 'start' && request.method === 'GET') {
    const flow: Flow = {
      provider: provider.id,
      state: randomToken(),
      nonce: randomToken(16),
      verifier: randomToken(32),
      returnTo: safeReturnPath(url.searchParams.get('return')),
    };
    const target = provider.authorizeUrl(env, { redirectUri, state: flow.state, nonce: flow.nonce, challenge: await pkceChallenge(flow.verifier) });
    const cookie = setCookie(url, FLOW_COOKIE, base64url(new TextEncoder().encode(JSON.stringify(flow))), {
      maxAgeSeconds: FLOW_TTL_SECONDS,
      crossSite: provider.formPost,
    });
    return redirect(target.toString(), 302, [cookie]);
  }

  if (action === 'callback' && (request.method === 'GET' || (request.method === 'POST' && provider.formPost))) {
    const clear = clearCookie(url, FLOW_COOKIE, provider.formPost);
    const form = request.method === 'POST' ? new URLSearchParams(await request.text()) : url.searchParams;

    let flow: Flow | null = null;
    try {
      const raw = readCookie(request, cookieName(url, FLOW_COOKIE));
      flow = raw ? (JSON.parse(new TextDecoder().decode(fromBase64url(raw))) as Flow) : null;
    } catch {
      flow = null;
    }
    const state = form.get('state') ?? '';
    if (!flow || flow.provider !== provider.id || !constantTimeEqual(flow.state, state)) return fail([clear], 'state');
    if (form.get('error')) return fail([clear], form.get('error') === 'access_denied' ? 'denied' : 'provider');
    const code = form.get('code');
    if (!code) return fail([clear], 'provider');

    try {
      const profile = await provider.profile(env, { code, redirectUri, verifier: flow.verifier, nonce: flow.nonce, form });
      const userId = await userForProfile(env, provider.id, profile);
      const session = await createSession(env, url, userId);
      return redirect(safeReturnPath(flow.returnTo), 303, [session, clear]);
    } catch (error) {
      console.error(`sign-in with ${provider.id} failed:`, error instanceof AuthError ? error.message : error);
      return fail([clear], 'failed');
    }
  }

  return json({ error: 'not found' }, 404);
}
