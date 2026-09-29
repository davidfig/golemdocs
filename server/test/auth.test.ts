// The sign-in flows end to end against a fake D1 (node:sqlite running the real migrations) and
// stubbed provider endpoints: state and nonce checks, account linking, sessions, Apple's signed
// client secret and form-post callback.

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';
import { authenticate } from '../src/auth.ts';
import { handleAuth, safeReturnPath } from '../src/authRoutes.ts';
import type { Env } from '../src/cf.ts';
import { base64url, fromBase64url, pkceChallenge } from '../src/crypto.ts';

const ORIGIN = 'https://app.example.com';
const KEYS = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const MS_ISSUER = 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0';

function fakeD1(): any {
  const db = new DatabaseSync(':memory:');
  for (const file of ['0001_users.sql', '0002_auth.sql']) {
    db.exec(readFileSync(new URL(`../migrations/directory/${file}`, import.meta.url), 'utf8'));
  }
  const statement = (sql: string, params: unknown[]): any => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => (db.prepare(sql).get(...(params as any[])) as any) ?? null,
    run: async () => {
      db.prepare(sql).run(...(params as any[]));
      return { results: [], success: true, meta: {} };
    },
    all: async () => ({ results: db.prepare(sql).all(...(params as any[])), success: true, meta: {} }),
  });
  return { prepare: (sql: string) => statement(sql, []), raw: db };
}

let env: Env;
const realFetch = globalThis.fetch;
/** Requests the stubbed providers received, and what they answer. */
let requests: { url: string; body: URLSearchParams }[];
let tokenResponse: (url: string) => Record<string, unknown>;
let githubEmails: { email: string; primary: boolean; verified: boolean }[];

beforeEach(() => {
  env = {
    DIRECTORY: fakeD1(),
    FILES: {} as any,
    CF_ACCOUNT_ID: 'acct',
    CF_API_TOKEN: 'tok',
    GOOGLE_CLIENT_ID: 'g-client',
    GOOGLE_CLIENT_SECRET: 'g-secret',
    MICROSOFT_CLIENT_ID: 'ms-client',
    MICROSOFT_CLIENT_SECRET: 'ms-secret',
    GITHUB_CLIENT_ID: 'gh-client',
    GITHUB_CLIENT_SECRET: 'gh-secret',
    APPLE_CLIENT_ID: 'com.example.services',
    APPLE_TEAM_ID: 'TEAM123456',
    APPLE_KEY_ID: 'KEY1234567',
    APPLE_PRIVATE_KEY: KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
  requests = [];
  githubEmails = [{ email: 'Dev@Example.com', primary: true, verified: true }];
  tokenResponse = () => {
    throw new Error('no token response set');
  };
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    const reply = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    if (url === 'https://api.github.com/user') return reply({ id: 4242, login: 'octo', name: 'Octo Cat' });
    if (url === 'https://api.github.com/user/emails') return reply(githubEmails);
    requests.push({ url, body: new URLSearchParams(init?.body ?? '') });
    return reply(tokenResponse(url));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const jwt = (claims: object) => `${base64url(new TextEncoder().encode('{"alg":"none"}'))}.${base64url(new TextEncoder().encode(JSON.stringify(claims)))}.sig`;
const exp = () => Math.floor(Date.now() / 1000) + 600;

function cookiesFrom(response: Response): Map<string, string> {
  const jar = new Map<string, string>();
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const index = pair!.indexOf('=');
    jar.set(pair!.slice(0, index), pair!.slice(index + 1));
  }
  return jar;
}
const cookieHeader = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const call = (path: string, init?: RequestInit) => handleAuth(new Request(ORIGIN + path, init), env, new URL(ORIGIN + path));

interface SignInOptions {
  claims?: Record<string, unknown>;
  /** Replaces or removes (undefined) id_token claims after defaults are applied. */
  tamper?: Record<string, unknown>;
  state?: string;
  form?: Record<string, string>;
}

/** Runs start then callback for a provider; returns the callback response. */
async function signIn(provider: string, options: SignInOptions = {}) {
  const start = await call(`/api/auth/start/${provider}?return=/docs`);
  assert.equal(start.status, 302);
  const target = new URL(start.headers.get('location')!);
  const flowJar = cookiesFrom(start);
  const nonce = target.searchParams.get('nonce') ?? '';
  const state = options.state ?? target.searchParams.get('state')!;

  const defaults: Record<string, Record<string, unknown>> = {
    google: { iss: 'https://accounts.google.com', aud: 'g-client' },
    microsoft: { iss: MS_ISSUER, aud: 'ms-client' },
    apple: { iss: 'https://appleid.apple.com', aud: 'com.example.services' },
  };
  tokenResponse = () => {
    if (provider === 'github') return { access_token: 'gho_test' };
    const claims: Record<string, unknown> = { ...defaults[provider], exp: exp(), nonce, ...options.claims, ...options.tamper };
    for (const [key, value] of Object.entries(claims)) if (value === undefined) delete claims[key];
    return { id_token: jwt(claims) };
  };

  const headers: Record<string, string> = { cookie: cookieHeader(flowJar) };
  let callback: Response;
  if (provider === 'apple') {
    const body = new URLSearchParams({ code: 'the-code', state, ...options.form });
    callback = await call('/api/auth/callback/apple', { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body });
  } else {
    callback = await call(`/api/auth/callback/${provider}?code=the-code&state=${encodeURIComponent(state)}`, { headers });
  }
  return { start, target, callback, session: cookiesFrom(callback).get('__Host-session') };
}

async function userOf(session: string | undefined): Promise<string | null> {
  const request = new Request(ORIGIN + '/api/documents', { headers: { cookie: `__Host-session=${session}` } });
  return authenticate(request, env, new URL(request.url));
}

test('only configured providers are offered', async () => {
  const all = (await (await call('/api/auth/providers')).json()) as { id: string }[];
  assert.deepEqual(all.map((p) => p.id).sort(), ['apple', 'github', 'google', 'microsoft']);
  delete env.APPLE_PRIVATE_KEY;
  delete env.GITHUB_CLIENT_SECRET;
  const some = (await (await call('/api/auth/providers')).json()) as { id: string }[];
  assert.deepEqual(some.map((p) => p.id).sort(), ['google', 'microsoft']);
  assert.equal((await call('/api/auth/start/apple')).status, 404);
  assert.equal((await call('/api/auth/start/nope')).status, 404);
});

test('google: PKCE, session, /me, logout', async () => {
  const { target, callback, session } = await signIn('google', { claims: { sub: 'g1', email: 'dev@example.com', email_verified: true, name: 'Dev' } });
  assert.equal(target.origin + target.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(target.searchParams.get('redirect_uri'), `${ORIGIN}/api/auth/callback/google`);
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), '/docs');
  assert.ok(session);
  // The verifier sent to the token endpoint hashes to the challenge sent to the authorize endpoint.
  const verifier = requests[0]!.body.get('code_verifier')!;
  assert.equal(await pkceChallenge(verifier), target.searchParams.get('code_challenge'));
  assert.match(callback.headers.getSetCookie().find((c) => c.startsWith('__Host-session'))!, /HttpOnly; SameSite=Lax; Max-Age=\d+; Secure/);

  const userId = await userOf(session);
  assert.ok(userId);
  const me = (await (await call('/api/auth/me', { headers: { cookie: `__Host-session=${session}` } })).json()) as any;
  assert.deepEqual(me.user, { id: userId, email: 'dev@example.com', name: 'Dev', isAdmin: false });
  // Only a hash of the token is stored.
  const stored = (env.DIRECTORY as any).raw.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0]!.token_hash, session);

  assert.equal((await call('/api/auth/logout', { method: 'POST', headers: { cookie: `__Host-session=${session}` } })).status, 403);
  const out = await call('/api/auth/logout', { method: 'POST', headers: { cookie: `__Host-session=${session}`, origin: ORIGIN } });
  assert.equal(out.status, 200);
  assert.equal(await userOf(session), null);
});

