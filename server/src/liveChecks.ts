// Live blocks out of date when opened (docs/live-blocks.md §6, the M1 log): each signed-in app sends how many documents with
// live blocks it opened and how many of those it had to update. Kept as totals for each day (UTC), with nothing about who sent
// them, and shown on Admin > Analytics. If documents are often out of date when opened, updating them on the server (M4) is
// worth building.

import type { Env } from './cf.ts';
import { HttpError } from './http.ts';

/**
 * The count is temporary: after this day no report is taken (the pricing page says so), and the code can go. The app stops
 * sending on the same day (client/src/live/checkLog.ts).
 */
export const LIVE_CHECKS_END = Date.UTC(2027, 3, 1);
/** Days older than this are deleted, so nothing piles up even if the code stays. */
const KEEP_DAYS = 120;
const DAY = 86_400_000;

/** The most one report may add, so a broken or hostile client can't make the numbers mean nothing. */
const MOST = 1000;

export interface LiveCheckDay {
  day: string;
  opened: number;
  stale: number;
}

/** Reads `{ opened, stale }` from a report's body. */
export function readLiveChecks(body: unknown): { opened: number; stale: number } {
  const { opened, stale } = (body ?? {}) as { opened?: unknown; stale?: unknown };
  const count = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= MOST;
  if (!count(opened) || !count(stale) || stale > opened) throw new HttpError(400, 'expected { opened, stale }: whole numbers, stale at most opened');
  return { opened, stale };
}

/** Adds a report to its day's totals; false when the count has ended. */
export async function addLiveChecks(env: Env, opened: number, stale: number, now = Date.now()): Promise<boolean> {
  if (now >= LIVE_CHECKS_END) return false;
  if (!opened) return true;
  const day = new Date(now).toISOString().slice(0, 10);
  await env.DIRECTORY.prepare('DELETE FROM live_checks WHERE day < ?').bind(new Date(now - KEEP_DAYS * DAY).toISOString().slice(0, 10)).run();
  await env.DIRECTORY.prepare('INSERT INTO live_checks (day, opened, stale) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET opened = opened + excluded.opened, stale = stale + excluded.stale')
    .bind(day, opened, stale)
    .run();
  return true;
}

/** The last 30 days that have any, newest first. */
export async function liveCheckDays(env: Env): Promise<LiveCheckDay[]> {
  const { results } = await env.DIRECTORY.prepare('SELECT day, opened, stale FROM live_checks ORDER BY day DESC LIMIT 30').all<LiveCheckDay>();
  return results;
}
