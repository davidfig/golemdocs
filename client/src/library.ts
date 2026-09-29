// Keeps a document saved in this browser and its copy in the cloud in step. The browser copy is
// the working copy: saving always goes there first, and the cloud is an explicit, opt-in extra
// that needs an account. Sync is manual and last-write-wins; nothing is ever merged.

import { CloudError, createDocument, downloadDocument, saveDocument, type CloudDocument } from './cloud.ts';
import { getSaved, listSaved, markSynced, saveFromCloud, type SavedInfo } from './storage/local.ts';

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
  await markSynced(localId, doc.id);
  return doc;
}

export interface OpenedFromCloud {
  info: SavedInfo;
  bytes: ArrayBuffer;
  /** The browser copy has changes the cloud doesn't, so it was opened instead (nothing is overwritten). */
  usedBrowserCopy: boolean;
}

/** Makes the cloud document available as a browser copy, unless that would discard unsynced edits. */
export async function openFromCloud(cloud: { id: string; name: string }): Promise<OpenedFromCloud> {
  const linked = (await listSaved()).find((d) => d.cloudId === cloud.id);
  if (linked && linked.updatedAt > (linked.cloudSyncedAt ?? 0)) {
    const saved = await getSaved(linked.id);
    if (saved) return { ...saved, usedBrowserCopy: true };
  }
  const bytes = await downloadDocument(cloud.id);
  const info = await saveFromCloud({ id: linked?.id, name: cloud.name, bytes, cloudId: cloud.id });
  return { info, bytes, usedBrowserCopy: false };
}
