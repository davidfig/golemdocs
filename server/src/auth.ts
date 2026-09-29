import type { Env } from './cf.ts';
import { sessionUser } from './session.ts';

/** The signed-in user's id (from the session cookie), or null. */
export async function authenticate(request: Request, env: Env, url: URL): Promise<string | null> {
  const user = await sessionUser(env, request, url);
  if (user) return user;
  // Local development shortcut: DEV_USER (from .dev.vars) counts as signed in. Never set it in production.
  const dev = env.DEV_USER?.trim();
  return dev ? userIdFor(dev) : null;
}

/** A stable, opaque id for a development identity (real users get random ids, see accounts.ts). */
export async function userIdFor(identity: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity.trim().toLowerCase()));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
