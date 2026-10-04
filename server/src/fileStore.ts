// A document's file in R2: kept whole, as one object (what every document was, and what small ones and a room's save still are),
// or as chunks. A document kept as chunks is a small manifest at the file's usual key (JSON, marked `chunked` in its metadata) and its
// chunks beside it under `<owner>/<doc>.chunks/<sha-256>`. A save then sends and stores only the chunks that changed (see the delta
// upload in documents.ts), and everything that reads a file whole (the download, rooms, search) goes through here, so none of it
// needs to know which kind a document is.
//
// Chunks belong to one document, so they are never shared and need no counting: a save removes the ones its manifest dropped,
// and deleting the document removes the rest by prefix. A save that fails part way leaves chunks nobody uses; they go with the document.

import { sha256Hex } from '@golemdocs/docx';
import type { Env } from './cf.ts';
import { HttpError } from './http.ts';
import { chunkKey, chunkPrefix } from './keys.ts';

/** The content type of a save that sends only the chunks the server lacks. */
export const DELTA = 'application/vnd.golemdocs.delta';

const ALGO = 'cdc1';
const HASH = /^[0-9a-f]{64}$/;
/** The client keeps documents of this size or more as chunks (client/src/storage/chunker.ts), so deleting a smaller one need not look for any. */
export const CHUNKED_FROM = 2 * 1024 * 1024;
/** Chunks fetched ahead of the one being sent, and written at once. */
const AHEAD = 3;
const AT_ONCE = 8;

export interface Manifest {
  algo: string;
  size: number;
  chunks: { h: string; n: number }[];
}

/** Whether an R2 object is a manifest of chunks (rather than a whole file). */
export const isChunked = (object: { customMetadata?: Record<string, string> } | null | undefined): boolean => object?.customMetadata?.chunked === '1';

/** The size of the file an object stands for: its own, or the file its manifest describes. */
export const logicalSize = (object: { size: number; customMetadata?: Record<string, string> }): number => (isChunked(object) ? Number(object.customMetadata!.size) : object.size);

async function manifestOf(object: { body: ReadableStream }): Promise<Manifest> {
  const manifest = (await new Response(object.body).json()) as Manifest;
  if (manifest?.algo !== ALGO || !Array.isArray(manifest.chunks)) throw new HttpError(500, 'the document’s manifest is damaged');
  return manifest;
}

/** The chunks in order, each fetched a little before it is needed; fails the stream if one is missing. `ready` says whether the first is there. */
function chunkStream(env: Env, ownerId: string, docId: string, manifest: Manifest): { body: ReadableStream<Uint8Array>; ready: Promise<boolean> } {
  const wanted = manifest.chunks;
  const fetchOne = async (index: number): Promise<Uint8Array | null> => {
    const object = await env.FILES.get(chunkKey(ownerId, docId, wanted[index]!.h));
    if (!object) return null;
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    return bytes.length === wanted[index]!.n ? bytes : null;
  };
  const pending: Promise<Uint8Array | null>[] = [];
  let next = 0;
  const fill = () => {
    while (pending.length < AHEAD && next < wanted.length) pending.push(fetchOne(next++));
  };
  fill();
  const ready = pending.length ? pending[0]!.then((bytes) => bytes !== null, () => false) : Promise.resolve(true);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const promise = pending.shift();
      if (!promise) return controller.close();
      const bytes = await promise;
      if (!bytes) return controller.error(new Error('a chunk of the document is missing'));
      controller.enqueue(bytes);
      fill();
    },
  });
  return { body, ready };
}

/** A file's bytes as a stream, with its size and etag; null if there is no such file. Whole files stream as they are. */
export async function openDocument(env: Env, key: string, ownerId: string, docId: string): Promise<{ size: number; etag: string; body: ReadableStream } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const object = await env.FILES.get(key);
    if (!object) return null;
    if (!isChunked(object)) return { size: object.size, etag: object.httpEtag, body: object.body };
    const manifest = await manifestOf(object);
    const stream = chunkStream(env, ownerId, docId, manifest);
    // A save that has just replaced this version has removed its chunks: the manifest to read is the new one, so look again.
    if (await stream.ready) return { size: manifest.size, etag: object.httpEtag, body: stream.body };
    await stream.body.cancel().catch(() => {});
  }
  throw new HttpError(503, 'the document changed while it was being read; try again');
}

