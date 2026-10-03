// Client for the server's document API (server/src/worker.ts): a user's .docx files, kept in
// Cloudflare R2 with their catalogue in the user's own D1 database.
import { decodeIndex, type DocIndex } from '@golemdocs/docx';
import type { Folder } from './folders.ts';
import { t } from './i18n/index.ts';

export interface CloudDocument {
  id: string;
  name: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  /** When its thumbnail was uploaded; null if it has none yet. */
  thumbAt: number | null;
  /** The folder it is in (see folders.ts); null at the top level. Only the owner's own documents have one. */
  folderId?: string | null;
  /** What this user may do with it. Anything but 'owner' is a document someone shared with them. */
  role?: 'owner' | 'editor' | 'viewer';
  /** Who shared it (documents shared with this user). */
  owner?: { name: string | null; email: string | null };
}

export type ShareRole = 'editor' | 'viewer';

/** Someone a document is shared with. */
export interface Share {
  userId: string;
  name: string | null;
  email: string | null;
  picture?: string | null;
  role: ShareRole;
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** A failed cloud request. `status` 401 means the user isn't signed in. */
export class CloudError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Longest the server may ask us to wait before a request is sent again (Cloudflare blocks its API for five minutes when it is over its limit), and how many times it is. */
const MAX_WAIT_SECONDS = 300;
const MAX_RETRIES = 3;

/**
 * `fetch`, but a 429 (the server's way of saying it is being used too fast: it did nothing with
 * the request) waits as long as it asked, then sends the request again.
 */
export async function send(input: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(input, init);
    if (response.status !== 429 || attempt === MAX_RETRIES) return response;
    const asked = Number(response.headers.get('retry-after'));
    const seconds = Math.min(Number.isFinite(asked) && asked > 0 ? asked : 5 * (attempt + 1), MAX_WAIT_SECONDS);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
}

async function check(response: Response): Promise<Response> {
  if (response.ok) return response;
  const message = await response.json().then((b: { error?: string }) => b.error, () => undefined);
  throw new CloudError(response.status, message ?? t('app.requestFailed', { status: response.status }));
}

/** Where a document's .docx bytes can be fetched (usable as a `docx-url` document source). */
export function documentUrl(id: string): string {
  return `/api/documents/${id}`;
}

/** The document's .docx bytes. */
export async function downloadDocument(id: string): Promise<ArrayBuffer> {
  return (await check(await send(documentUrl(id)))).arrayBuffer();
}

/**
 * The account's search index of a document (made by the server the first time it is asked for, and
 * again after the document changes), and the version of the document it is for (the document's
 * `updatedAt`). Null when there is none to have: too big, or made by another version of the app.
 */
export async function downloadIndex(id: string): Promise<{ index: DocIndex; at: number } | null> {
  const response = await check(await send(`/api/documents/${id}/index`));
  const at = Number(response.headers.get('x-index-at'));
  const index = Number.isFinite(at) && at > 0 ? await decodeIndex(new Uint8Array(await response.arrayBuffer())) : null;
  return index ? { index, at } : null;
}

/** Where a document's thumbnail image is (the version in the URL makes it safe to cache forever). */
export function thumbnailUrl(doc: Pick<CloudDocument, 'id' | 'thumbAt'>): string | null {
  return doc.thumbAt == null ? null : `/api/documents/${doc.id}/thumbnail?v=${doc.thumbAt}`;
}

/** Uploads the first-page thumbnail for a document. */
export async function uploadThumbnail(id: string, image: Blob): Promise<CloudDocument> {
  const response = await send(`/api/documents/${id}/thumbnail`, {
    method: 'PUT',
    headers: { 'content-type': image.type },
    body: image,
  });
  return (await check(response)).json();
}

/**
 * Documents and folders deleted from the account in this session, or being deleted. A listing asked
 * for before the delete went through (or answered from a server cache that is behind) can still
 * have them; they are left out, so what was deleted never pops back.
 */
const deleted = new Set<string>();

/** Whether this document or folder was deleted from the account in this session. */
export const isDeleted = (id: string | null | undefined): boolean => !!id && deleted.has(id);

/**
 * Whether this document was deleted from the account in this session, by itself or with its folder
 * (a folder's delete names only the folders, every one inside it included, not their documents).
 */
export const isDeletedDocument = (doc: { id: string; folderId?: string | null }): boolean => deleted.has(doc.id) || isDeleted(doc.folderId);

export async function listDocuments(): Promise<CloudDocument[]> {
  const docs: CloudDocument[] = await (await check(await send('/api/documents'))).json();
  return docs.filter((d) => !isDeletedDocument(d));
}

export async function createDocument(name: string, bytes: Uint8Array, folderId?: string): Promise<CloudDocument> {
  const folder = folderId ? `&folder=${encodeURIComponent(folderId)}` : '';
  const response = await send(`/api/documents?name=${encodeURIComponent(name)}${folder}`, {
    method: 'POST',
    headers: { 'content-type': DOCX },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  return (await check(response)).json();
}

/** A document to upload in a batch: where it goes, and what happened to it. */
export interface NewDocument {
  name: string;
  bytes: Uint8Array;
  folderId?: string | null;
}

/** Most documents, and most bytes, in one batch (the server takes up to 500 documents and 51 MB; see server/src/worker.ts). A larger document goes in a batch of its own. */
export const BATCH_MAX_DOCUMENTS = 200;
export const BATCH_MAX_BYTES = 24 * 1024 * 1024;

/**
 * Uploads several documents in one request: the server answers for each, in order, with the new
 * document or why it wasn't saved (a failure of one doesn't stop the rest). A whole request that
 * fails throws, and none of it can be counted on.
 */
export async function createDocuments(documents: readonly NewDocument[]): Promise<(CloudDocument | { error: string })[]> {
  const header = new TextEncoder().encode(JSON.stringify({ documents: documents.map((d) => ({ name: d.name, size: d.bytes.byteLength, folderId: d.folderId ?? null })) }));
  const body = new Uint8Array(4 + header.byteLength + documents.reduce((sum, d) => sum + d.bytes.byteLength, 0));
  new DataView(body.buffer).setUint32(0, header.byteLength);
  body.set(header, 4);
  let at = 4 + header.byteLength;
  for (const d of documents) {
    body.set(d.bytes, at);
    at += d.bytes.byteLength;
  }
  const response = await send('/api/documents/batch', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body });
  const { results } = (await (await check(response)).json()) as { results: ({ document: CloudDocument } | { error: string })[] };
  return results.map((r) => ('document' in r ? r.document : r));
}

/**
 * Replaces a document's bytes. With `base` (the `updatedAt` this copy started from), fails with
 * status 409 if it was changed elsewhere since, instead of overwriting that.
 */
export async function saveDocument(id: string, bytes: Uint8Array, name?: string, base?: number): Promise<CloudDocument> {
  const params = new URLSearchParams();
  if (name) params.set('name', name);
  if (base !== undefined) params.set('base', String(base));
  const query = params.size ? `?${params}` : '';
  const response = await send(`/api/documents/${id}${query}`, {
    method: 'PUT',
    headers: { 'content-type': DOCX },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  return (await check(response)).json();
}

/** Renames a document in the account on its own: unlike a save, it works while several people are editing it. */
export async function renameCloudDocument(id: string, name: string): Promise<CloudDocument> {
  return (await check(await send(`/api/documents/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }))).json();
}

/** What a request on several things did: the ones it did, and each that it could not with why (`status` 404 is "already gone"). */
export interface BatchResult<T> {
  ok: T[];
  failed: { id: string; error: string }[];
}

/** Sends a batch (JSON body) and returns how each item went; only the request failing as a whole throws. */
async function batch<T>(method: string, url: string, body: unknown): Promise<BatchResult<T>> {
  return (await check(await send(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))).json();
}

/** Most ids or folders the server takes in one request (MAX_BATCH in server/src/worker.ts). */
const BATCH_ITEMS = 500;

/** Sends a batch in as many requests as the server's limit needs, in order, and joins what they did. */
async function chunked<T, I>(items: readonly I[], send: (chunk: I[]) => Promise<BatchResult<T>>, onProgress?: (done: number, total: number) => void): Promise<BatchResult<T>> {
  const joined: BatchResult<T> = { ok: [], failed: [] };
  for (let i = 0; i < Math.max(items.length, 1); i += BATCH_ITEMS) {
    const result = await send(items.slice(i, i + BATCH_ITEMS));
    joined.ok.push(...result.ok);
    joined.failed.push(...result.failed);
    onProgress?.(Math.min(i + BATCH_ITEMS, items.length), items.length);
  }
  return joined;
}

/**
 * Deletes documents and folders, in as few requests as the server's limit allows. A folder goes with everything inside it. The
 * caller sees which could not be deleted.
 */
export async function deleteDocuments(ids: readonly string[], folderIds: readonly string[] = [], onProgress?: (done: number, total: number) => void): Promise<BatchResult<string>> {
  // Left out of listings from now on; those that turn out not to be deleted come back.
  const all = [...ids, ...folderIds];
  for (const id of all) deleted.add(id);
  try {
    const result = await chunked<string, { id: string; folder: boolean }>(
      [...ids.map((id) => ({ id, folder: false })), ...folderIds.map((id) => ({ id, folder: true }))],
      (chunk) =>
        batch<string>('DELETE', '/api/documents', {
          ids: chunk.filter((c) => !c.folder).map((c) => c.id),
          folders: chunk.filter((c) => c.folder).map((c) => c.id),
        }),
      onProgress,
    );
    for (const f of result.failed) if (f.error !== 'not found') deleted.delete(f.id);
    return result;
  } catch (error) {
    for (const id of all) deleted.delete(id);
    throw error;
  }
}

/** Moves documents to a folder (null: the top level), in one request. */
export function moveDocuments(ids: readonly string[], folderId: string | null): Promise<BatchResult<string>> {
  return chunked(ids, (chunk) => batch<string>('PATCH', '/api/documents', { ids: chunk, folderId }));
}

export async function listFolders(): Promise<Folder[]> {
  const folders: Folder[] = await (await check(await send('/api/folders'))).json();
  return folders.filter((f) => !deleted.has(f.id));
}

/**
 * Creates folders with these ids, or renames and moves the ones that exist, in one request. They
 * are made in order, so a folder may go inside one earlier in the list. An update may leave out
 * the name or the parent, to keep it.
 */
export function putFolders(folders: readonly { id: string; name?: string; parentId?: string | null }[]): Promise<BatchResult<Folder>> {
  const wanted = folders.map(({ id, name, parentId }) => ({ id, name, parentId }));
  return chunked(wanted, (chunk) => batch<Folder>('PUT', '/api/folders', { folders: chunk }));
}

/** The reason the first failure of a batch gives, as an error; nothing when all went through. */
export function throwIfFailed(result: BatchResult<unknown>): void {
  if (result.failed.length) throw new CloudError(0, result.failed[0]!.error);
}

/** Documents other people shared with this user. */
export async function listShared(): Promise<CloudDocument[]> {
  return (await check(await send('/api/shared'))).json();
}

/** Who a document is shared with (owner only). */
export async function listShares(id: string): Promise<Share[]> {
  return (await check(await send(`/api/documents/${id}/shares`))).json();
}

/** Shares a document with the person who signed in with this email, or changes their role. */
export async function addShare(id: string, email: string, role: ShareRole): Promise<Share> {
  const response = await send(`/api/documents/${id}/shares`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, role }) });
  return (await check(response)).json();
}

/** Stops sharing with someone (or, for the user themselves, leaves a document shared with them). */
export async function removeShare(id: string, userId: string): Promise<void> {
  await check(await send(`/api/documents/${id}/shares/${userId}`, { method: 'DELETE' }));
}