test('the same person signing in again gets the same user; sessions expire', async () => {
  const first = await signIn('google', { claims: { sub: 'g1', email: 'dev@example.com', email_verified: true } });
  const second = await signIn('google', { claims: { sub: 'g1', email: 'dev@example.com', email_verified: true } });
  assert.equal(await userOf(first.session), await userOf(second.session));
  (env.DIRECTORY as any).raw.exec('UPDATE sessions SET expires_at = 1');
  assert.equal(await userOf(first.session), null);
});

test('verified emails link providers; unverified ones never do', async () => {
  const google = await signIn('google', { claims: { sub: 'g1', email: 'dev@example.com', email_verified: true } });
  const github = await signIn('github'); // primary verified email Dev@Example.com
  assert.equal(await userOf(github.session), await userOf(google.session));

  const microsoft = await signIn('microsoft', { claims: { sub: 'm1', email: 'dev@example.com' } });
  assert.notEqual(await userOf(microsoft.session), await userOf(google.session));

  // An unverified GitHub email doesn't link either.
  (env.DIRECTORY as any).raw.exec("DELETE FROM identities WHERE provider = 'github'");
  githubEmails = [{ email: 'dev@example.com', primary: true, verified: false }];
  const unverified = await signIn('github');
  assert.notEqual(await userOf(unverified.session), await userOf(google.session));
});

