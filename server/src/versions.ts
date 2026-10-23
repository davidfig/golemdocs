// A document's history in the cloud: checkpoints of the file as it was before a save replaced it, and the trash a deleted document goes
// to for 30 days. Only people with sync save to the cloud, so history is a paid feature without any check of its own.
//
// A checkpoint is one more R2 object at `<owner>/<doc>.history/<version>` (`version` is the `updated_at` of the file it keeps) and a row
// in the owner's `versions` table. A document kept as chunks (fileStore.ts) is checkpointed as its manifest alone: the chunks it names are
// kept for as long as any manifest, live or checkpointed, names them, which is what `chunksInUse` works out. When to checkpoint and what
// to let go of is decided by the shared rules in `@golemdocs/ops` (versionPolicy.ts), the same ones the browser's own history uses.

import { CLOUD_LIMITS, byteBudget, shouldCheckpoint, versionsToDrop, type VersionStamp } from '@golemdocs/ops';
import type { Env } from './cf.ts';
import { deleteChunkList, isChunked, previousManifest, type Manifest } from './fileStore.ts';
import { docxKey, historyKey, historyPrefix } from './keys.ts';
import { perChunk } from './http.ts';
import { roomForHistory } from './storage.ts';
import type { UserDb } from './userDb.ts';

export interface VersionRow {
  doc_id: string;
  version: number;
  size: number;
  name: string | null;
  chunked: number;
}

/** What the client sees of one. */
export const describeVersion = (row: VersionRow) => ({ version: row.version, size: row.size, name: row.name });

export { TRASH_MS } from '@golemdocs/ops';

/** The catalogue row of the document a checkpoint is of (the fields this module needs). */
export interface Live {
  id: string;
  r2_key: string;
  size: number;
  updated_at: number;
}

/**
 * How many bytes a checkpoint counts as keeping, against its document's byte budget and the account's limit (storage.ts): a document
 * kept as chunks shares most of its bytes with its neighbours.
 */
export const storedSize = (row: Pick<VersionRow, 'size' | 'chunked'>): number => (row.chunked ? Math.ceil(row.size / 10) : row.size);

const stampOf = (row: VersionRow): VersionStamp => ({ at: row.version, size: storedSize(row), ...(row.name !== null ? { named: true } : {}) });

const manifestHashes = (manifest: Manifest): string[] => manifest.chunks.map((c) => c.h);

async function manifestAt(env: Env, key: string): Promise<Manifest | null> {
  return previousManifest(env, key).catch(() => null);
}

/** The hashes of every chunk a checkpoint of this document names, apart from `except` (versions about to go). */
export async function retainedChunks(env: Env, ownerId: string, db: UserDb, docId: string, except: ReadonlySet<number> = new Set()): Promise<Set<string>> {
  const rows = await db.all<VersionRow>('SELECT * FROM versions WHERE doc_id = ? AND chunked = 1', [docId]);
  const hashes = new Set<string>();
  for (const row of rows) {
    if (except.has(row.version)) continue;
    const manifest = await manifestAt(env, historyKey(ownerId, docId, row.version));
    if (manifest) for (const h of manifestHashes(manifest)) hashes.add(h);
  }
  return hashes;
}

/**
 * Chunks a save has stopped using, less those a checkpoint still names: what may be deleted. `dropped` is what the save's manifest
 * no longer has (from `applyDelta`).
 */
export async function chunksToDelete(env: Env, ownerId: string, db: UserDb, docId: string, dropped: readonly string[]): Promise<string[]> {
  if (!dropped.length) return [];
  const kept = await retainedChunks(env, ownerId, db, docId);
  return dropped.filter((h) => !kept.has(h));
}

/** The newest checkpoint's version, or null if there is none. */
async function lastVersion(db: UserDb, docId: string): Promise<number | null> {
  const row = await db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM versions WHERE doc_id = ?', [docId]);
  return row?.v ?? null;
}

export interface CheckpointOptions {
  /** The size of the file that is about to replace this one (the shrink rule). */
  nextSize?: number;
  /** The file's etag as the save saw it: a file that has changed since is not checkpointed under the wrong version. */
  etag?: string;
  /** Checkpoint whatever the gap says (the person asked). */
  force?: boolean;
  /** Keep it as a named version. */
  name?: string;
  now?: number;
}

/**
 * Keeps the file as it is now, if the rules say a save is due one (or `force`). Never fails a save: whatever goes wrong here is
 * logged and the save goes on. Returns whether the file is now checkpointed.
 */
