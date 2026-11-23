// Client for the server's document API (server/src/worker.ts): a user's .docx files, kept in
// Cloudflare R2 with their catalogue in the user's own D1 database.
import { decodeIndex, type DocIndex } from '@golemdocs/docx';
import { ACCOUNT_STORAGE_GB } from '@golemdocs/ops';
import type { Folder } from './folders.ts';
import { encryptedDocumentKey, folderInfo, isEncryptedFolder, sealNameWith } from './encryption/session.ts';
import { t } from './i18n/index.ts';
import type { Manifest } from './storage/chunker.ts';

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
  /** A document shared with this user view-only: the share's own address for the viewer (/view?s=<token>), not the document's id. */
  viewToken?: string;
  /** Who shared it (documents shared with this user). */
  owner?: { name: string | null; email: string | null };
  /** Encrypted (docs/encrypted-folders.md): its file and name are sealed, with the item key `wrappedKey` (the owner's only). */
  encrypted?: boolean;
  wrappedKey?: string;
}

/**
 * The name to send for a document: sealed, for one in an encrypted folder (the server refuses any other), whether the caller had it
 * open or sealed already. `folderId` for a new one, the document's id for one the account has.
 */
async function nameToSend(name: string, where: { key?: string | null; id?: string }): Promise<string> {
  const key = where.key ?? (where.id ? encryptedDocumentKey(where.id) : null);
  return key ? sealNameWith(key, name) : name;
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
  /** The server's name for why, when the client needs to tell this refusal from others (see server/src/http.ts). */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Longest the server may ask us to wait before a request is sent again (Cloudflare blocks its API for five minutes when it is over its limit), and how many times it is. */
const MAX_WAIT_SECONDS = 300;
const MAX_RETRIES = 3;

/**
 * The longest a request may wait for the server's answer to start (an upload's body is sent within it, so it is generous).
 * A connection that went dead under a sleeping computer or a changed network otherwise never settles, and whatever awaits
 * it, such as the vault's sync, waits for ever.
 */
export const ANSWER_MS = 5 * 60_000;

/**
 * `fetch`, but one that gives up after `ms` without an answer: it rejects with a `TypeError`, as a request that could not
 * reach the server does, so callers treat it as being offline. A caller's own `signal` still aborts it as before.
 */
export async function fetchWithin(input: string, init: RequestInit | undefined, ms: number = ANSWER_MS): Promise<Response> {
  const controller = new AbortController();
  const outer = init?.signal;
  const forward = () => controller.abort(outer?.reason);
  if (outer?.aborted) forward();
  else outer?.addEventListener('abort', forward, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new TypeError(`no answer from the server in ${Math.round(ms / 1000)} seconds`);
    throw error;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', forward);
  }
}

/**
 * `fetch` (one that gives up when no answer comes, see `fetchWithin`), but a 429 (the server's way of saying it is being
 * used too fast: it did nothing with the request) waits as long as it asked, then sends the request again.
 */
export async function send(input: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetchWithin(input, init);
    if (response.status !== 429 || attempt === MAX_RETRIES) return response;
    const asked = Number(response.headers.get('retry-after'));
    const seconds = Math.min(Number.isFinite(asked) && asked > 0 ? asked : 5 * (attempt + 1), MAX_WAIT_SECONDS);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
}

async function check(response: Response): Promise<Response> {
  if (response.ok) return response;
  const body = await response.json().then((b: { error?: string; code?: string }) => b, () => undefined);
  throw new CloudError(response.status, refusalMessage(body?.code) ?? body?.error ?? t('app.requestFailed', { status: response.status }), body?.code);
}

/** The words for a refusal the person has to act on, in their language (the server's own message is English, for logs). */
function refusalMessage(code: string | undefined): string | undefined {
  if (code === 'storage-full') return t('app.storageFull', { limit: ACCOUNT_STORAGE_GB });
  if (code === 'owner-storage-full') return t('app.ownerStorageFull');
  return undefined;
}

/** Where a document's .docx bytes can be fetched (usable as a `docx-url` document source). */
export function documentUrl(id: string): string {
  return `/api/documents/${id}`;
}

/**
 * The document's .docx bytes. With `onProgress` the body is read as it arrives and the share received is reported (only when the
 * size is known: a compressed response's length is not the length of what it holds).
 */
export async function downloadDocument(id: string, onProgress?: (share: number) => void): Promise<ArrayBuffer> {
  const response = await check(await send(documentUrl(id)));
  const total = response.headers.has('content-encoding') ? 0 : Number(response.headers.get('content-length'));
  if (!onProgress || !response.body || !(total > 0)) return response.arrayBuffer();
  const parts: Uint8Array[] = [];
  let received = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    onProgress(Math.min(1, received / total));
  }
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes.buffer;
}

