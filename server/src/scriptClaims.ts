// Scheduled script runs, handed out once across a person's devices: /api/script-claims (docs/live-blocks.md §8, *Triggers*).
// A run's id is the script's path and when it is due (`Scripts/daily-note.ts@2026-11-11T06:00`). A device claims it before
// running it; the first claim wins and every other device skips it. A claim not marked done within CLAIM_MS is released,
// so a device that went to sleep mid-run doesn't lose the run. Stored in the person's own database; the server never sees
// the script, only the ids.

import { HttpError, json } from './http.ts';
import type { UserDb } from './userDb.ts';

/** A claim not marked done in this long is given to the next device that asks. */
export const CLAIM_MS = 15 * 60_000;
/** Claims are forgotten after this long (a run is due once; a month covers any device catching up). */
export const KEEP_MS = 35 * 86_400_000;
const MAX_ID = 600;

interface ClaimRow {
  device: string;
  claimed_at: number;
  done_at: number | null;
}

/**
 * POST /api/script-claims { run, device, done? }: claims a run for a device, answering { claimed } (true when this device
 * should run it now), or with `done: true` marks the device's claim done. Without the person's own database (no sync) there
 * is no one to share runs with: every claim is granted.
 */
export async function handleScriptClaims(request: Request, db: UserDb | null): Promise<Response> {
  if (request.method !== 'POST') throw new HttpError(405, 'method not allowed');
  const body = (await request.json().catch(() => null)) as { run?: unknown; device?: unknown; done?: unknown } | null;
  const run = body?.run;
  const device = body?.device;
  if (typeof run !== 'string' || !run || run.length > MAX_ID || typeof device !== 'string' || !device || device.length > 100) throw new HttpError(400, 'expected { run, device }');
  if (!db) return json({ claimed: true });
  const now = Date.now();
  if (body?.done === true) {
    await db.all('UPDATE script_claims SET done_at = ? WHERE run_id = ? AND device = ?', [now, run, device]);
    return json({ ok: true });
  }
  // Added only if absent; a stale claim (not done in time) is taken over. `all`, not `run`: this changes no documents.
  await db.all(
    `INSERT INTO script_claims (run_id, device, claimed_at) VALUES (?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET device = excluded.device, claimed_at = excluded.claimed_at
     WHERE script_claims.done_at IS NULL AND script_claims.claimed_at < ?`,
    [run, device, now, now - CLAIM_MS],
  );
  const row = await db.first<ClaimRow>('SELECT device, claimed_at, done_at FROM script_claims WHERE run_id = ?', [run]);
  await db.all('DELETE FROM script_claims WHERE claimed_at < ?', [now - KEEP_MS]);
  return json({ claimed: !!row && row.device === device && row.claimed_at === now && row.done_at === null });
}
