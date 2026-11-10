// Where the person is in each book they read: /api/reading. Stored in their own database (so, for people with sync),
// one row per book, keyed by the hash of the book's text so the same book finds its place on every device. The client decides
// what a place is (see client/src/reading.ts); the server keeps it as text, within limits, and keeps the latest reading.

import { HttpError, json } from './http.ts';
import { subscriptionRequired } from './subscriptions.ts';
import type { UserDb } from './userDb.ts';

/** A book's key: the hex SHA-256 of its text. */
const BOOK = /^[0-9a-f]{64}$/;
/** A place is a few numbers; this is generous. */
export const MAX_PLACE_CHARS = 1000;
/** Books kept per person; the ones read longest ago go first. */
export const MAX_BOOKS = 2000;

interface PlaceRow {
  place: string;
  read_at: number;
}

function bookOf(value: unknown): string {
  if (typeof value !== 'string' || !BOOK.test(value)) throw new HttpError(400, 'expected a book: its SHA-256, in hex');
  return value;
}

/**
 * GET /api/reading?book=<hash> answers { place, readAt, now } (place and readAt null for a book never read). PUT
 * /api/reading { book, place, age } keeps the place, read `age` ms ago, when that is later than the one kept, for
 * subscribers, and answers the same as GET. Times are the server's clock: a device says how long ago it read rather
 * than when, and reads `readAt` against `now`, so a device whose clock is off still compares readings rightly.
 */
export async function handleReading(request: Request, url: URL, db: UserDb | null, syncing: boolean): Promise<Response> {
  if (request.method === 'GET') {
    const book = bookOf(url.searchParams.get('book'));
    const row = db ? await db.first<PlaceRow>('SELECT place, read_at FROM reading_places WHERE book = ?', [book]) : null;
    return json({ place: row?.place ?? null, readAt: row?.read_at ?? null, now: Date.now() });
  }
  if (request.method !== 'PUT') throw new HttpError(405, 'method not allowed');
  if (!db || !syncing) throw subscriptionRequired();

  const body = (await request.json().catch(() => null)) as { book?: unknown; place?: unknown; age?: unknown } | null;
  const book = bookOf(body?.book);
  const place = body?.place;
  if (typeof place !== 'string' || !place) throw new HttpError(400, 'expected { book, place, age }');
  if (place.length > MAX_PLACE_CHARS) throw new HttpError(413, 'a place is too long');
  const now = Date.now();
  // Never in the future; and a place read so long ago that it would go before 1970 is read now.
  const age = typeof body?.age === 'number' && Number.isFinite(body.age) ? Math.max(0, Math.floor(body.age)) : 0;
  const readAt = age < now ? now - age : now;

  const known = await db.first<{ one: number }>('SELECT 1 AS one FROM reading_places WHERE book = ?', [book]);
  // `all`, not `run`: `run` drops the cached document lists, which a reading place has no business doing.
  await db.all(
    'INSERT INTO reading_places (book, place, read_at) VALUES (?, ?, ?) ON CONFLICT(book) DO UPDATE SET place = excluded.place, read_at = excluded.read_at WHERE excluded.read_at > reading_places.read_at',
    [book, place, readAt],
  );
  // Bounded: past the limit, the books read longest ago are forgotten. (Only a new book can take it past.)
  if (!known) await db.all('DELETE FROM reading_places WHERE book IN (SELECT book FROM reading_places ORDER BY read_at DESC LIMIT -1 OFFSET ?)', [MAX_BOOKS]);
  const row = await db.first<PlaceRow>('SELECT place, read_at FROM reading_places WHERE book = ?', [book]);
  return json({ place: row?.place ?? place, readAt: row?.read_at ?? readAt, now: Date.now() });
}