export async function checkpoint(env: Env, ownerId: string, db: UserDb, live: Live, options: CheckpointOptions = {}): Promise<boolean> {
  try {
    const existing = await db.first<VersionRow>('SELECT * FROM versions WHERE doc_id = ? AND version = ?', [live.id, live.updated_at]);
    if (existing) {
      // This very version is kept already; a name asked for goes on it.
      if (options.name !== undefined && existing.name !== options.name) await db.run('UPDATE versions SET name = ? WHERE doc_id = ? AND version = ?', [options.name, live.id, live.updated_at]);
      return true;
    }
    const now = options.now ?? Date.now();
    const named = options.name !== undefined;
    if (!options.force && !named) {
      const due = shouldCheckpoint({ lastAt: await lastVersion(db, live.id), replacedAt: live.updated_at, replacedSize: live.size, nextSize: options.nextSize ?? live.size, now });
      if (!due) return false;
    }
    const object = await env.FILES.get(live.r2_key);
    if (!object) return false;
    if (options.etag !== undefined && object.etag !== options.etag) {
      await object.body.cancel().catch(() => {});
      return false;
    }
    const chunked = isChunked(object);
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    const size = chunked ? Number(object.customMetadata?.size ?? live.size) : bytes.byteLength;
    // History lives in the space documents leave in the account: older checkpoints make way, and none is taken when there is no space.
    if (!(await roomForHistory(env, ownerId, db, storedSize({ size, chunked: chunked ? 1 : 0 })))) return false;
    await env.FILES.put(historyKey(ownerId, live.id, live.updated_at), bytes, {
      httpMetadata: object.httpMetadata ?? {},
      ...(object.customMetadata ? { customMetadata: object.customMetadata } : {}),
    });
    await db.run('INSERT OR IGNORE INTO versions (doc_id, version, size, name, chunked) VALUES (?, ?, ?, ?, ?)', [live.id, live.updated_at, size, options.name ?? null, chunked ? 1 : 0]);
    return true;
  } catch (error) {
    console.error('checkpoint failed', error);
    return false;
  }
}

/** Lets go of the checkpoints the rules no longer keep (and chunks only they named). Run after a save, where it can wait for the response. */
export async function prune(env: Env, ownerId: string, db: UserDb, docId: string, liveSize: number, now = Date.now()): Promise<void> {
  try {
    const rows = await db.all<VersionRow>('SELECT * FROM versions WHERE doc_id = ?', [docId]);
    if (!rows.length) return;
    const doomed = new Set(versionsToDrop(rows.map(stampOf), now, { ...CLOUD_LIMITS, maxBytes: byteBudget(liveSize) }));
    if (!doomed.size) return;
    await removeVersions(env, ownerId, db, docId, rows.filter((r) => doomed.has(r.version)));
  } catch (error) {
    console.error('pruning history failed', error);
  }
}

/** Removes the given checkpoints: their rows, their objects, and chunks nothing else names. */
export async function removeVersions(env: Env, ownerId: string, db: UserDb, docId: string, rows: VersionRow[]): Promise<void> {
  if (!rows.length) return;
  const going = new Set(rows.map((r) => r.version));
  // Which chunks they alone name: read their manifests before anything is deleted.
  const candidates = new Set<string>();
  for (const row of rows) {
    if (!row.chunked) continue;
    const manifest = await manifestAt(env, historyKey(ownerId, docId, row.version));
    if (manifest) for (const h of manifestHashes(manifest)) candidates.add(h);
  }
  await db.runAll(rows.map((r) => ({ sql: 'DELETE FROM versions WHERE doc_id = ? AND version = ?', params: [docId, r.version] })));
  const keys = rows.map((r) => historyKey(ownerId, docId, r.version));
  for (let i = 0; i < keys.length; i += 1000) await env.FILES.delete(keys.slice(i, i + 1000));
  if (candidates.size) {
    const kept = await retainedChunks(env, ownerId, db, docId, going);
    const live = await manifestAt(env, docxKey(ownerId, docId));
    if (live) for (const h of manifestHashes(live)) kept.add(h);
    await deleteChunkList(env, ownerId, docId, [...candidates].filter((h) => !kept.has(h)));
  }
}

export async function versionsOf(db: UserDb, docId: string): Promise<VersionRow[]> {
  return db.all<VersionRow>('SELECT * FROM versions WHERE doc_id = ? ORDER BY version DESC', [docId]);
}

/** Deletes everything history kept for the documents: used when they are deleted for good. */
export async function deleteHistory(env: Env, ownerId: string, db: UserDb, docIds: string[]): Promise<void> {
  for (const docId of docIds) {
    let cursor: string | undefined;
    do {
      const listing = await env.FILES.list({ prefix: historyPrefix(ownerId, docId), ...(cursor ? { cursor } : {}) });
      const keys = listing.objects.map((o) => o.key);
      for (let i = 0; i < keys.length; i += 1000) await env.FILES.delete(keys.slice(i, i + 1000));
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
  }
  await db.runAll(perChunk(docIds, (marks) => `DELETE FROM versions WHERE doc_id IN (${marks})`));
}