/** The response for a GET of a document's file (null if there is none). */
export async function documentResponse(env: Env, key: string, ownerId: string, docId: string, type: string): Promise<Response | null> {
  const file = await openDocument(env, key, ownerId, docId);
  if (!file) return null;
  return new Response(file.body, { headers: { 'content-type': type, 'content-length': String(file.size), etag: file.etag, 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff' } });
}

/** A file's bytes whole: null if there is none, 'too-large' if it is more than `limit`. */
export async function readDocument(env: Env, key: string, ownerId: string, docId: string, limit = Infinity): Promise<Uint8Array | null | 'too-large'> {
  const file = await openDocument(env, key, ownerId, docId);
  if (!file) return null;
  if (file.size > limit) {
    await file.body.cancel().catch(() => {});
    return 'too-large';
  }
  return new Uint8Array(await new Response(file.body).arrayBuffer());
}

/** The manifest of the file at a key, if it is kept as chunks (null for a whole file or none). */
export async function previousManifest(env: Env, key: string): Promise<Manifest | null> {
  const object = await env.FILES.get(key);
  if (!object) return null;
  if (!isChunked(object)) {
    await object.body.cancel().catch(() => {});
    return null;
  }
  return manifestOf(object);
}

/** Deletes chunks (all of a document's, or all but those in `keep`). */
export async function deleteChunks(env: Env, ownerId: string, docId: string, keep: ReadonlySet<string> = new Set()): Promise<void> {
  const prefix = chunkPrefix(ownerId, docId);
  let cursor: string | undefined;
  do {
    const listing = await env.FILES.list({ prefix, ...(cursor ? { cursor } : {}) });
    const doomed = listing.objects.map((o) => o.key).filter((key) => !keep.has(key.slice(prefix.length)));
    for (let i = 0; i < doomed.length; i += 1000) await env.FILES.delete(doomed.slice(i, i + 1000));
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
}

/** Deletes the named chunks. */
export async function deleteChunkList(env: Env, ownerId: string, docId: string, hashes: readonly string[]): Promise<void> {
  const keys = hashes.map((h) => chunkKey(ownerId, docId, h));
  for (let i = 0; i < keys.length; i += 1000) await env.FILES.delete(keys.slice(i, i + 1000));
}

export interface Delta {
  manifest: Manifest;
  /** Chunks the save brought, and those of the manifest before that it no longer has. */
  added: string[];
  dropped: string[];
  /** What the manifest's put answered: null when its condition failed (the file changed since). */
  written: unknown;
}

/** The delta upload's body: a 4-byte length, that many bytes of JSON `{ manifest, supplied }`, then the supplied chunks one after the other. */
function parse(body: ArrayBuffer, maxBytes: number): { manifest: Manifest; supplied: Map<string, Uint8Array> } {
  const bad = (message = 'expected a delta upload') => new HttpError(400, message);
  if (body.byteLength < 4) throw bad();
  const headerLength = new DataView(body).getUint32(0);
  if (4 + headerLength > body.byteLength) throw bad();
  let header: { manifest?: Manifest; supplied?: unknown };
  try {
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(body, 4, headerLength)));
  } catch {
    throw bad();
  }
  const manifest = header.manifest;
  const supplied = header.supplied;
  if (manifest?.algo !== ALGO || !Array.isArray(manifest.chunks) || !Number.isInteger(manifest.size) || manifest.size < 0 || !Array.isArray(supplied)) throw bad();
  if (manifest.size > maxBytes) throw new HttpError(413, 'document too large');
  let total = 0;
  const lengths = new Map<string, number>();
  for (const chunk of manifest.chunks) {
    if (typeof chunk?.h !== 'string' || !HASH.test(chunk.h) || !Number.isInteger(chunk.n) || chunk.n <= 0) throw bad();
    if (lengths.has(chunk.h) && lengths.get(chunk.h) !== chunk.n) throw bad('a chunk has two lengths');
    lengths.set(chunk.h, chunk.n);
    total += chunk.n;
  }
  if (total !== manifest.size) throw bad('the chunks do not add up to the size');
  const bytes = new Map<string, Uint8Array>();
  let offset = 4 + headerLength;
  for (const hash of supplied) {
    if (typeof hash !== 'string' || !lengths.has(hash) || bytes.has(hash)) throw bad();
    const length = lengths.get(hash)!;
    if (offset + length > body.byteLength) throw bad();
    bytes.set(hash, new Uint8Array(body, offset, length));
    offset += length;
  }
  if (offset !== body.byteLength) throw bad();
  return { manifest, supplied: bytes };
}

/**
 * Stores a delta upload: checks it, writes the chunks it brought, then the manifest (only if the file is still as `etagMatches`
 * says, when given). Every chunk the manifest names must be brought or already be in `previous` (the manifest it replaces): else it is
 * refused with the list of what is missing, and the client sends everything. Nothing is deleted here (see `Delta`).
 */
export async function applyDelta(
  env: Env,
  ownerId: string,
  docId: string,
  key: string,
  body: ArrayBuffer,
  previous: Manifest | null,
  options: { maxBytes: number; etagMatches?: string },
): Promise<Delta> {
  const { manifest, supplied } = parse(body, options.maxBytes);
  const had = new Set(previous?.chunks.map((c) => c.h));
  const missing = [...new Set(manifest.chunks.map((c) => c.h))].filter((h) => !supplied.has(h) && !had.has(h));
  if (missing.length) {
    throw new HttpError(400, 'chunks are missing', 'missing-chunks');
  }
  const entries = [...supplied];
  for (const [hash, bytes] of entries) if ((await sha256Hex(bytes)) !== hash) throw new HttpError(400, 'a chunk is not the one named');
  for (let i = 0; i < entries.length; i += AT_ONCE) {
    await Promise.all(entries.slice(i, i + AT_ONCE).map(([hash, bytes]) => env.FILES.put(chunkKey(ownerId, docId, hash), bytes, { httpMetadata: { contentType: 'application/octet-stream' } })));
  }
  const written = await env.FILES.put(key, JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { chunked: '1', size: String(manifest.size), algo: ALGO },
    ...(options.etagMatches !== undefined ? { onlyIf: { etagMatches: options.etagMatches } } : {}),
  });
  const now = new Set(manifest.chunks.map((c) => c.h));
  return { manifest, written, added: [...supplied.keys()].filter((h) => !had.has(h)), dropped: [...had].filter((h) => !now.has(h)) };
}
