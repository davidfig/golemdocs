// Client for the server's document API (server/src/worker.ts): a user's .docx files, kept in
// Cloudflare R2 with their catalogue in the user's own D1 database.

export interface CloudDocument {
  id: string;
  name: string;
  size: number;
  createdAt: number;
  updatedAt: number;
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
