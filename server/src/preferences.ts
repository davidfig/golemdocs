// The user's interface settings: /api/preferences. Stored in their own database (so, for people with
// sync), one row per setting and profile. The client decides which settings these are and what they
// mean; the server keeps names and strings, within limits.

import { HttpError, json } from './http.ts';
import { subscriptionRequired } from './subscriptions.ts';
import type { UserDb } from './userDb.ts';

/** A phone's settings are kept apart from a computer's: the screens are nothing alike. */
export const PROFILES: readonly string[] = ['desktop', 'mobile'];
const KEY = /^[A-Za-z0-9._-]{1,64}$/;
/** The longest value (the personal dictionary is the largest). */
export const MAX_VALUE_CHARS = 200_000;
/** D1 allows 100 bound values in a statement, and each setting takes four. */
export const MAX_PER_REQUEST = 20;
export const MAX_PER_PROFILE = 100;

interface PreferenceRow {
  key: string;
  value: string | null;
  updated_at: number;
}

function profileOf(value: unknown): string {
  if (typeof value !== 'string' || !PROFILES.includes(value)) throw new HttpError(400, `expected a profile: ${PROFILES.join(' or ')}`);
  return value;
}

/**
 * GET /api/preferences?profile=desktop answers { prefs: { [key]: { value, updatedAt } } } (a value of
 * null is a setting back at its default). PUT /api/preferences { profile, prefs: { [key]: string | null } }
 * sets the ones it names, for subscribers.
 */
export async function handlePreferences(request: Request, url: URL, db: UserDb | null, syncing: boolean): Promise<Response> {
  if (request.method === 'GET') {
    const profile = profileOf(url.searchParams.get('profile'));
    const rows = db ? await db.all<PreferenceRow>('SELECT key, value, updated_at FROM preferences WHERE profile = ?', [profile]) : [];
    return json({ prefs: Object.fromEntries(rows.map((r) => [r.key, { value: r.value, updatedAt: r.updated_at }])) });
  }
  if (request.method !== 'PUT') throw new HttpError(405, 'method not allowed');
  if (!db || !syncing) throw subscriptionRequired();

  const body = (await request.json().catch(() => null)) as { profile?: unknown; prefs?: unknown } | null;
  const profile = profileOf(body?.profile);
  const prefs = body?.prefs;
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) throw new HttpError(400, 'expected { profile, prefs: { key: value } }');
  const entries = Object.entries(prefs as Record<string, unknown>);
  if (entries.length > MAX_PER_REQUEST) throw new HttpError(400, `at most ${MAX_PER_REQUEST} settings at a time`);
  for (const [key, value] of entries) {
    if (!KEY.test(key)) throw new HttpError(400, 'bad setting name');
    if (value !== null && typeof value !== 'string') throw new HttpError(400, 'a setting is text, or null to reset it');
    if (typeof value === 'string' && value.length > MAX_VALUE_CHARS) throw new HttpError(413, 'a setting is too long');
  }
  if (!entries.length) return json({ ok: true, updatedAt: Date.now() });

  const have = new Set((await db.all<{ key: string }>('SELECT key FROM preferences WHERE profile = ?', [profile])).map((r) => r.key));
  if (have.size + entries.filter(([key]) => !have.has(key)).length > MAX_PER_PROFILE) throw new HttpError(413, 'too many settings');

  const now = Date.now();
  const marks = entries.map(() => '(?, ?, ?, ?)').join(', ');
  // `all`, not `run`: `run` drops the cached document lists, which a setting has no business doing.
  await db.all(
    `INSERT INTO preferences (profile, key, value, updated_at) VALUES ${marks} ON CONFLICT(profile, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    entries.flatMap(([key, value]) => [profile, key, value, now]),
  );
  return json({ ok: true, updatedAt: now });
}
