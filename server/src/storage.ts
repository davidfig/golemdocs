// The account storage limit (`ACCOUNT_STORAGE_BYTES`). It holds everything an owner keeps: documents, the trash, and history. Documents,
// the trash and versions the person named count against it, and are refused once they would go past it. Automatic history fills
// whatever space they leave: when something needs room, the oldest automatic versions in the account go first, so the account never
// keeps more than the limit and history never stops a save.
//
// Checked before anything adds to an account through the API (a new document, a batch, a restored version, a named version, a save
// that makes a document bigger); a save that keeps a document's size or shrinks it always goes in, so a full account can still be
// edited down. A shared room's saves are never refused, since the people in it would lose their edits; they still make room in the
// history, as every checkpoint does (`roomForHistory`).

import { ACCOUNT_STORAGE_BYTES, TRASH_MS } from '@golemdocs/ops';
import type { Env } from './cf.ts';
import { HttpError } from './http.ts';
import type { UserDb } from './userDb.ts';
import { removeVersions, storedSize, type VersionRow } from './versions.ts';

export interface Usage {
  /** Documents, the trash not yet old enough to be purged, and named versions: what the limit refuses. */
  counted: number;
  /** Automatic versions: what gives way when room is needed. */
  history: number;
}

/** A version's bytes in SQL, as `storedSize` counts them. */
const STORED = 'CASE WHEN chunked = 1 THEN (size + 9) / 10 ELSE size END';

/** How many bytes the owner of `db` keeps, in one query. */
export async function storageUsage(db: UserDb, now = Date.now()): Promise<Usage> {
  const row = await db.first<{ counted: number | null; history: number | null }>(
    `SELECT (SELECT COALESCE(SUM(size), 0) FROM documents)
          + (SELECT COALESCE(SUM(size), 0) FROM trash WHERE deleted_at > ?)
          + (SELECT COALESCE(SUM(${STORED}), 0) FROM versions WHERE name IS NOT NULL) AS counted,
            (SELECT COALESCE(SUM(${STORED}), 0) FROM versions WHERE name IS NULL) AS history`,
    [now - TRASH_MS],
  );
  return { counted: row?.counted ?? 0, history: row?.history ?? 0 };
}

export interface RoomOptions {
  /** Whether the account is the caller's own: someone editing a document shared with them is told it is the owner's that is full. */
  own?: boolean;
  /** The bytes are kept already, as automatic history (a version being named): they only move to what counts. */
  alreadyStored?: boolean;
}

/**
 * Refuses (507) a change that would add `adding` bytes to what counts in the account of `db` and take it past the limit; otherwise lets
 * go of as much automatic history as it takes for the change to fit.
 */
export async function requireRoom(env: Env, ownerId: string, db: UserDb, adding: number, options: RoomOptions = {}): Promise<void> {
  if (adding <= 0) return;
  const usage = await storageUsage(db);
  if (usage.counted + adding > ACCOUNT_STORAGE_BYTES) {
    throw options.own === false ? new HttpError(507, "the owner's account is full", 'owner-storage-full') : new HttpError(507, 'your account is full', 'storage-full');
  }
  if (!options.alreadyStored) await freeHistory(env, ownerId, db, usage.counted + usage.history + adding - ACCOUNT_STORAGE_BYTES);
}

/**
 * Makes room for a checkpoint that keeps `bytes`, by letting go of older automatic history if the account needs it. False if it cannot
 * fit even then (documents fill the account): the checkpoint is not taken.
 */
export async function roomForHistory(env: Env, ownerId: string, db: UserDb, bytes: number): Promise<boolean> {
  const usage = await storageUsage(db);
  if (usage.counted + bytes > ACCOUNT_STORAGE_BYTES) return false;
  return freeHistory(env, ownerId, db, usage.counted + usage.history + bytes - ACCOUNT_STORAGE_BYTES);
}

/** How many of the oldest automatic versions to look at in one go. */
const PAGE = 200;

/** Lets go of the account's oldest automatic versions, whatever document they are of, until `excess` bytes are free. Returns whether they are. */
async function freeHistory(env: Env, ownerId: string, db: UserDb, excess: number): Promise<boolean> {
  let freed = 0;
  while (freed < excess) {
    const rows = await db.all<VersionRow>(`SELECT * FROM versions WHERE name IS NULL ORDER BY version ASC LIMIT ${PAGE}`);
    if (!rows.length) return false;
    const going: VersionRow[] = [];
    for (const row of rows) {
      if (freed >= excess) break;
      going.push(row);
      freed += storedSize(row);
    }
    const byDoc = new Map<string, VersionRow[]>();
    for (const row of going) byDoc.set(row.doc_id, [...(byDoc.get(row.doc_id) ?? []), row]);
    for (const [docId, docRows] of byDoc) await removeVersions(env, ownerId, db, docId, docRows);
  }
  return true;
}