/**
 * The account's search index of a document (made by the server the first time it is asked for, and
 * again after the document changes), and the version of the document it is for (the document's
 * `updatedAt`). Null when the server has none to give (a PDF, a picture, a workbook: the page makes those itself).
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

/** A new document; an encrypted one (`key`, its wrapped item key) comes sealed, file and name. */
export async function createDocument(given: string, bytes: Uint8Array, folderId?: string, key?: string): Promise<CloudDocument> {
  const folder = folderId ? `&folder=${encodeURIComponent(folderId)}` : '';
  const name = await nameToSend(given, { key });
  const response = await send(`/api/documents?name=${encodeURIComponent(name)}${folder}${key ? `&key=${key}` : ''}`, {
    method: 'POST',
    headers: { 'content-type': DOCX },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  return (await check(response)).json();
}

/** The content type of a save that sends only the chunks the server lacks (see server/src/fileStore.ts). */
const DELTA = 'application/vnd.golemdocs.delta';

/** Gives the bytes of chunks, by hash. */
export type ChunkSource = (hashes: string[]) => Promise<{ hash: string; bytes: Uint8Array }[]>;

/** A delta upload's body: a 4-byte length, that many bytes of JSON `{ manifest, supplied }`, then the supplied chunks one after the other. */
function deltaBody(manifest: Manifest, supplied: { hash: string; bytes: Uint8Array }[]): Uint8Array {
  const header = new TextEncoder().encode(JSON.stringify({ manifest, supplied: supplied.map((c) => c.hash) }));
  const body = new Uint8Array(4 + header.byteLength + supplied.reduce((sum, c) => sum + c.bytes.byteLength, 0));
  new DataView(body.buffer).setUint32(0, header.byteLength);
  body.set(header, 4);
  let at = 4 + header.byteLength;
  for (const { bytes } of supplied) {
    body.set(bytes, at);
    at += bytes.byteLength;
  }
  return body;
}

/**
 * Sends a document as its chunks, leaving out the `known` ones (what the server has of the version this one started from). If the
 * server says it lacks some of them after all (its copy was made whole by a room, say), everything goes, once.
 */
async function sendChunked(method: 'POST' | 'PUT', url: string, manifest: Manifest, source: ChunkSource, known: ReadonlySet<string>): Promise<CloudDocument> {
  const all = [...new Set(manifest.chunks.map((c) => c.h))];
  const attempt = async (hashes: string[]) => send(url, { method, headers: { 'content-type': DELTA }, body: deltaBody(manifest, await source(hashes)) as Uint8Array<ArrayBuffer> });
  let response = await attempt(all.filter((h) => !known.has(h)));
  if (response.status === 400 && all.some((h) => known.has(h)) && (await response.clone().json().catch(() => null))?.code === 'missing-chunks') response = await attempt(all);
  return (await check(response)).json();
}

/** A new document from its chunks (all of them are sent). */
export async function createChunked(given: string, manifest: Manifest, source: ChunkSource, folderId?: string, key?: string): Promise<CloudDocument> {
  const folder = folderId ? `&folder=${encodeURIComponent(folderId)}` : '';
  const name = await nameToSend(given, { key });
  return sendChunked('POST', `/api/documents?name=${encodeURIComponent(name)}${folder}${key ? `&key=${key}` : ''}`, manifest, source, new Set());
}

/** Replaces a document's bytes with its chunks, sending those not in `known` (see `saveDocument` for `base`). */
export async function saveChunked(id: string, manifest: Manifest, source: ChunkSource, known: ReadonlySet<string>, name?: string, base?: number): Promise<CloudDocument> {
  const params = new URLSearchParams();
  if (name) params.set('name', await nameToSend(name, { id }));
  if (base !== undefined) params.set('base', String(base));
  return sendChunked('PUT', `/api/documents/${id}${params.size ? `?${params}` : ''}`, manifest, source, known);
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
/** The most the server keeps of one document (it refuses more with 413; see server/src/documents.ts). */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

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
  if (name) params.set('name', await nameToSend(name, { id }));
  if (base !== undefined) params.set('base', String(base));
  const query = params.size ? `?${params}` : '';
  const response = await send(`/api/documents/${id}${query}`, {
    method: 'PUT',
    headers: { 'content-type': DOCX },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  return (await check(response)).json();
}

/**
 * Converts a document (docs/encrypted-folders.md): `encrypt` (its new wrapped item key) with its sealed file and name, or `decrypt` with
 * readable ones. What it replaces is not kept as a version; each version is converted after, with `replaceCloudVersion`.
 */
export async function convertCloudDocument(id: string, bytes: Uint8Array, change: { encrypt: string; name: string } | { decrypt: true; name: string }, base?: number): Promise<CloudDocument> {
  const params = new URLSearchParams({ name: change.name });
  if ('encrypt' in change) params.set('encrypt', change.encrypt);
  else params.set('decrypt', '1');
  if (base !== undefined) params.set('base', String(base));
  const response = await send(`/api/documents/${id}?${params}`, { method: 'PUT', headers: { 'content-type': DOCX }, body: bytes as Uint8Array<ArrayBuffer> });
  return (await check(response)).json();
}

/** Replaces a kept version's file in place, sealed or readable as its document now is (converting it); its name too, if given. */
export async function replaceCloudVersion(id: string, version: number, bytes: Uint8Array, name?: string | null): Promise<CloudVersion> {
  const query = typeof name === 'string' ? `?${new URLSearchParams({ name })}` : '';
  const response = await send(`/api/documents/${id}/versions/${version}${query}`, { method: 'PUT', headers: { 'content-type': DOCX }, body: bytes as Uint8Array<ArrayBuffer> });
  return (await check(response)).json();
}

/** Renames a document in the account on its own: unlike a save, it works while several people are editing it. */
export async function renameCloudDocument(id: string, given: string): Promise<CloudDocument> {
  const name = await nameToSend(given, { id });
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
export async function putFolders(folders: readonly { id: string; name?: string; parentId?: string | null; encrypted?: boolean; wrappedKey?: string }[]): Promise<BatchResult<Folder>> {
  // Inside an encrypted folder a folder's name is sealed, with its own key (docs/encrypted-folders.md): where it goes, or where it is.
  const wanted = await Promise.all(
    folders.map(async ({ id, name, parentId, encrypted, wrappedKey }) => {
      const known = folderInfo(id);
      const inside = isEncryptedFolder(parentId !== undefined ? parentId : (known?.parentId ?? null));
      const key = wrappedKey ?? known?.wrappedKey;
      const sent = name !== undefined && inside && key ? await sealNameWith(key, name) : name;
      return { id, name: sent, parentId, ...(encrypted !== undefined ? { encrypted } : {}), ...(wrappedKey ? { wrappedKey } : {}) };
    }),
  );
  return chunked(wanted, (chunk) => batch<Folder>('PUT', '/api/folders', { folders: chunk }));
}

/** Removes folders only, in one request: what was in each moves up to where it was. */
export function removeFolders(ids: readonly string[]): Promise<BatchResult<string>> {
  return chunked(ids, (chunk) => batch<string>('DELETE', '/api/folders', { ids: chunk }));
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

/** A document's public link token (null while it has none). `make` turns it on (keeping the one there is), `reset` replaces it, `off` turns it off. */
export async function publicLink(id: string, change?: 'make' | 'reset' | 'off'): Promise<string | null> {
  const method = change === 'make' ? 'PUT' : change === 'reset' ? 'POST' : change === 'off' ? 'DELETE' : 'GET';
  const response = await check(await send(`/api/documents/${id}/link`, { method }));
  return change === 'off' ? null : ((await response.json()) as { token: string | null }).token;
}

/** The address of a public link: the viewer for anyone, or with `embed`, the same viewer for a frame in another site. */
export const publicLinkUrl = (token: string, embed = false): string => `${location.origin}/view?p=${encodeURIComponent(token)}${embed ? '&embed' : ''}`;

// --- Folder sharing (server/src/sharedFolders.ts, docs/folder-sharing.md) -----------------------------------------------------

/** A folder someone shared with this user. */
export interface SharedFolder {
  ownerId: string;
  /** The shared folder's id in the owner's account. */
  folderId: string;
  name: string;
  role: ShareRole;
  owner: { name: string | null; email: string | null };
  /** Where this person's vault keeps its copy (`Shared/<owner>/<folder>`), once one of their computers made it. */
  localName: string | null;
  createdAt: number;
  /** A view-only share: its own address for the viewer (/view?f=<token>). */
  viewToken?: string;
}

/** A folder inside a shared folder (the shared folder itself has `parentId` null). */
export interface SharedFolderFolder {
  id: string;
  name: string;
  parentId: string | null;
  /** Added by this user, who may rename or delete it. */
  createdByYou: boolean;
}

/** A document inside a shared folder. */
export interface SharedFolderDocument extends CloudDocument {
  folderId: string;
  /** Its path inside the shared folder, as the viewer's address names it. */
  path?: string;
  createdByYou: boolean;
}

/** What is in a shared folder. */
export interface SharedFolderTree extends SharedFolder {
  folders: SharedFolderFolder[];
  documents: SharedFolderDocument[];
}

const sharedFolderPath = (f: Pick<SharedFolder, 'ownerId' | 'folderId'>): string => `/api/shared-folders/${encodeURIComponent(f.ownerId)}/${f.folderId}`;
const jsonBody = (value: unknown): RequestInit => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

/** Folders other people shared with this user. */
export async function listSharedFolders(): Promise<SharedFolder[]> {
  return (await check(await send('/api/shared-folders'))).json();
}

/** The folders and documents in a folder shared with this user. */
export async function sharedFolderTree(f: Pick<SharedFolder, 'ownerId' | 'folderId'>): Promise<SharedFolderTree> {
  return (await check(await send(`${sharedFolderPath(f)}/tree`))).json();
}

/** Leaves a folder shared with this user. */
export async function leaveSharedFolder(f: Pick<SharedFolder, 'ownerId' | 'folderId'>): Promise<void> {
  await check(await send(sharedFolderPath(f), { method: 'DELETE' }));
}

/** Records where this person's vault keeps its copy of a shared folder, for their other computers. */
export async function setSharedFolderLabel(f: Pick<SharedFolder, 'ownerId' | 'folderId'>, localName: string): Promise<void> {
  await check(await send(sharedFolderPath(f), { method: 'PATCH', ...jsonBody({ localName }) }));
}

/** Makes a folder inside a shared folder (as an editor), or renames one this user made there. */
export async function putSharedSubfolder(f: Pick<SharedFolder, 'ownerId' | 'folderId'>, id: string, name: string, parentId?: string): Promise<SharedFolderFolder> {
  return (await check(await send(`${sharedFolderPath(f)}/folders/${id}`, { method: 'PUT', ...jsonBody(parentId === undefined ? { name } : { name, parentId }) }))).json();
}

/** Deletes a folder this user made inside a shared folder (what is in it moves up). */
export async function deleteSharedSubfolder(f: Pick<SharedFolder, 'ownerId' | 'folderId'>, id: string): Promise<void> {
  await check(await send(`${sharedFolderPath(f)}/folders/${id}`, { method: 'DELETE' }));
}

/** Adds a document to a folder of someone else's shared with this user as an editor: it is the owner's, in the owner's account. */
export async function createInSharedFolder(ownerId: string, folderId: string, name: string, bytes: Uint8Array): Promise<SharedFolderDocument> {
  const response = await send(`/api/documents?name=${encodeURIComponent(name)}&folder=${folderId}&owner=${encodeURIComponent(ownerId)}`, {
    method: 'POST',
    headers: { 'content-type': DOCX },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  return (await check(response)).json();
}

/** Deletes a document this user added to a shared folder (it goes to the owner's trash). */
export async function deleteSharedDocument(id: string): Promise<void> {
  await check(await send(`/api/documents/${id}`, { method: 'DELETE' }));
}

/** Who one of this user's folders is shared with. */
export async function listFolderShares(folderId: string): Promise<Share[]> {
  return (await check(await send(`/api/folders/${folderId}/shares`))).json();
}

/** Shares one of this user's folders with the person who signed in with this email, or changes their role. */
export async function addFolderShare(folderId: string, email: string, role: ShareRole): Promise<Share> {
  return (await check(await send(`/api/folders/${folderId}/shares`, { method: 'PUT', ...jsonBody({ email, role }) }))).json();
}

/** Stops sharing one of this user's folders with someone. */
export async function removeFolderShare(folderId: string, userId: string): Promise<void> {
  await check(await send(`/api/folders/${folderId}/shares/${encodeURIComponent(userId)}`, { method: 'DELETE' }));
}

/** A folder's public link token, as `publicLink` for a document. */
export async function folderPublicLink(folderId: string, change?: 'make' | 'reset' | 'off'): Promise<string | null> {
  const method = change === 'make' ? 'PUT' : change === 'reset' ? 'POST' : change === 'off' ? 'DELETE' : 'GET';
  const response = await check(await send(`/api/folders/${folderId}/link`, { method }));
  return change === 'off' ? null : ((await response.json()) as { token: string | null }).token;
}

/** The viewer's address for a shared folder: its public link (`public`), or a person's view-only share; at a file inside it, if `path`. */
export const folderViewUrl = (token: string, isPublic: boolean, path?: string): string =>
  `${location.origin}/view?${isPublic ? 'pf' : 'f'}=${encodeURIComponent(token)}${path ? `&path=${encodeURIComponent(path)}` : ''}`;

// --- History and the trash (server/src/versions.ts, trash.ts) ----------------------------------------------------------------

/** A version of a document the account kept (`version` is the document's `updatedAt` as it was). */
export interface CloudVersion {
  version: number;
  size: number;
  name: string | null;
  /** Kept sealed: one of an encrypted document's (docs/encrypted-folders.md). */
  sealed?: boolean;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/** A document's kept versions, newest first. Anyone who can open the document may ask. */
export async function listCloudVersions(id: string): Promise<CloudVersion[]> {
  return (await check(await send(`/api/documents/${id}/versions`))).json();
}

/** Keeps the document as it is now; with a `name`, as a named version (kept longer). Anyone who can edit it may. */
export async function saveCloudVersion(id: string, given?: string): Promise<CloudVersion> {
  const name = given ? await nameToSend(given, { id }) : given;
  return (await check(await send(`/api/documents/${id}/versions`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(name ? { name } : {}) }))).json();
}

/** The bytes of a kept version. */
export async function downloadCloudVersion(id: string, version: number): Promise<ArrayBuffer> {
  return (await check(await send(`/api/documents/${id}/versions/${version}`))).arrayBuffer();
}

/** Names a version, or (null) lets it be thinned like the others. */
export async function nameCloudVersion(id: string, version: number, given: string | null): Promise<CloudVersion> {
  const name = given ? await nameToSend(given, { id }) : given;
  return (await check(await send(`/api/documents/${id}/versions/${version}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ name }) }))).json();
}

export async function deleteCloudVersion(id: string, version: number): Promise<void> {
  await check(await send(`/api/documents/${id}/versions/${version}`, { method: 'DELETE' }));
}

/** Makes a new document (the caller's own) from a version, leaving the document as it is. */
export async function restoreCloudVersion(id: string, version: number, given?: string): Promise<CloudDocument> {
  const name = given ? await nameToSend(given, { id }) : given;
  const query = name ? `?${new URLSearchParams({ name })}` : '';
  return (await check(await send(`/api/documents/${id}/versions/${version}/restore${query}`, { method: 'POST' }))).json();
}

/** A deleted document, kept for 30 days. */
export interface TrashedDocument {
  id: string;
  name: string;
  size: number;
  updatedAt: number;
  thumbAt: number | null;
  deletedAt: number;
  /** When it will be deleted for good. */
  purgeAt: number;
  /** The folder it was in when it was deleted (null: the top level). */
  folderId?: string | null;
  /** An encrypted document's: its name is sealed with this key (docs/encrypted-folders.md). */
  encrypted?: boolean;
  wrappedKey?: string;
}

export async function listTrash(): Promise<TrashedDocument[]> {
  return (await check(await send('/api/trash'))).json();
}

/** Puts a deleted document back (unshared, and at the top level if its folder is gone). */
export async function restoreFromTrash(id: string): Promise<CloudDocument> {
  const document = (await (await check(await send(`/api/trash/${id}/restore`, { method: 'POST' }))).json()) as CloudDocument;
  deleted.delete(id);
  return document;
}

/** A trashed document's bytes, to look at before restoring it (only its owner may). */
export async function downloadTrashed(id: string): Promise<ArrayBuffer> {
  return (await check(await send(`/api/trash/${id}/file`))).arrayBuffer();
}

/** Deletes one trashed document for good, or (without an id) empties the trash. */
export async function purgeTrash(id?: string): Promise<void> {
  await check(await send(id ? `/api/trash/${id}` : '/api/trash', { method: 'DELETE' }));
}
