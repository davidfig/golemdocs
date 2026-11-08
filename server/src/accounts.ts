// Maps a provider identity (provider + subject) to one of our users.

import { userIdFor } from './auth.ts';
import type { Env } from './cf.ts';
import { randomToken } from './crypto.ts';
import type { Profile, ProviderId } from './providers.ts';

/**
 * The user for this sign-in, creating one if it's new.
 *
 * A first sign-in through a new provider joins an existing user only when both providers vouch for
 * the same *verified* email; matching on an unverified email would let anyone claim an account by
 * registering with its address at a lax provider.
 */
export async function userForProfile(env: Env, provider: ProviderId, profile: Profile): Promise<string> {
  const email = profile.email?.trim().toLowerCase() || null;
  const now = Date.now();
  const find = () =>
    env.DIRECTORY.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?').bind(provider, profile.subject).first<{ user_id: string }>();

  const existing = await find();
  if (existing) {
    await env.DIRECTORY.prepare(
      'UPDATE identities SET last_login_at = ?, name = COALESCE(?, name), picture = COALESCE(?, picture), email = COALESCE(?, email), email_verified = CASE WHEN ? IS NULL THEN email_verified ELSE ? END WHERE provider = ? AND subject = ?',
    )
      .bind(now, profile.name, profile.picture, email, email, profile.emailVerified ? 1 : 0, provider, profile.subject)
      .run();
    return existing.user_id;
  }

  const linked =
    email && profile.emailVerified
      ? await env.DIRECTORY.prepare('SELECT user_id FROM identities WHERE email = ? AND email_verified = 1 LIMIT 1').bind(email).first<{ user_id: string }>()
      : null;
  await env.DIRECTORY.prepare(
    'INSERT INTO identities (provider, subject, user_id, email, email_verified, name, picture, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, subject) DO NOTHING',
  )
    .bind(provider, profile.subject, linked?.user_id ?? randomToken(16), email, profile.emailVerified ? 1 : 0, profile.name, profile.picture, now, now)
    .run();
  // If a concurrent first sign-in won the insert, use its user.
  const row = await find();
  if (!row) throw new Error('failed to record identity');
  return row.user_id;
}

/** The comma-separated entries of a list setting, trimmed and lowercased. */
const entries = (value: string | undefined): string[] => (value ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

/**
 * Whether this sign-in may use the server. Anyone may unless `ALLOWED_EMAILS` is set (a self-hosted
 * server, say): then only a *verified* email it lists, either whole (`me@example.com`) or by domain
 * (`@example.com`), and the admins in `ADMIN_EMAILS`. Checked at every sign-in, so taking someone
 * off the list keeps them out from their next one (their sessions last until then; delete their rows
 * in `sessions` to end them now).
 */
export function mayUseServer(env: Env, profile: Profile): boolean {
  const allowed = entries(env.ALLOWED_EMAILS);
  if (!allowed.length) return true;
  const email = profile.email?.trim().toLowerCase();
  if (!email || !profile.emailVerified) return false;
  const domain = email.slice(email.lastIndexOf('@'));
  return allowed.includes(email) || allowed.includes(domain) || entries(env.ADMIN_EMAILS).includes(email);
}

export interface Me {
  id: string;
  email: string | null;
  name: string | null;
  /** Their profile picture (an https URL), if a provider gave one. */
  picture: string | null;
  isAdmin: boolean;
}

/** Whether the user has a verified email listed in ADMIN_EMAILS (or is the local DEV_USER listed there). */
export async function isAdmin(env: Env, userId: string): Promise<boolean> {
  const admins = entries(env.ADMIN_EMAILS);
  if (!admins.length) return false;
  const { results } = await env.DIRECTORY.prepare('SELECT email FROM identities WHERE user_id = ? AND email_verified = 1').bind(userId).all<{ email: string | null }>();
  if (results.some((r) => r.email && admins.includes(r.email.toLowerCase()))) return true;
  const dev = env.ENVIRONMENT === 'production' ? undefined : env.DEV_USER?.trim();
  return !!dev && admins.includes(dev.toLowerCase()) && (await userIdFor(dev)) === userId;
}

/** The most recent profile picture any of the user's sign-ins gave. */
export async function pictureOf(env: Env, userId: string): Promise<string | null> {
  const row = await env.DIRECTORY.prepare('SELECT picture FROM identities WHERE user_id = ? AND picture IS NOT NULL ORDER BY last_login_at DESC LIMIT 1')
    .bind(userId)
    .first<{ picture: string }>();
  return row?.picture ?? null;
}

export async function describeUser(env: Env, userId: string): Promise<Me> {
  const row = await env.DIRECTORY.prepare('SELECT email, name FROM identities WHERE user_id = ? ORDER BY last_login_at DESC LIMIT 1')
    .bind(userId)
    .first<{ email: string | null; name: string | null }>();
  return { id: userId, email: row?.email ?? null, name: row?.name ?? null, picture: await pictureOf(env, userId), isAdmin: await isAdmin(env, userId) };
}
