// Client for the server's document API (server/src/worker.ts): a user's .docx files, kept in
// Cloudflare R2 with their catalogue in the user's own D1 database.

export interface CloudDocument {
  id: string;
  name: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  /** When its thumbnail was uploaded; null if it has none yet. */
  thumbAt: number | null;
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
  throw new CloudError(response.status, message ?? `request failed (${response.status})`);
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

export async function listDocuments(): Promise<CloudDocument[]> {
  return (await check(await fetch('/api/documents'))).json();
}

export async function createDocument(name: string, bytes: Uint8Array): Promise<CloudDocument> {
  const response = await fetch(`/api/documents?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': DOCX },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  return (await check(response)).json();
}

export async function saveDocument(id: string, bytes: Uint8Array, name?: string): Promise<CloudDocument> {
  const query = name ? `?name=${encodeURIComponent(name)}` : '';
  const response = await fetch(`/api/documents/${id}${query}`, {
    method: 'PUT',
    headers: { 'content-type': DOCX },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  return (await check(response)).json();
}

export async function deleteDocument(id: string): Promise<void> {
  await check(await fetch(`/api/documents/${id}`, { method: 'DELETE' }));
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
