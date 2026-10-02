// Client for the server's document API (server/src/worker.ts): a user's .docx files, kept in
// Cloudflare R2 with their catalogue in the user's own D1 database.
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
  return (await check(await fetch(documentUrl(id)))).arrayBuffer();
}

/** Where a document's thumbnail image is (the version in the URL makes it safe to cache forever). */
export function thumbnailUrl(doc: Pick<CloudDocument, 'id' | 'thumbAt'>): string | null {
  return doc.thumbAt == null ? null : `/api/documents/${doc.id}/thumbnail?v=${doc.thumbAt}`;
}

/** Uploads the first-page thumbnail for a document. */
export async function uploadThumbnail(id: string, image: Blob): Promise<CloudDocument> {
  const response = await fetch(`/api/documents/${id}/thumbnail`, {
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

export async function listDocuments(): Promise<CloudDocument[]> {
  const docs: CloudDocument[] = await (await check(await fetch('/api/documents'))).json();
  return docs.filter((d) => !deleted.has(d.id));
}

export async function createDocument(name: string, bytes: Uint8Array, folderId?: string): Promise<CloudDocument> {
  const folder = folderId ? `&folder=${encodeURIComponent(folderId)}` : '';
  const response = await fetch(`/api/documents?name=${encodeURIComponent(name)}${folder}`, {
    method: 'POST',
    headers: { 'content-type': DOCX },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  return (await check(response)).json();
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
  const response = await fetch(`/api/documents/${id}${query}`, {
    method: 'PUT',
    headers: { 'content-type': DOCX },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  return (await check(response)).json();
}

/** What a request on several things did: the ones it did, and each that it could not with why (`status` 404 is "already gone"). */
export interface BatchResult<T> {
  ok: T[];
  failed: { id: string; error: string }[];
}

/** Sends a batch (JSON body) and returns how each item went; only the request failing as a whole throws. */
async function batch<T>(method: string, url: string, body: unknown): Promise<BatchResult<T>> {
  return (await check(await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))).json();
}

/**
 * Deletes documents and folders, in one request. A folder goes with everything inside it. The
 * caller sees which could not be deleted.
 */
export async function deleteDocuments(ids: readonly string[], folderIds: readonly string[] = []): Promise<BatchResult<string>> {
  // Left out of listings from now on; those that turn out not to be deleted come back.
  const all = [...ids, ...folderIds];
  for (const id of all) deleted.add(id);
  try {
    const result = await batch<string>('DELETE', '/api/documents', { ids, folders: folderIds });
    for (const f of result.failed) if (f.error !== 'not found') deleted.delete(f.id);
    return result;
  } catch (error) {
    for (const id of all) deleted.delete(id);
    throw error;
  }
}

/** Moves documents to a folder (null: the top level), in one request. */
export function moveDocuments(ids: readonly string[], folderId: string | null): Promise<BatchResult<string>> {
  return batch('PATCH', '/api/documents', { ids, folderId });
}

export async function listFolders(): Promise<Folder[]> {
  const folders: Folder[] = await (await check(await fetch('/api/folders'))).json();
  return folders.filter((f) => !deleted.has(f.id));
}

/**
 * Creates folders with these ids, or renames and moves the ones that exist, in one request. They
 * are made in order, so a folder may go inside one earlier in the list.
 */
export function putFolders(folders: readonly Pick<Folder, 'id' | 'name' | 'parentId'>[]): Promise<BatchResult<Folder>> {
  return batch('PUT', '/api/folders', { folders: folders.map(({ id, name, parentId }) => ({ id, name, parentId })) });
}

/** The reason the first failure of a batch gives, as an error; nothing when all went through. */
export function throwIfFailed(result: BatchResult<unknown>): void {
  if (result.failed.length) throw new CloudError(0, result.failed[0]!.error);
}

/** Documents other people shared with this user. */
export async function listShared(): Promise<CloudDocument[]> {
  return (await check(await fetch('/api/shared'))).json();
}

/** Who a document is shared with (owner only). */
export async function listShares(id: string): Promise<Share[]> {
  return (await check(await fetch(`/api/documents/${id}/shares`))).json();
}

/** Shares a document with the person who signed in with this email, or changes their role. */
export async function addShare(id: string, email: string, role: ShareRole): Promise<Share> {
  const response = await fetch(`/api/documents/${id}/shares`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, role }) });
  return (await check(response)).json();
}

/** Stops sharing with someone (or, for the user themselves, leaves a document shared with them). */
export async function removeShare(id: string, userId: string): Promise<void> {
  await check(await fetch(`/api/documents/${id}/shares/${userId}`, { method: 'DELETE' }));
}