test('rejects a wrong state, missing flow cookie, provider error, nonce, audience, issuer and expiry', async () => {
  const claims = { sub: 'g1', email: 'dev@example.com', email_verified: true };
  const reason = (r: Response) => new URL(r.headers.get('location')!, ORIGIN).searchParams.get('auth_error');

  const badState = await signIn('google', { claims, state: 'forged' });
  assert.equal(reason(badState.callback), 'state');
  assert.equal(badState.session, undefined);

  const noCookie = await call('/api/auth/callback/google?code=x&state=y');
  assert.equal(reason(noCookie), 'state');

  const start = await call('/api/auth/start/google');
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const denied = await call(`/api/auth/callback/google?error=access_denied&state=${state}`, { headers: { cookie: cookieHeader(cookiesFrom(start)) } });
  assert.equal(reason(denied), 'denied');

  for (const tamper of [{ nonce: 'other' }, { aud: 'someone-else' }, { iss: 'https://evil.example' }, { exp: 1 }, { sub: undefined }]) {
    const r = await signIn('google', { claims, tamper });
    assert.equal(reason(r.callback), 'failed', JSON.stringify(tamper));
    assert.equal(r.session, undefined);
  }
  // Microsoft: an issuer that isn't a tenant-scoped v2.0 issuer is refused.
  const ms = await signIn('microsoft', { claims: { sub: 'm1' }, tamper: { iss: 'https://login.microsoftonline.com/evil/v2.0' } });
  assert.equal(reason(ms.callback), 'failed');
  assert.equal((env.DIRECTORY as any).raw.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('a flow cookie is bound to its provider and cleared on use', async () => {
  const start = await call('/api/auth/start/google');
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  // The state from a Google flow can't complete a GitHub callback.
  const crossed = await call(`/api/auth/callback/github?code=x&state=${state}`, { headers: { cookie: cookieHeader(cookiesFrom(start)) } });
  assert.match(crossed.headers.get('location')!, /auth_error=state/);
  assert.ok(crossed.headers.getSetCookie().some((c) => c.includes('oauth_flow=;') && c.includes('Max-Age=0')));
});

test('apple: form-post callback, signed client secret, name from the form, cross-site cookie', async () => {
  const { start, target, callback, session } = await signIn('apple', {
    claims: { sub: 'a1', email: 'relay@privaterelay.appleid.com', email_verified: 'true' },
    form: { user: JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' } }) },
  });
  assert.equal(target.searchParams.get('response_mode'), 'form_post');
  assert.equal(target.searchParams.get('scope'), 'name email');
  assert.match(start.headers.getSetCookie()[0]!, /SameSite=None/);
  assert.equal(callback.status, 303);
  assert.ok(session);

  const secret = requests[0]!.body.get('client_secret')!;
  const [h, p, s] = secret.split('.') as [string, string, string];
  const header = JSON.parse(new TextDecoder().decode(fromBase64url(h)));
  const payload = JSON.parse(new TextDecoder().decode(fromBase64url(p)));
  assert.deepEqual(header, { alg: 'ES256', kid: 'KEY1234567' });
  assert.equal(payload.iss, 'TEAM123456');
  assert.equal(payload.sub, 'com.example.services');
  assert.equal(payload.aud, 'https://appleid.apple.com');
  assert.ok(payload.exp > payload.iat && payload.exp - payload.iat <= 600);
  const publicKey = await crypto.subtle.importKey('spki', KEYS.publicKey.export({ type: 'spki', format: 'der' }), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, fromBase64url(s), new TextEncoder().encode(`${h}.${p}`)));

  const me = (await (await call('/api/auth/me', { headers: { cookie: `__Host-session=${session}` } })).json()) as any;
  assert.equal(me.user.name, 'Ada Lovelace');
  assert.equal(me.user.email, 'relay@privaterelay.appleid.com');

  // Only Apple accepts a POST callback.
  assert.equal((await call('/api/auth/callback/google', { method: 'POST', body: '' })).status, 404);
});

test('return paths stay on this site', () => {
  assert.equal(safeReturnPath('/docs?id=1'), '/docs?id=1');
  for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)', '', null, undefined, '/a\r\nset-cookie: x=1']) {
    assert.equal(safeReturnPath(bad), '/', String(bad));
  }
});

test('DEV_USER works only when set and no session exists', async () => {
  const request = new Request(ORIGIN + '/api/documents');
  assert.equal(await authenticate(request, env, new URL(request.url)), null);
  env.DEV_USER = 'me@localhost';
  assert.ok(await authenticate(request, env, new URL(request.url)));
});

test('DEV_USER: signing out sticks until signing in with the dev provider', async () => {
  env.DEV_USER = 'me@localhost';
  const providers = (await (await call('/api/auth/providers')).json()) as { id: string }[];
  assert.ok(providers.some((p) => p.id === 'dev'));

  const out = await call('/api/auth/logout', { method: 'POST', headers: { origin: ORIGIN } });
  const jar = cookiesFrom(out);
  assert.equal(jar.get('__Host-dev_signed_out'), '1');
  const signedOut = new Request(ORIGIN + '/api/documents', { headers: { cookie: cookieHeader(jar) } });
  assert.equal(await authenticate(signedOut, env, new URL(signedOut.url)), null);

  const back = await call('/api/auth/start/dev?return=/docs', { headers: { cookie: cookieHeader(jar) } });
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), '/docs');
  assert.equal(cookiesFrom(back).get('__Host-dev_signed_out'), '');

  delete env.DEV_USER;
  assert.equal((await call('/api/auth/start/dev')).status, 404);
  const none = (await (await call('/api/auth/providers')).json()) as { id: string }[];
  assert.ok(!none.some((p) => p.id === 'dev'));
});
