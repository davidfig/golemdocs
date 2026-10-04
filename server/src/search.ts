// Finding documents by what they are about: the assistant's search over a person's own cloud
// documents. Each document is cut into chunks (a section or so of text), each chunk becomes a
// vector (Workers AI embeddings) in a Vectorize index, and a search embeds the question and asks
// the index for the nearest chunks.
//
//   GET /api/assistant/search?q=…  ->  { hits: [{ id, name, score, paragraph, text }], pending }
//
// Documents are indexed when a search first needs them (and again once they have changed), a few
// per search, never on every save: an autosave would otherwise pay for the whole document again.
// `pending` is how many documents the search couldn't get to yet. Vectors live in the owner's own
// namespace, so a query only ever reaches that person's documents.
//
// Documents shared with a person aren't in the index (it could only be searched through the
// owner's namespace); the page looks through those itself.

import { readDocument } from './fileStore.ts';
import { WordDocument, isPlainText, paragraphSegments, textSegments, type Segment } from '@golemdocs/docx';
import type { AiBinding, Env } from './cf.ts';
import { HttpError } from './http.ts';
import { docxKey } from './keys.ts';
import { storedDocx } from './stored.ts';
import { subscriptionFor } from './subscriptions.ts';
import type { UserDb } from './userDb.ts';

/** Multilingual (the app is), 1024 dimensions: create the index with `--dimensions=1024 --metric=cosine`. */
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
export const DIMENSIONS = 1024;

/** A chunk is about a section: split at headings, and never longer than this (characters). */
export const MAX_CHUNK_CHARS = 1200;
/** A document is indexed up to this many chunks, so one huge file can't cost without limit. */
export const MAX_CHUNKS = 60;
/** How many documents one search may index before answering. */
export const MAX_INDEXED_PER_SEARCH = 6;
/** Documents bigger than this aren't indexed. */
const MAX_BYTES = 6_000_000;
const EMBED_BATCH = 16;
const INDEX_CONCURRENCY = 3;
const TOP_K = 40;
const MAX_HITS = 10;
const MAX_QUERY_CHARS = 300;
/** What a hit shows of its chunk (characters), kept with the vector so a search needs no document reads. */
const SNIPPET_CHARS = 280;

export interface Chunk {
  /** The paragraph it starts at. */
  start: number;
  text: string;
}

const isHeading = (s: Segment): boolean => /^(title|subtitle|heading)/i.test(s.style ?? '');

/** The document's paragraphs as chunks: a new one at each heading, and when one would pass MAX_CHUNK_CHARS. */
export function chunkSegments(segments: readonly Segment[]): Chunk[] {
  const chunks: Chunk[] = [];
  let current: Chunk | null = null;
  const flush = () => {
    if (current?.text.trim()) chunks.push(current);
    current = null;
  };
  segments.forEach((segment, k) => {
    const text = segment.text.trim();
    if (!text) return;
    if (current && isHeading(segment)) flush();
    // A paragraph longer than a chunk is cut into several.
    for (let from = 0; from < text.length; from += MAX_CHUNK_CHARS) {
      const piece = text.slice(from, from + MAX_CHUNK_CHARS);
      if (current && current.text.length + piece.length + 1 > MAX_CHUNK_CHARS) flush();
      if (current) current.text += `\n${piece}`;
      else current = { start: k, text: piece };
    }
  });
  flush();
  return chunks.slice(0, MAX_CHUNKS);
}

/** Embeddings for some texts, in order. Throws when the model doesn't answer as expected. */
export async function embed(ai: AiBinding, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const answer = (await ai.run(EMBEDDING_MODEL, { text: batch })) as { data?: unknown } | null;
    const data = answer?.data;
    if (!Array.isArray(data) || data.length !== batch.length) throw new Error('the embedding model gave an unexpected answer');
    for (const vector of data) {
      if (!Array.isArray(vector) || vector.length !== DIMENSIONS) throw new Error(`expected ${DIMENSIONS} dimensions`);
      out.push(vector as number[]);
    }
  }
  return out;
}

export interface IndexedDocument {
  id: string;
  name: string;
  updatedAt: number;
}

const vectorId = (doc: string, chunk: number) => `${doc}:${chunk}`;

/** Puts (the current version of) a document in the index, replacing whatever was there. */
export async function indexDocument(env: Env, ownerId: string, doc: IndexedDocument, bytes: Uint8Array): Promise<void> {
  const index = env.VECTORS!;
  // The app saves its own wrapper around the .docx: one with no document in it has no text to index.
  // A plain text file is kept as it is: its lines are its paragraphs.
  const docx = isPlainText(bytes) ? null : await storedDocx(bytes);
  const chunks = isPlainText(bytes) ? chunkSegments(textSegments(bytes)) : docx ? chunkSegments(paragraphSegments(await WordDocument.read(docx))) : [];
  // The name is part of what each chunk is about, and what finds a document by its title.
  const vectors = chunks.length ? await embed(env.AI!, chunks.map((c) => `${doc.name}\n${c.text}`)) : [];
  if (vectors.length) {
    await index.upsert(
      vectors.map((values, i) => ({
        id: vectorId(doc.id, i),
        values,
        namespace: ownerId,
        metadata: { doc: doc.id, start: chunks[i]!.start, text: chunks[i]!.text.slice(0, SNIPPET_CHARS) },
      })),
    );
  }
  const before = await env.DIRECTORY.prepare('SELECT chunks FROM doc_index WHERE doc_id = ?').bind(doc.id).first<{ chunks: number }>();
  // A shorter document leaves the end of the old one behind.
  if (before && before.chunks > chunks.length) await index.deleteByIds(Array.from({ length: before.chunks - chunks.length }, (_, i) => vectorId(doc.id, chunks.length + i)));
  await env.DIRECTORY.prepare('INSERT OR REPLACE INTO doc_index (doc_id, owner_id, updated_at, chunks) VALUES (?, ?, ?, ?)').bind(doc.id, ownerId, doc.updatedAt, chunks.length).run();
}

