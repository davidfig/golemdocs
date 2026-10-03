// A document's full-text search index: which words and tags are in which paragraphs, plus each
// paragraph's start for showing a hit. One module serves the page (an index kept in the browser
// for every document it has) and the server (one kept next to each cloud document, so a second
// computer fetches it instead of reading the document again), so both mean the same by a search.
//
// An index says nothing of which version of the document it is for: whoever keeps it stamps it.
// Paragraph numbers are `paragraphSegments`', the same the assistant and the open document use.

import type { Segment } from '../edit/segments.ts';
import { normalizeTag, readTag } from './tags.ts';

/** Bumped when the tokenizer or the format changes, so every kept index is made again. */
export const INDEX_VERSION = 2;

/** A paragraph's text is kept up to this long (for the snippet of a hit); its words are all indexed. */
const PARAGRAPH_CHARS = 400;
const MAX_PARAGRAPHS = 50_000;
const MAX_TERMS = 100_000;
const MAX_WORD_CHARS = 40;
const SNIPPET = 220;

export interface DocIndex {
  v: number;
  /** How many paragraphs the document has. */
  n: number;
  /** Each paragraph's text, cut to PARAGRAPH_CHARS. */
  p: string[];
  /** The numbers of the paragraphs that are headings. */
  h: number[];
  /** Word (lower case) -> the paragraphs it is in, in order. */
  t: Record<string, number[]>;
  /** Tag (lower case, without the `#`) -> the paragraphs it is in, in order. */
  g: Record<string, number[]>;
  /** Title of a stored document the paragraphs link to (as written in the link) -> the paragraphs it is linked from, in order. */
  l: Record<string, number[]>;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD = /[\p{L}\p{N}\p{M}]+/gu;
const ACCENTED_LATIN = /(\p{Script=Latin})\p{M}+/gu;

/** Text as it is compared: lower case, and the accents of Latin letters dropped (`café` is found by `cafe`). */
export function fold(text: string): string {
  return text.normalize('NFD').replace(ACCENTED_LATIN, '$1').normalize('NFC').toLocaleLowerCase();
}

/**
 * The searchable words of `text`: runs of letters and digits, two or more long (a lone letter finds
 * everything). Chinese, Japanese and Korean have no spaces between words, so each of their characters
 * counts, and each pair of neighbours, which is how a phrase of them is found.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const [run] of fold(text).matchAll(WORD)) {
    if (!CJK.test(run)) {
      if (run.length >= 2 && run.length <= MAX_WORD_CHARS) out.push(run);
      continue;
    }
    // Split the run into stretches of CJK characters and other letters.
    let other = '';
    const flush = () => {
      if (other.length >= 2 && other.length <= MAX_WORD_CHARS) out.push(other);
      other = '';
    };
    const chars = [...run];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]!;
      if (!CJK.test(c)) {
        other += c;
        continue;
      }
      flush();
      out.push(c);
      if (i + 1 < chars.length && CJK.test(chars[i + 1]!)) out.push(c + chars[i + 1]!);
    }
    flush();
  }
  return out;
}

const isHeading = (s: Segment): boolean => /^(title|subtitle|heading)/i.test(s.style ?? '');

function note(map: Record<string, number[]>, key: string, paragraph: number, limit: { left: number }): void {
  if (key === '__proto__') return; // would set the object's prototype, not a word
  const list = Object.hasOwn(map, key) ? map[key]! : undefined;
  if (!list) {
    if (limit.left <= 0) return;
    limit.left--;
    map[key] = [paragraph];
  } else if (list[list.length - 1] !== paragraph) list.push(paragraph);
}

/** The index of a document's paragraphs. */
export function buildIndex(segments: readonly Segment[]): DocIndex {
  const index: DocIndex = { v: INDEX_VERSION, n: segments.length, p: [], h: [], t: {}, g: {}, l: {} };
  const room = { left: MAX_TERMS };
  const count = Math.min(segments.length, MAX_PARAGRAPHS);
  for (let k = 0; k < count; k++) {
    const segment = segments[k]!;
    index.p.push(segment.text.length > PARAGRAPH_CHARS ? segment.text.slice(0, PARAGRAPH_CHARS) : segment.text);
    if (isHeading(segment)) index.h.push(k);
    for (const word of tokenize(segment.text)) note(index.t, word, k, room);
    for (const title of segment.links ?? []) note(index.l, title, k, room);
    for (let at = segment.text.indexOf('#'); at >= 0; at = segment.text.indexOf('#', at + 1)) {
      const tag = readTag(segment.text, at);
      if (!tag) continue;
      note(index.g, normalizeTag(tag.name), k, room);
      at = tag.end - 1;
    }
  }
  return index;
}

export interface ParsedQuery {
  /** The words, as `tokenize` makes them (those of quoted phrases too). */
  words: string[];
  /** The tags asked for (lower case, without the `#`). */
  tags: string[];
  /** Quoted phrases, as `normalizePhrase` makes them: they have to be in one paragraph, in this order. */
  phrases: string[];
  /** Words and tags (lower case) the document must not have. */
  not: { words: string[]; tags: string[] };
}

/** Text as phrases are compared: folded, with everything between words one space. */
export function normalizePhrase(text: string): string {
  return fold(text).replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
}

/**
 * A search as typed. Words all have to be in the document (anywhere); `"two words"` has to be in one
 * paragraph as written; `#plan` is a tag (and finds `#plan/q3` too); `-word` and `-#plan` leave out the
 * documents that have them (at the start or after a space: `well-known` is one word).
 */
export function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = { words: [], tags: [], phrases: [], not: { words: [], tags: [] } };
  let rest = query.replace(/["“”]([^"“”]+)["“”]/g, (_, phrase: string) => {
    const normal = normalizePhrase(phrase);
    if (normal.length >= 2 && !parsed.phrases.includes(normal)) parsed.phrases.push(normal);
    return ` ${phrase} `;
  });
  rest = rest.replace(/(^|\s)-(\S+)/g, (_, space: string, word: string) => {
    if (word.startsWith('#')) {
      const tag = readTag(word, 0);
      if (tag) parsed.not.tags.push(normalizeTag(tag.name));
    } else parsed.not.words.push(...tokenize(word));
    return space;
  });
  let plain = '';
  let last = 0;
  for (let at = rest.indexOf('#'); at >= 0; at = rest.indexOf('#', at + 1)) {
    // A tag being typed (`#pl`) counts as it is; one with no letter yet (`#`) is nothing.
    const tag = readTag(rest, at);
    if (!tag) continue;
    plain += `${rest.slice(last, at)} `;
    last = tag.end;
    at = tag.end - 1;
    const name = normalizeTag(tag.name);
    if (!parsed.tags.includes(name)) parsed.tags.push(name);
  }
  plain += rest.slice(last);
  parsed.words = [...new Set(tokenize(plain))];
  return parsed;
}

