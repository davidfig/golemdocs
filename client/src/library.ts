// Keeps a document saved in this browser and its copy in the cloud in step. The browser copy is
// the working copy: saving always goes there first, and the cloud is an explicit, opt-in extra
// that needs an account. Sync is manual and last-write-wins; nothing is ever merged.

import { CloudError, createDocument, downloadDocument, saveDocument, uploadThumbnail, type CloudDocument } from './cloud.ts';
import { getSaved, getThumbnail, listSaved, markSynced, saveFromCloud, type SavedInfo } from './storage/local.ts';

/** Uploads the saved browser copy to the cloud (creating the cloud document the first time). */
export async function uploadToCloud(localId: string): Promise<CloudDocument> {
  const saved = await getSaved(localId);
  if (!saved) throw new Error('The document is no longer saved in this browser');
  const bytes = new Uint8Array(saved.bytes);
  let doc: CloudDocument;
  try {
    doc = saved.info.cloudId ? await saveDocument(saved.info.cloudId, bytes, saved.info.name) : await createDocument(saved.info.name, bytes);
  } catch (error) {
    // The cloud copy was deleted elsewhere: start a new one.
    if (saved.info.cloudId && error instanceof CloudError && error.status === 404) doc = await createDocument(saved.info.name, bytes);
    else throw error;
  }
  await markSynced(localId, doc.id, doc.updatedAt);
  // The thumbnail goes with the document, so other computers can show it without downloading the
  // document. Not worth failing the save over; the next save sends another.
  const thumbnail = await getThumbnail(localId).catch(() => null);
  if (thumbnail && thumbnail.forUpdatedAt === saved.info.updatedAt) {
    doc = await uploadThumbnail(doc.id, thumbnail.blob).catch(() => doc);
  }
  return doc;
}

export interface OpenedFromCloud {
  info: SavedInfo;
  bytes: ArrayBuffer;
  /** The browser copy has changes the cloud doesn't, so it was opened instead (nothing is overwritten). */
  usedBrowserCopy: boolean;
}

/**
 * Makes the cloud document available as a browser copy, unless that would discard unsynced edits.
 * When the caller knows the cloud copy's `updatedAt` and it's the one the browser copy already
 * has, nothing is downloaded.
 */
export async function openFromCloud(cloud: { id: string; name: string; updatedAt?: number }): Promise<OpenedFromCloud> {
  const linked = (await listSaved()).find((d) => d.cloudId === cloud.id);
  if (linked && linked.updatedAt > (linked.cloudSyncedAt ?? 0)) {
    const saved = await getSaved(linked.id);
    if (saved) return { ...saved, usedBrowserCopy: true };
  }
  if (linked && cloud.updatedAt !== undefined && linked.cloudUpdatedAt === cloud.updatedAt) {
    const saved = await getSaved(linked.id);
    if (saved) return { ...saved, usedBrowserCopy: false };
  }
  const bytes = await downloadDocument(cloud.id);
  const info = await saveFromCloud({ id: linked?.id, name: cloud.name, bytes, cloudId: cloud.id, cloudUpdatedAt: cloud.updatedAt });
  return { info, bytes, usedBrowserCopy: false };
}
