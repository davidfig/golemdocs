// The four sign-in providers. Google, Microsoft and Apple are OpenID Connect; GitHub is plain OAuth 2.
// All use the authorization-code flow, with PKCE where the provider honours it.

import type { Env } from './cf.ts';
import { jwtClaims, signJwtES256 } from './crypto.ts';

export type ProviderId = 'google' | 'microsoft' | 'github' | 'apple';

/** What a provider tells us about the person. Only a *verified* email may link accounts. */
export interface Profile {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export class AuthError extends Error {}

export interface AuthorizeParams {
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
}

export interface ExchangeParams {
  code: string;
  redirectUri: string;
  verifier: string;
  nonce: string;
  /** Extra fields the callback carried (Apple sends the name only in the form post, once). */
  form: URLSearchParams;
}

export interface Provider {
  id: ProviderId;
  name: string;
  /** The callback arrives as a cross-site POST (needs a SameSite=None flow cookie). */
  formPost: boolean;
  enabled(env: Env): boolean;
  authorizeUrl(env: Env, params: AuthorizeParams): URL;
  profile(env: Env, params: ExchangeParams): Promise<Profile>;
}

async function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !body || body.error) {
    throw new AuthError(`token request to ${new URL(url).host} failed (${response.status}): ${String(body?.error ?? '')}`);
  }
  return body;
}

/**
 * Checks an ID token's claims. The signature isn't verified: the token came straight from the
 * provider's token endpoint over TLS in exchange for our authorization code, which OpenID Connect
 * Core §3.1.3.7 permits. (Never use this for a token that arrived any other way.)
 */
function verifyIdToken(
  idToken: unknown,
  expect: { issuer: (iss: string) => boolean; audience: string; nonce: string },
): Record<string, unknown> {
  if (typeof idToken !== 'string') throw new AuthError('no id_token in response');
  const claims = jwtClaims(idToken);
  const audience = claims.aud;
  const aud = Array.isArray(audience) ? audience : [audience];
  if (typeof claims.iss !== 'string' || !expect.issuer(claims.iss)) throw new AuthError('bad issuer');
  if (!aud.includes(expect.audience)) throw new AuthError('bad audience');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now() - 60_000) throw new AuthError('id_token expired');
  if (claims.nonce !== expect.nonce) throw new AuthError('bad nonce');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new AuthError('no subject');
  return claims;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

function oidcAuthorize(base: string, clientId: string, scope: string, p: AuthorizeParams, extra: Record<string, string> = {}): URL {
  const url = new URL(base);
  const query: Record<string, string> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: p.redirectUri,
    scope,
    state: p.state,
    nonce: p.nonce,
    ...extra,
  };
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

function withPkce(url: URL, challenge: string): URL {
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url;
}