export interface IndexHit {
  /** Higher is a better match. */
  score: number;
  /** The paragraph that matches best, and the stretch of its text around the match. */
  paragraph: number;
  text: string;
  /** How many paragraphs match. */
  paragraphs: number;
}

/** The paragraphs a word is in: the word itself, and (as a search is typed) any word that starts with it. */
function wordParagraphs(index: DocIndex, word: string): Set<number> | null {
  let found: Set<number> | null = null;
  for (const key of Object.keys(index.t)) {
    if (key !== word && !key.startsWith(word)) continue;
    found ??= new Set();
    for (const k of index.t[key]!) found.add(k);
  }
  return found;
}

/** The paragraphs a tag is in: the tag itself, and the tags inside it (`#work` is also in `#work/plans`). */
function tagParagraphs(index: DocIndex, tag: string): Set<number> | null {
  let found: Set<number> | null = null;
  for (const key of Object.keys(index.g)) {
    if (key !== tag && !key.startsWith(`${tag}/`)) continue;
    found ??= new Set();
    for (const k of index.g[key]!) found.add(k);
  }
  return found;
}

/** `text` cut to a short stretch around the first of `words` in it. */
function excerpt(text: string, words: readonly string[], tags: readonly string[]): string {
  if (text.length <= SNIPPET) return text;
  const lower = fold(text);
  const spots = [...words, ...tags.map((t) => `#${t}`)].map((w) => lower.indexOf(w)).filter((i) => i >= 0);
  const at = spots.length ? Math.min(...spots) : 0;
  // Folding can change a text's length (a decomposed accent), so the spot is only near.
  const from = Math.max(0, Math.min(at, Math.max(0, text.length - SNIPPET)) - 60);
  return `${from > 0 ? '…' : ''}${text.slice(from, from + SNIPPET)}${from + SNIPPET < text.length ? '…' : ''}`;
}

