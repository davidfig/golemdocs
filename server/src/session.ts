// Server-side sessions: the cookie holds a random token; D1 holds only its hash, so a database
// leak can't be replayed and a session can be revoked by deleting its row.

import type { Env } from './cf.ts';
import { randomToken, sha256Hex } from './crypto.ts';

/** How long a session lasts without being used. Using it starts this over (`sessionUser`). */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** A session is extended at most this often, so that using the app costs one write a day and not one per request. */
export const SESSION_RENEW_MS = 24 * 60 * 60 * 1000;

/** The cookie to send back with the answer to a request whose session was just extended. */
const renewals = new WeakMap<Request, string>();

const isSecure = (url: URL) => url.protocol === 'https:';

/** `__Host-` pins a cookie to this exact host over HTTPS; plain http (local dev) can't use it. */
export function cookieName(url: URL, base: string): string {
  return isSecure(url) ? `__Host-${base}` : base;
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function setCookie(url: URL, base: string, value: string, options: { maxAgeSeconds: number; crossSite?: boolean }): string {
  // SameSite=None (needed for Apple's cross-site form post) is only allowed on secure cookies.
  const sameSite = options.crossSite && isSecure(url) ? 'None' : 'Lax';
  return [`${cookieName(url, base)}=${value}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`, `Max-Age=${options.maxAgeSeconds}`, ...(isSecure(url) ? ['Secure'] : [])].join('; ');
}

export function clearCookie(url: URL, base: string, crossSite = false): string {
  return setCookie(url, base, '', { maxAgeSeconds: 0, crossSite });
}

/** Starts a session; returns the Set-Cookie header value. */
export async function createSession(env: Env, url: URL, userId: string): Promise<string> {
  const token = randomToken(32);
  const now = Date.now();
  await env.DIRECTORY.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  await env.DIRECTORY.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, now, now + SESSION_TTL_MS)
    .run();
  return setCookie(url, 'session', token, { maxAgeSeconds: SESSION_TTL_MS / 1000 });
}

export async function sessionUser(env: Env, request: Request, url: URL): Promise<string | null> {
  const token = readCookie(request, cookieName(url, 'session'));
  if (!token) return null;
  const hash = await sha256Hex(token);
  const now = Date.now();
  const row = await env.DIRECTORY.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(hash, now)
    .first<{ user_id: string; expires_at: number }>();
  if (!row) return null;
  if (row.expires_at - now < SESSION_TTL_MS - SESSION_RENEW_MS) {
    // Failing to extend a session that is still good must not fail the request: the next one tries again.
    try {
      await env.DIRECTORY.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(now + SESSION_TTL_MS, hash).run();
      renewals.set(request, setCookie(url, 'session', token, { maxAgeSeconds: SESSION_TTL_MS / 1000 }));
    } catch (error) {
      console.error('could not extend a session:', error);
    }
  }
  return row.user_id;
}

/** Sends the extended session's cookie with the answer, if `sessionUser` extended it during this request. */
export function withRenewedSession(request: Request, response: Response): Response {
  const cookie = renewals.get(request);
  // A WebSocket handshake can't be copied. The cookie's token stays the same, so the next request brings it up to date.
  if (!cookie || response.status === 101) return response;
  const renewed = new Response(response.body, response); // a Durable Object's or R2's headers can't be changed in place
  renewed.headers.append('set-cookie', cookie);
  return renewed;
}

export async function destroySession(env: Env, request: Request, url: URL): Promise<void> {
  const token = readCookie(request, cookieName(url, 'session'));
  if (token) await env.DIRECTORY.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}
