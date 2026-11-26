// A document's word history: /api/documents/:id/words. One row per document and day in the owner's own database (so, for
// documents kept in the account), holding the document's word count at the end of that day as the people writing in it saw
// it. The client decides what a day is (the writer's own calendar) and how a day's progress is worked out (see
// client/src/wordHistory.ts); the server keeps the numbers, within limits. A shared document has one history, which every
// session that can edit it adds to, whoever owns it. An encrypted document has none here: how much someone writes, day by
// day, says something about a document the server is not meant to know about.
//
// /api/documents/:id/versions/:version/words counts a kept version, so the history can be filled in for the days before it
// was first kept (the browser asks for the last version of each such day).

import { WordDocument, ZipError, countText, documentWords, isPlainText, textSegments } from '@golemdocs/docx';
import type { Env } from './cf.ts';
import { readDocument } from './fileStore.ts';
import { HttpError, json } from './http.ts';
import { historyKey } from './keys.ts';
import { storedDocx } from './stored.ts';
import type { UserDb } from './userDb.ts';

/** A day, on the writer's calendar. */
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** Days sent at once (a device that was offline for a while, or filling in from versions). */
export const MAX_DAYS_PER_REQUEST = 120;
/** Days kept per document: ten years of writing every day. The oldest go first. */
export const MAX_DAYS_PER_DOCUMENT = 3660;
/** More words than any document has; anything above is a mistake. */
const MAX_WORDS = 100_000_000;
/** Days in one INSERT (five bound values each, of D1's 100). */
const ROWS_PER_STATEMENT = 20;
/** Versions bigger than this are not counted. */
const MAX_VERSION_BYTES = 6_000_000;

export interface WordCountRow {
  day: string;
  words: number;
  /** The count when the day's writing began here (the first count seen that day), when known. */
  start: number | null;
}

export interface WordCountInput {
  day: string;
  words: number;
  start: number | null;
  /**
   * The start was moved by the session that sends it, past words changed elsewhere (in another app, by an agent) between two
   * sessions of the same day, which were not written here: it replaces the day's start rather than giving way to it.
   */
  shifted?: boolean;
}

const count = (value: unknown): number | null => (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_WORDS ? (value as number) : null);

/** The days of a PUT body, checked. */
export function readDays(body: unknown): { days: WordCountInput[]; fill: boolean } {
  const o = body as { days?: unknown; fill?: unknown } | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.days)) throw new HttpError(400, 'expected { days: [{ day, words, start? }], fill? }');
  if (o.days.length > MAX_DAYS_PER_REQUEST) throw new HttpError(400, `at most ${MAX_DAYS_PER_REQUEST} days at a time`);
  const days: WordCountInput[] = [];
  for (const d of o.days as unknown[]) {
    const item = d as { day?: unknown; words?: unknown; start?: unknown; shifted?: unknown } | null;
    const words = count(item?.words);
    const start = item?.start === undefined || item?.start === null ? null : count(item.start);
    if (typeof item?.day !== 'string' || !DAY.test(item.day) || words === null || (item?.start != null && start === null)) throw new HttpError(400, 'expected { day: "yyyy-mm-dd", words, start? }');
    days.push({ day: item.day, words, start, ...(item.shifted === true && start !== null && { shifted: true }) });
  }
  return { days, fill: o.fill === true };
}

/** A document's rows, oldest first. */
export async function wordCountsOf(db: UserDb, docId: string): Promise<WordCountRow[]> {
  return db.all<WordCountRow>('SELECT day, words, start FROM word_counts WHERE doc_id = ? ORDER BY day', [docId]);
}

/**
 * Keeps days' counts. A day already kept takes the new count (it is the later one), and keeps the start it had: the start is
 * when the day's writing began, whichever device saw it first, unless the new one is `shifted` (moved past words changed
 * elsewhere), which takes its place. With `fill` (counts of past versions) a day already kept is left alone: a count from a
 * version is never better than one seen while writing.
 */
