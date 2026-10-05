// Keeps a document saved in this browser and its copy in the cloud in step. Signed in, every
// document is in the account: the browser copy is saved first (so nothing waits on the network)
// and uploaded soon after. Nothing is ever merged, and nothing is overwritten either: an upload
// of a copy that started from an older version than the cloud's becomes a separate
// "(conflicted copy)" document instead.

import { BATCH_MAX_BYTES, BATCH_MAX_DOCUMENTS, CloudError, MAX_DOCUMENT_BYTES, createChunked, createDocument, createDocuments, downloadDocument, saveChunked, saveDocument, uploadThumbnail, type ChunkSource, type CloudDocument } from './cloud.ts';
import { CHUNK_ALGO } from './storage/chunker.ts';
import type { Manifest } from './storage/chunker.ts';
import { getChunks, getSaved, getSavedManifest, getThumbnail, listSaved, markSynced, saveFromCloud, type SavedInfo } from './storage/local.ts';
import { t } from './i18n/index.ts';

export interface Uploaded {
  doc: CloudDocument;
  /** The cloud copy had changed elsewhere, so this was saved as a new "(conflicted copy)" document. */
  conflictCopy: boolean;
}

/** "Report.docx" → "Report (conflicted copy).docx"; a conflicted copy that conflicts again keeps that name rather than growing another. */
export function conflictCopyName(name: string): string {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  const mark = t('app.conflictedCopy', { stem: '', ext: '' });
  let base = stem;
  while (mark && base.endsWith(mark)) base = base.slice(0, -mark.length);
  return t('app.conflictedCopy', { stem: base, ext });
}

/** A document's copy in this browser, ready to send: whole or as chunks, what the cloud already has of it, and how to make a new cloud document of it. */
async function sendable(localId: string) {
  // A document this browser keeps as chunks goes as chunks, and only those the cloud does not have yet are sent; one kept whole goes whole.
  const chunked = await getSavedManifest(localId);
  const saved = chunked ? null : await getSaved(localId);
  const info = (chunked ?? saved)?.info;
  if (!info) throw new Error(t('app.noLongerSaved'));
  // The server would refuse it: say so here (a big text file that grew past the limit stays in this browser).
  if (info.size > MAX_DOCUMENT_BYTES) throw new CloudError(413, t('textEditor.tooBigToSync'));
  const bytes = saved ? new Uint8Array(saved.bytes) : null;
  const manifest: Manifest | null = chunked && { algo: CHUNK_ALGO, size: chunked.manifest.size, chunks: chunked.manifest.hashes.map((h, i) => ({ h, n: chunked.manifest.lengths[i]! })) };
  const source: ChunkSource = async (hashes) => {
    const found = await getChunks(hashes);
    return hashes.map((hash) => {
      const chunk = found.get(hash);
      if (!chunk) throw new Error(t('app.noLongerSaved'));
      return { hash, bytes: chunk };
    });
  };
  /** What the cloud copy has of this one's chunks: those of the version uploaded or downloaded last. */
  const known = new Set(info.cloudId ? chunked?.manifest.syncedHashes : undefined);
  const make = (name: string, folderId?: string) => (manifest ? createChunked(name, manifest, source, folderId) : createDocument(name, bytes!, folderId));
  // A new cloud document goes in the folder it is in here. If the account doesn't have that folder
  // (it was made while signed out and hasn't been sent yet), it goes at the top level instead.
  const create = async (name: string) => {
    try {
      return await make(name, info.folderId);
    } catch (error) {
      if (info.folderId && error instanceof CloudError && error.status === 400) return make(name);
      throw error;
    }
  };
  return { info, bytes, manifest, source, known, create };
}

