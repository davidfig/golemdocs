// How far a person's devices have kept their live blocks up to date: /api/live-marker (docs/live-blocks.md §6, *Updates in
// the background*). Any of the person's devices, signed in anywhere, may update the documents that show a changed source.
// It looks for the sources changed since `worked_to` (documents' `updatedAt`, the server's clock), updates what shows them,
// and moves the marker on. Dependents too large for that device (a phone) are put in `deferred` for a larger one.
// Stored in the person's own database; without one (no sync) there is only this device and nothing to keep.

import { HttpError, json } from './http.ts';
import type { UserDb } from './userDb.ts';

/** Deferred documents kept at most (the oldest go first): enough for any vault's large documents. */
export const MAX_DEFERRED = 500;
const MAX_ID = 100;

interface MarkerRow {
  worked_to: number;
  deferred: string;
}

function ids(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_DEFERRED || !value.every((v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID)) throw new HttpError(400, 'expected a list of document ids');
  return value as string[];
}

function parsed(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

async function read(db: UserDb): Promise<{ workedTo: number | null; deferred: string[] }> {
  const row = await db.first<MarkerRow>('SELECT worked_to, deferred FROM live_marker WHERE id = 1', []);
  return row ? { workedTo: row.worked_to, deferred: parsed(row.deferred) } : { workedTo: null, deferred: [] };
}

/**
 * GET: { kept, workedTo, deferred, now }. `kept` is false without the person's own database (nothing to share).
 * POST { workedTo?, defer?, done? }: moves the marker on (never back), adds documents to `deferred` and takes the done ones
 * off; answers as GET does.
 */
export async function handleLiveMarker(request: Request, db: UserDb | null): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') throw new HttpError(405, 'method not allowed');
  const now = Date.now();
  if (!db) {
    if (request.method === 'POST') await request.body?.cancel();
    return json({ kept: false, workedTo: null, deferred: [], now });
  }
  if (request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as { workedTo?: unknown; defer?: unknown; done?: unknown } | null;
    if (!body || typeof body !== 'object') throw new HttpError(400, 'expected { workedTo?, defer?, done? }');
    const workedTo = body.workedTo;
    if (workedTo !== undefined && (typeof workedTo !== 'number' || !Number.isFinite(workedTo) || workedTo < 0)) throw new HttpError(400, 'workedTo must be a time');
    const defer = ids(body.defer);
    const done = new Set(ids(body.done));
    const old = await read(db);
    const deferred = [...new Set([...old.deferred, ...defer])].filter((id) => !done.has(id)).slice(-MAX_DEFERRED);
    // The marker only moves on: two devices working at once can't take it back. Never past now (a device's mistake).
    const next = Math.min(now, Math.max(old.workedTo ?? 0, typeof workedTo === 'number' ? workedTo : (old.workedTo ?? now)));
    // `all`, not `run`: this changes no documents.
    await db.all(
      `INSERT INTO live_marker (id, worked_to, deferred) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET worked_to = MAX(live_marker.worked_to, excluded.worked_to), deferred = excluded.deferred`,
      [next, JSON.stringify(deferred)],
    );
  }
  const marker = await read(db);
  return json({ kept: true, ...marker, now });
}
