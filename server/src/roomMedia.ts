// The pictures of a document being edited together. The room's changes carry only a picture's name (the hash of its bytes, see
// @golemdocs/docx sharedMedia.ts); the bytes are kept here, in the owner's storage, by anyone who may edit, and read by anyone who
// may see the document, and the room's snapshot writes them into the .docx it makes.

import { sha256Hex } from '@golemdocs/docx';
import type { Env } from './cf.ts';
import { HttpError } from './http.ts';
import { mediaKey, mediaPrefix } from './keys.ts';
import type { Role } from './sharing.ts';

/** The most one picture may be. */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const HASH = /^[0-9a-f]{64}$/;

/** GET (anyone who can open the document) or PUT (an editor or the owner) of a picture, named by the hash of its bytes. */
export async function handleRoomMedia(request: Request, env: Env, ownerId: string, docId: string, role: Role, hash: string): Promise<Response> {
  if (!HASH.test(hash)) throw new HttpError(404, 'not found');
  const key = mediaKey(ownerId, docId, hash);
  if (request.method === 'GET') {
    const object = await env.FILES.get(key);
    if (!object) throw new HttpError(404, 'not found');
    // Named by what it is, so it never changes. Served as plain bytes: it is only ever drawn or put in a document.
    return new Response(object.body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
  }
  if (request.method !== 'PUT') throw new HttpError(404, 'not found');
  if (role === 'viewer') throw new HttpError(403, 'view only');
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_MEDIA_BYTES) throw new HttpError(413, 'picture too large');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new HttpError(413, 'picture too large');
  // The name is what the bytes are: nobody can put other bytes under it.
  if ((await sha256Hex(bytes)) !== hash) throw new HttpError(400, 'the bytes are not the ones named');
  await env.FILES.put(key, bytes);
  return new Response(null, { status: 204 });
}

/** One picture's bytes, or null. */
export async function readMedia(env: Env, ownerId: string, docId: string, hash: string): Promise<Uint8Array | null> {
  const object = await env.FILES.get(mediaKey(ownerId, docId, hash));
  return object ? new Uint8Array(await new Response(object.body).arrayBuffer()) : null;
}

/** Deletes all of a document's pictures (the document is gone, or what it was edited as has been written into its file). */
export async function deleteMedia(env: Env, ownerId: string, docId: string): Promise<void> {
  const prefix = mediaPrefix(ownerId, docId);
  let cursor: string | undefined;
  do {
    const listed = await env.FILES.list({ prefix, cursor });
    if (listed.objects.length) await env.FILES.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