/** Uploads the saved browser copy to the cloud (creating the cloud document the first time). */
export async function uploadToCloud(localId: string, retry = true): Promise<Uploaded> {
  const { info, bytes, manifest, source, known, create } = await sendable(localId);
  let doc: CloudDocument;
  let conflictCopy = false;
  try {
    doc = info.cloudId ? await (manifest ? saveChunked(info.cloudId, manifest, source, known, info.name, info.cloudUpdatedAt) : saveDocument(info.cloudId, bytes!, info.name, info.cloudUpdatedAt)) : await create(info.name);
  } catch (error) {
    if (!info.cloudId || !(error instanceof CloudError)) throw error;
    if (error.status === 404) {
      // The cloud copy was deleted elsewhere: start a new one.
      doc = await create(info.name);
    } else if (error.status === 409 && retry && (await getSaved(localId))?.info.cloudUpdatedAt !== info.cloudUpdatedAt) {
      // Another tab uploaded this copy meanwhile, so the cloud moved on from here: go again from there.
      return uploadToCloud(localId, false);
    } else if (error.status === 409) {
      // Changed elsewhere too: keep both. This copy carries on as the conflicted one.
      doc = await create(conflictCopyName(info.name));
      conflictCopy = true;
    } else {
      throw error;
    }
  }
  await markSynced(localId, { cloudId: doc.id, syncedAt: info.updatedAt, cloudUpdatedAt: doc.updatedAt, name: conflictCopy ? doc.name : undefined, ...(manifest && { syncedHashes: manifest.chunks.map((c) => c.h) }) });
  // The thumbnail goes with the document, so other computers can show it without downloading the
  // document. Not worth failing the save over; the next save sends another.
  const thumbnail = await getThumbnail(localId).catch(() => null);
  if (thumbnail && thumbnail.forUpdatedAt === info.updatedAt) {
    doc = await uploadThumbnail(doc.id, thumbnail.blob).catch(() => doc);
  }
  return { doc, conflictCopy };
}

/**
 * Keeps what this browser's copy has that the account doesn't as a new "(conflicted copy)" document in the account, and counts the copy
 * here as sent, so the account's version replaces it when it is next opened. For a document someone else is editing (this one only
 * watches it): what was changed here before is kept, but never sent over theirs. Null if there was nothing to keep.
 */
export async function keepAsConflictCopy(localId: string): Promise<CloudDocument | null> {
  const { info, create } = await sendable(localId);
  if (!info.cloudId || info.updatedAt <= (info.cloudSyncedAt ?? 0)) return null;
  const doc = await create(conflictCopyName(info.name));
  await markSynced(localId, { cloudId: info.cloudId, syncedAt: info.updatedAt, cloudUpdatedAt: info.cloudUpdatedAt });
  return doc;
}

/**
 * Uploads browser copies that have no cloud document yet in as few requests as possible (a ZIP's
 * worth of documents would otherwise make a request each, which the server can't keep up with).
 * Returns the cloud documents made, by browser copy id. Copies that were left out (they are
 * already in the cloud, the server refused them, or are gone) are for `uploadToCloud` to deal with.
 */
export async function uploadNewToCloud(localIds: readonly string[]): Promise<Map<string, CloudDocument>> {
  const made = new Map<string, CloudDocument>();
  let batch: { id: string; info: SavedInfo; bytes: Uint8Array }[] = [];
  let size = 0;
  const send = async () => {
    const sending = batch;
    batch = [];
    size = 0;
    if (!sending.length) return;
    let results: Awaited<ReturnType<typeof createDocuments>>;
    try {
      results = await createDocuments(sending.map(({ info, bytes }) => ({ name: info.name, bytes, folderId: info.folderId ?? null })));
    } catch (error) {
      // Refused as a whole: these are left for the ordinary upload, which finds out why, and the
      // next batch is still sent. Unreachable, or signed out, nothing more would go either.
      if (error instanceof TypeError || (error instanceof CloudError && error.status === 401)) throw error;
      return;
    }
    for (const [i, result] of results.entries()) {
      if ('error' in result) continue;
      const { id, info } = sending[i]!;
      await markSynced(id, { cloudId: result.id, syncedAt: info.updatedAt, cloudUpdatedAt: result.updatedAt });
      made.set(id, result);
    }
  };
  for (const id of localIds) {
    // One kept as chunks is not sent whole in a batch (the next save would send it all again as chunks): it goes the single way.
    if (await getSavedManifest(id)) continue;
    const saved = await getSaved(id);
    if (!saved || saved.info.cloudId) continue;
    const bytes = new Uint8Array(saved.bytes);
    // Bigger than a batch: sent on its own, the ordinary way (which says if it is too big).
    if (bytes.byteLength > BATCH_MAX_BYTES) continue;
    if (batch.length >= BATCH_MAX_DOCUMENTS || (batch.length && size + bytes.byteLength > BATCH_MAX_BYTES)) await send();
    batch.push({ id, info: saved.info, bytes });
    size += bytes.byteLength;
  }
  await send();
  return made;
}