export interface SearchHit {
  id: string;
  name: string;
  /** Cosine similarity, 0 to 1. */
  score: number;
  /** The paragraph the best-matching chunk starts at, and the start of its text. */
  paragraph: number;
  text: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Documents that changed or are new and weren't indexed yet; a later search will include them. */
  pending: number;
}

/**
 * Searches `docs` (all of one owner's documents). Brings the index up to date for a few of them
 * first; `read` fetches a document's .docx bytes.
 */
export async function searchDocuments(env: Env, ownerId: string, query: string, docs: readonly IndexedDocument[], read: (id: string) => Promise<Uint8Array | null>): Promise<SearchResult> {
  if (!docs.length) return { hits: [], pending: 0 };
  const rows = await env.DIRECTORY.prepare('SELECT doc_id, updated_at FROM doc_index WHERE owner_id = ?').bind(ownerId).all<{ doc_id: string; updated_at: number }>();
  const indexedAt = new Map(rows.results.map((r) => [r.doc_id, r.updated_at]));
  const stale = docs.filter((d) => indexedAt.get(d.id) !== d.updatedAt).sort((a, b) => b.updatedAt - a.updatedAt);
  const now = stale.slice(0, MAX_INDEXED_PER_SEARCH);
  let pending = stale.length - now.length;
  let next = 0;
  const worker = async () => {
    for (let doc = now[next++]; doc; doc = now[next++]) {
      try {
        const bytes = await read(doc.id);
        if (!bytes || bytes.byteLength > MAX_BYTES) continue; // not indexable, and not worth counting as waiting
        await indexDocument(env, ownerId, doc, bytes);
      } catch (e) {
        console.error('indexing failed', doc.id, e);
        pending++;
      }
    }
  };
  await Promise.all(Array.from({ length: INDEX_CONCURRENCY }, worker));

  const [vector] = await embed(env.AI!, [query]);
  const found = await env.VECTORS!.query(vector!, { topK: TOP_K, namespace: ownerId, returnMetadata: 'all' });
  const byId = new Map(docs.map((d) => [d.id, d]));
  const best = new Map<string, SearchHit>();
  for (const match of found.matches ?? []) {
    const doc = byId.get(String(match.metadata?.doc));
    if (!doc) continue; // deleted since, or not this person's
    if ((best.get(doc.id)?.score ?? -1) >= match.score) continue;
    best.set(doc.id, { id: doc.id, name: doc.name, score: match.score, paragraph: Number(match.metadata?.start ?? 0), text: String(match.metadata?.text ?? '') });
  }
  return { hits: [...best.values()].sort((a, b) => b.score - a.score).slice(0, MAX_HITS), pending };
}

/** GET /api/assistant/search: subscribers only, over the person's own documents (`db`: their catalogue, null if none). */
export async function handleSearch(env: Env, userId: string, query: string, db: UserDb | null): Promise<SearchResult> {
  if (!env.AI || !env.VECTORS) throw new HttpError(503, 'search is not configured');
  if (!(await subscriptionFor(env, userId))?.active) throw new HttpError(402, 'the assistant is for subscribers', 'subscription');
  const text = query.trim().slice(0, MAX_QUERY_CHARS);
  if (!text) throw new HttpError(400, 'expected ?q=');
  if (!db) return { hits: [], pending: 0 };
  const rows = await db.all<{ id: string; name: string; updated_at: number }>('SELECT id, name, updated_at FROM documents');
  return searchDocuments(
    env,
    userId,
    text,
    rows.map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at })),
    async (id) => {
      // The file whole, however it is kept (see fileStore.ts); a big one is left out.
      const bytes = await readDocument(env, docxKey(userId, id), userId, id, MAX_BYTES);
      return bytes === 'too-large' ? null : bytes;
    },
  );
}

/** Takes deleted documents out of the index: a query and a delete per 50 of them, and the vectors in lists of 100. Never throws: a stray vector is only a wrong search hit. */
export async function removeManyFromIndex(env: Env, docIds: readonly string[]): Promise<void> {
  if (!env.VECTORS) return;
  for (let i = 0; i < docIds.length; i += 50) {
    const chunk = docIds.slice(i, i + 50);
    try {
      const marks = chunk.map(() => '?').join(',');
      const rows = (await env.DIRECTORY.prepare(`SELECT doc_id, chunks FROM doc_index WHERE doc_id IN (${marks})`).bind(...chunk).all<{ doc_id: string; chunks: number }>()).results;
      if (!rows.length) continue;
      const vectors = rows.flatMap((r) => Array.from({ length: r.chunks }, (_, n) => vectorId(r.doc_id, n)));
      for (let v = 0; v < vectors.length; v += 100) await env.VECTORS.deleteByIds(vectors.slice(v, v + 100));
      await env.DIRECTORY.prepare(`DELETE FROM doc_index WHERE doc_id IN (${marks})`).bind(...chunk).run();
    } catch (e) {
      console.error('search index removal failed', e);
    }
  }
}
