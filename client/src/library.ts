// Keeps a document saved in this browser and its copy in the cloud in step. Signed in, every
// document is in the account: the browser copy is saved first (so nothing waits on the network)
// and uploaded soon after. Nothing is ever merged, and nothing is overwritten either: an upload
// of a copy that started from an older version than the cloud's becomes a separate
// "(conflicted copy)" document instead.

import { CloudError, createDocument, downloadDocument, saveDocument, uploadThumbnail, type CloudDocument } from './cloud.ts';
import { getSaved, getThumbnail, listSaved, markSynced, saveFromCloud, type SavedInfo } from './storage/local.ts';
import { t } from './i18n/index.ts';

export interface Uploaded {
  doc: CloudDocument;
  /** The cloud copy had changed elsewhere, so this was saved as a new "(conflicted copy)" document. */
  conflictCopy: boolean;
}

/** "Report.docx" → "Report (conflicted copy).docx". */
export function conflictCopyName(name: string): string {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  return t('app.conflictedCopy', { stem, ext });
}

/** Uploads the saved browser copy to the cloud (creating the cloud document the first time). */
export async function uploadToCloud(localId: string, retry = true): Promise<Uploaded> {
  const saved = await getSaved(localId);
  if (!saved) throw new Error(t('app.noLongerSaved'));
  const { info } = saved;
  const bytes = new Uint8Array(saved.bytes);
  let doc: CloudDocument;
  let conflictCopy = false;
  try {
    doc = info.cloudId ? await saveDocument(info.cloudId, bytes, info.name, info.cloudUpdatedAt) : await createDocument(info.name, bytes);
  } catch (error) {
    if (!info.cloudId || !(error instanceof CloudError)) throw error;
    if (error.status === 404) {
      // The cloud copy was deleted elsewhere: start a new one.
      doc = await createDocument(info.name, bytes);
    } else if (error.status === 409 && retry && (await getSaved(localId))?.info.cloudUpdatedAt !== info.cloudUpdatedAt) {
      // Another tab uploaded this copy meanwhile, so the cloud moved on from here: go again from there.
      return uploadToCloud(localId, false);
    } else if (error.status === 409) {
      // Changed elsewhere too: keep both. This copy carries on as the conflicted one.
      doc = await createDocument(conflictCopyName(info.name), bytes);
      conflictCopy = true;
    } else {
      throw error;
    }
  }
  await markSynced(localId, { cloudId: doc.id, syncedAt: info.updatedAt, cloudUpdatedAt: doc.updatedAt, name: conflictCopy ? doc.name : undefined });
  // The thumbnail goes with the document, so other computers can show it without downloading the
  // document. Not worth failing the save over; the next save sends another.
  const thumbnail = await getThumbnail(localId).catch(() => null);
  if (thumbnail && thumbnail.forUpdatedAt === info.updatedAt) {
    doc = await uploadThumbnail(doc.id, thumbnail.blob).catch(() => doc);
  }
  return { doc, conflictCopy };
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
    bytes = await downloadDocument(cloud.id);
  } catch (error) {
    // Offline: the copy this browser has is better than nothing.
    const saved = linked && !(error instanceof CloudError) ? await getSaved(linked.id) : null;
    if (saved) return { ...saved, usedBrowserCopy: false };
    throw error;
  }
  const info = await saveFromCloud({ id: linked?.id, name: cloud.name, bytes, owner, cloudId: cloud.id, cloudUpdatedAt: cloud.updatedAt });
  return { info, bytes, usedBrowserCopy: false };
}