/** Downloads started ahead of an open (the pointer is on the document), by id; each is good for a short while. */
const prefetched = new Map<string, { updatedAt?: number; bytes: Promise<ArrayBuffer>; at: number }>();
const PREFETCH_TTL_MS = 30_000;
const PREFETCH_MAX = 3;

/** Starts downloading a cloud document so that opening it a moment later has the bytes already. */
export function prefetchFromCloud(cloud: { id: string; updatedAt?: number }): void {
  const now = Date.now();
  const have = prefetched.get(cloud.id);
  if (have && have.updatedAt === cloud.updatedAt && now - have.at < PREFETCH_TTL_MS) return;
  const bytes = downloadDocument(cloud.id);
  bytes.catch(() => prefetched.delete(cloud.id)); // a failed one is not reused; opening asks again
  prefetched.delete(cloud.id);
  prefetched.set(cloud.id, { updatedAt: cloud.updatedAt, bytes, at: now });
  while (prefetched.size > PREFETCH_MAX) prefetched.delete(prefetched.keys().next().value!);
}

/** The prefetched download of this version of the document, if there is a fresh one (used once). */
function takePrefetched(cloud: { id: string; updatedAt?: number }): Promise<ArrayBuffer> | null {
  const have = prefetched.get(cloud.id);
  prefetched.delete(cloud.id);
  return have && have.updatedAt === cloud.updatedAt && Date.now() - have.at < PREFETCH_TTL_MS ? have.bytes : null;
}

export interface OpenedFromCloud {
  info: SavedInfo;
  bytes: ArrayBuffer;
  /** The browser copy has changes the cloud doesn't (not uploaded yet), so it was opened instead. */
  usedBrowserCopy: boolean;
}

/**
 * Makes the cloud document available as a browser copy, unless that would discard unsynced edits.
 * When the caller knows the cloud copy's `updatedAt` and it's the one the browser copy already
 * has, nothing is downloaded.
 */
export async function openFromCloud(cloud: { id: string; name: string; updatedAt?: number }, owner?: string): Promise<OpenedFromCloud> {
  // Copies made before documents were marked with their account count as this one's.
  const linked = (await listSaved()).find((d) => d.cloudId === cloud.id && (d.owner === undefined || d.owner === owner));
  if (linked && linked.updatedAt > (linked.cloudSyncedAt ?? 0)) {
    const saved = await getSaved(linked.id);
    if (saved) return { ...saved, usedBrowserCopy: true };
  }
  if (linked && cloud.updatedAt !== undefined && linked.cloudUpdatedAt === cloud.updatedAt) {
    const saved = await getSaved(linked.id);
    if (saved) return { ...saved, usedBrowserCopy: false };
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await (takePrefetched(cloud) ?? downloadDocument(cloud.id));
  } catch (error) {
    // Offline: the copy this browser has is better than nothing.
    const saved = linked && !(error instanceof CloudError) ? await getSaved(linked.id) : null;
    if (saved) return { ...saved, usedBrowserCopy: false };
    throw error;
  }
  const info = await saveFromCloud({ id: linked?.id, name: cloud.name, bytes, owner, cloudId: cloud.id, cloudUpdatedAt: cloud.updatedAt });
  return { info, bytes, usedBrowserCopy: false };
}