/**
 * How well a document matches a search, or null when it doesn't: every word has to be in its text (or
 * its `name`, found by words too) and every tag has to be used in it. The best paragraph is the one with
 * the most of them, a heading winning a tie.
 */
export function searchIndex(index: DocIndex, query: ParsedQuery, name = ''): IndexHit | null {
  if (!query.words.length && !query.tags.length) return null;
  // What the document must not have (whole words: `-car` keeps `carpet`).
  for (const word of query.not.words) if (Object.hasOwn(index.t, word)) return null;
  for (const tag of query.not.tags) if (tagParagraphs(index, tag)) return null;
  const foldedName = fold(name);
  const matches = new Map<number, number>();
  let score = 0;
  for (const word of query.words) {
    const inName = foldedName.includes(word);
    const found = wordParagraphs(index, word);
    if (!found && !inName) return null;
    if (inName) score += 5;
    if (found) for (const k of found) matches.set(k, (matches.get(k) ?? 0) + 1);
  }
  for (const tag of query.tags) {
    const found = tagParagraphs(index, tag);
    if (!found) return null;
    for (const k of found) matches.set(k, (matches.get(k) ?? 0) + 1);
  }
  // A phrase is in a paragraph that has all its words and, in the text kept, the phrase itself. Only the start of a long
  // paragraph is kept, so a phrase that may be further along is given the benefit of the doubt.
  for (const phrase of query.phrases) {
    let candidates = null as Set<number> | null;
    for (const word of tokenize(phrase)) {
      const found = wordParagraphs(index, word);
      if (!found) return null;
      candidates = candidates ? new Set([...candidates].filter((k) => found.has(k))) : new Set(found);
    }
    const there = [...(candidates ?? [])].filter((k) => {
      const text = index.p[k] ?? '';
      return normalizePhrase(text).includes(phrase) || text.length >= PARAGRAPH_CHARS;
    });
    if (!there.length) return null;
    for (const k of there) matches.set(k, (matches.get(k) ?? 0) + 2);
  }
  const headings = new Set(index.h);
  let best = -1;
  let bestScore = 0;
  for (const [k, n] of matches) {
    const here = n * 3 + (headings.has(k) ? 2 : 0);
    score += here;
    if (here > bestScore || (here === bestScore && k < best)) {
      best = k;
      bestScore = here;
    }
  }
  if (!matches.size) return { score, paragraph: 0, text: '', paragraphs: 0 };
  return { score, paragraph: best, text: excerpt(index.p[best] ?? '', query.words, query.tags), paragraphs: matches.size };
}

/** The tags a document uses, each with how many paragraphs have it (as written lower case). */
export function tagsOf(index: DocIndex): Map<string, number> {
  return new Map(Object.entries(index.g).map(([tag, at]) => [tag, at.length]));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const out = source.pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** An index as bytes (compressed JSON), for keeping it in the cloud. */
export async function encodeIndex(index: DocIndex): Promise<Uint8Array> {
  return pipe(new TextEncoder().encode(JSON.stringify(index)), new CompressionStream('gzip'));
}

/** The index in `bytes`, or null when they aren't one (damaged, or made by another version). */
export async function decodeIndex(bytes: Uint8Array): Promise<DocIndex | null> {
  try {
    const value = JSON.parse(new TextDecoder().decode(await pipe(bytes, new DecompressionStream('gzip')))) as DocIndex;
    if (value?.v !== INDEX_VERSION || !Array.isArray(value.p) || !Array.isArray(value.h) || typeof value.t !== 'object' || typeof value.g !== 'object' || value.t === null || value.g === null || typeof value.l !== 'object' || value.l === null) return null;
    return value;
  } catch {
    return null;
  }
}