export async function keepWordCounts(db: UserDb, docId: string, days: readonly WordCountInput[], fill: boolean, now = Date.now()): Promise<void> {
  if (!days.length) return;
  const keepStart = 'DO UPDATE SET words = excluded.words, start = COALESCE(word_counts.start, excluded.start), updated_at = excluded.updated_at';
  const newStart = 'DO UPDATE SET words = excluded.words, start = excluded.start, updated_at = excluded.updated_at';
  const groups: [readonly WordCountInput[], string][] = fill
    ? [[days, 'DO NOTHING']]
    : [
        [days.filter((d) => !d.shifted), keepStart],
        [days.filter((d) => d.shifted), newStart],
      ];
  // D1 allows 100 bound values in a statement, and each day takes five. `all`, not `run` or `runAll`: those drop the cached
  // document lists, which a word count has no business doing.
  for (const [group, conflict] of groups) {
    for (let i = 0; i < group.length; i += ROWS_PER_STATEMENT) {
      const chunk = group.slice(i, i + ROWS_PER_STATEMENT);
      await db.all(
        `INSERT INTO word_counts (doc_id, day, words, start, updated_at) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')} ON CONFLICT(doc_id, day) ${conflict}`,
        chunk.flatMap((d) => [docId, d.day, d.words, d.start, now]),
      );
    }
  }
  // Bounded: past the limit, the oldest days are forgotten.
  await db.all('DELETE FROM word_counts WHERE doc_id = ? AND day IN (SELECT day FROM word_counts WHERE doc_id = ? ORDER BY day DESC LIMIT -1 OFFSET ?)', [docId, docId, MAX_DAYS_PER_DOCUMENT]);
}

/** Forgets the histories of documents deleted for good. */
export async function deleteWordCounts(db: UserDb, docIds: readonly string[]): Promise<void> {
  for (let i = 0; i < docIds.length; i += 90) {
    const chunk = docIds.slice(i, i + 90);
    await db.run(`DELETE FROM word_counts WHERE doc_id IN (${chunk.map(() => '?').join(',')})`, chunk);
  }
}

/**
 * GET answers { days: [{ day, words, start }] }, oldest first, for anyone who can open the document. PUT { days: [{ day, words,
 * start?, shifted? }], fill? } keeps
 * them, for anyone who can edit it (`canWrite`) while its owner has sync (`requireStorage` throws otherwise).
 */
export async function handleWordCounts(request: Request, db: UserDb, docId: string, encrypted: boolean, canWrite: boolean, requireStorage: () => void): Promise<Response> {
  if (encrypted) throw new HttpError(409, 'an encrypted document keeps its word history on the device', 'encrypted');
  if (request.method === 'GET') return json({ days: await wordCountsOf(db, docId) });
  if (request.method !== 'PUT') throw new HttpError(405, 'method not allowed');
  if (!canWrite) throw new HttpError(403, 'this document is read-only for you');
  requireStorage();
  const { days, fill } = readDays(await request.json().catch(() => null));
  await keepWordCounts(db, docId, days, fill);
  return json({ ok: true });
}

/** The words of a stored file (a .docx, the app's .wdoc or a plain text file), or null when it has no text the server can read. */
export async function wordsOfStored(bytes: Uint8Array): Promise<number | null> {
  if (isPlainText(bytes)) return countText(textSegments(bytes, Infinity).map((s) => s.text)).words;
  const docx = await storedDocx(bytes);
  if (!docx) return null;
  try {
    return documentWords(await WordDocument.read(docx));
  } catch (error) {
    // A PDF, a picture or a drawing: no words to count.
    if (error instanceof ZipError) return null;
    throw error;
  }
}

/** GET /api/documents/:id/versions/:version/words: { words } of a kept version (null: it has no text the server can read). */
export async function versionWords(env: Env, ownerId: string, docId: string, version: number, encrypted: boolean): Promise<Response> {
  if (encrypted) throw new HttpError(409, 'an encrypted document keeps its word history on the device', 'encrypted');
  const bytes = await readDocument(env, historyKey(ownerId, docId, version), ownerId, docId, MAX_VERSION_BYTES);
  if (!bytes) throw new HttpError(404, 'version file is missing');
  if (bytes === 'too-large') return json({ words: null });
  try {
    return json({ words: await wordsOfStored(bytes) });
  } catch (error) {
    console.error('counting a version failed', error);
    return json({ words: null });
  }
}