const google: Provider = {
  id: 'google',
  name: 'Google',
  formPost: false,
  enabled: (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  authorizeUrl: (env, p) =>
    withPkce(oidcAuthorize('https://accounts.google.com/o/oauth2/v2/auth', env.GOOGLE_CLIENT_ID!, 'openid email profile', p), p.challenge),
  async profile(env, p) {
    const tokens = await postForm('https://oauth2.googleapis.com/token', {
      grant_type: 'authorization_code',
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      code_verifier: p.verifier,
    });
    const claims = verifyIdToken(tokens.id_token, {
      issuer: (iss) => iss === 'https://accounts.google.com' || iss === 'accounts.google.com',
      audience: env.GOOGLE_CLIENT_ID!,
      nonce: p.nonce,
    });
    return { subject: claims.sub as string, email: text(claims.email), emailVerified: claims.email_verified === true, name: text(claims.name) };
  },
};

const microsoft: Provider = {
  id: 'microsoft',
  name: 'Microsoft',
  formPost: false,
  enabled: (env) => !!(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET),
  authorizeUrl: (env, p) =>
    withPkce(
      oidcAuthorize(`https://login.microsoftonline.com/${tenant(env)}/oauth2/v2.0/authorize`, env.MICROSOFT_CLIENT_ID!, 'openid email profile', p, {
        response_mode: 'query',
      }),
      p.challenge,
    ),
  async profile(env, p) {
    const tokens = await postForm(`https://login.microsoftonline.com/${tenant(env)}/oauth2/v2.0/token`, {
      grant_type: 'authorization_code',
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: env.MICROSOFT_CLIENT_ID!,
      client_secret: env.MICROSOFT_CLIENT_SECRET!,
      code_verifier: p.verifier,
      scope: 'openid email profile',
    });
    const claims = verifyIdToken(tokens.id_token, {
      // With a multi-tenant endpoint the issuer names the user's own tenant.
      issuer: (iss) => /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/i.test(iss),
      audience: env.MICROSOFT_CLIENT_ID!,
      nonce: p.nonce,
    });
    // Microsoft doesn't vouch that the email is verified, so it never links accounts.
    return { subject: claims.sub as string, email: text(claims.email) ?? text(claims.preferred_username), emailVerified: false, name: text(claims.name) };
  },
};

function tenant(env: Env): string {
  return env.MICROSOFT_TENANT || 'common';
}

const github: Provider = {
  id: 'github',
  name: 'GitHub',
  formPost: false,
  enabled: (env) => !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
  authorizeUrl(env, p) {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', env.GITHUB_CLIENT_ID!);
    url.searchParams.set('redirect_uri', p.redirectUri);
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', p.state);
    return withPkce(url, p.challenge);
  },
  async profile(env, p) {
    const tokens = await postForm('https://github.com/login/oauth/access_token', {
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: env.GITHUB_CLIENT_ID!,
      client_secret: env.GITHUB_CLIENT_SECRET!,
      code_verifier: p.verifier,
    });
    const token = text(tokens.access_token);
    if (!token) throw new AuthError('no access_token in response');
    const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'word-auth' };
    const userResponse = await fetch('https://api.github.com/user', { headers });
    if (!userResponse.ok) throw new AuthError(`github /user failed (${userResponse.status})`);
    const user = (await userResponse.json()) as { id?: number; login?: string; name?: string | null };
    if (typeof user.id !== 'number') throw new AuthError('no github user id');
    const emailsResponse = await fetch('https://api.github.com/user/emails', { headers });
    const emails = emailsResponse.ok ? ((await emailsResponse.json()) as { email: string; primary: boolean; verified: boolean }[]) : [];
    const primary = emails.find((e) => e.primary && e.verified);
    return { subject: String(user.id), email: primary?.email ?? null, emailVerified: !!primary, name: text(user.name) ?? text(user.login) };
  },
};

const APPLE_AUDIENCE = 'https://appleid.apple.com';

/** Apple's "client secret" is a short-lived ES256 JWT that we sign with the account's private key. */
function appleClientSecret(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwtES256(
    { alg: 'ES256', kid: env.APPLE_KEY_ID },
    { iss: env.APPLE_TEAM_ID, iat: now, exp: now + 300, aud: APPLE_AUDIENCE, sub: env.APPLE_CLIENT_ID },
    env.APPLE_PRIVATE_KEY!,
  );
}

const apple: Provider = {
  id: 'apple',
  name: 'Apple',
  formPost: true,
  enabled: (env) => !!(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY),
  authorizeUrl: (env, p) =>
    // Requesting name/email requires response_mode=form_post: Apple POSTs the result to the callback.
    oidcAuthorize('https://appleid.apple.com/auth/authorize', env.APPLE_CLIENT_ID!, 'name email', p, { response_mode: 'form_post' }),
  async profile(env, p) {
    const tokens = await postForm('https://appleid.apple.com/auth/token', {
      grant_type: 'authorization_code',
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: env.APPLE_CLIENT_ID!,
      client_secret: await appleClientSecret(env),
    });
    const claims = verifyIdToken(tokens.id_token, { issuer: (iss) => iss === APPLE_AUDIENCE, audience: env.APPLE_CLIENT_ID!, nonce: p.nonce });
    // The name is only ever sent once, in the form post's `user` field.
    let name: string | null = null;
    try {
      const user = JSON.parse(p.form.get('user') ?? 'null') as { name?: { firstName?: string; lastName?: string } } | null;
      name = [user?.name?.firstName, user?.name?.lastName].filter(Boolean).join(' ') || null;
    } catch {
      // ignore a malformed field
    }
    return {
      subject: claims.sub as string,
      email: text(claims.email),
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
      name,
    };
  },
};

export const PROVIDERS: Record<ProviderId, Provider> = { google, microsoft, github, apple };

export function providerFor(id: string): Provider | null {
  return Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id as ProviderId] : null;
}
