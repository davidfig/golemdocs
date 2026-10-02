// What the assistant can do with the person's other documents: list them, search them, read parts
// of them and copy parts into the open one. This file is the pure part (turning a document into
// numbered paragraphs, ranking a search, finding a document by name); where the documents come
// from and how they are fetched is in main.ts's tools, so none of it needs a browser to test.
//
// Paragraphs are numbered from 0 in document order, as `Editor.paragraphs()` has them, so a
// number from here means the same thing it does for the open document.

import type { Segment } from '@golemdocs/docx';

export type { Segment };

/** The most one read returns, in characters, so a call can't fill the conversation. */
export const MAX_READ_CHARS = 8000;
/** The most paragraphs one copy into the open document may add. */
export const MAX_COPY = 200;
/** How many documents a search opens at most (the newest first); more than this would take too long. */
export const MAX_SCANNED = 80;
const MAX_RESULTS = 8;
const SNIPPET = 220;


/** What `read_document` shows for the same paragraph, so the model sees one format. */
const line = (s: Segment, k: number): string => `[${k}]${s.style ? ` (${s.style})` : ''}${s.list ? ` ${s.list === 'bullet' ? '•' : '1.'}` : ''} ${s.text}`;

/** A part of a document, from paragraph `start`, at most `count` paragraphs and MAX_READ_CHARS characters. */
export function readSegments(name: string, segments: readonly Segment[], start: number, count: number): string {
  if (!segments.length) return `"${name}" has no text.`;
  if (start >= segments.length) return `"${name}" has ${segments.length} paragraphs (0 to ${segments.length - 1}); there is nothing at ${start}.`;
  const out: string[] = [];
  let size = 0;
  let k = start;
  for (; k < Math.min(segments.length, start + count); k++) {
    const text = line(segments[k]!, k);
    // Always return at least one paragraph, however long.
    if (size + text.length > MAX_READ_CHARS && out.length) break;
    out.push(text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}… (cut short)` : text);
    size += text.length;
  }
  const more = k < segments.length ? ` More follows: call again with start=${k}.` : '';
  return `"${name}", paragraphs ${start} to ${k - 1} of ${segments.length}.${more}\n${out.join('\n')}`;
}

export interface Candidate {
  /** What the assistant calls it by: stable while the document exists. */
  id: string;
  name: string;
}

/** The words of a query: lower case, 2+ letters or digits, no repeats. */
export function termsOf(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
}

export interface Hit {
  id: string;
  name: string;
  score: number;
  /** The paragraph that matches best, with its number. */
  where?: { paragraph: number; text: string };
}

/** Ranks one document against the query terms; null when none of them is in its name or text. */
export function scoreDocument(terms: readonly string[], doc: Candidate, segments: readonly Segment[]): Hit | null {
  const name = doc.name.toLowerCase();
  let score = 0;
  for (const term of terms) if (name.includes(term)) score += 5;
  const found = new Set<string>();
  let best = { at: -1, terms: 0 };
  segments.forEach((s, k) => {
    const text = s.text.toLowerCase();
    let here = 0;
    for (const term of terms) {
      const at = text.indexOf(term);
      if (at < 0) continue;
      here++;
      found.add(term);
      score += 1;
    }
    // Headings say what a part is about; a match in one is worth more.
    if (here && s.style && /^(title|heading)/i.test(s.style)) score += here * 2;
    if (here > best.terms) best = { at: k, terms: here };
  });
  // Documents that have more of the different words in them beat ones that repeat one word.
  score += found.size * 3;
  if (score === 0) return null;
  const text = best.at >= 0 ? segments[best.at]!.text : '';
  return { id: doc.id, name: doc.name, score, ...(best.at >= 0 && { where: { paragraph: best.at, text: excerpt(text, terms) } }) };
}

/** `text` cut to a short stretch around the first term in it. */
function excerpt(text: string, terms: readonly string[]): string {
  if (text.length <= SNIPPET) return text;
  const lower = text.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0));
  const from = Math.max(0, (Number.isFinite(at) ? at : 0) - 60);
  return `${from > 0 ? '…' : ''}${text.slice(from, from + SNIPPET)}${from + SNIPPET < text.length ? '…' : ''}`;
}

/** The answer to a search: the matches, best first (the order given). `scanned`/`total` say how much was looked through. */
export function describeHits(query: string, hits: readonly Hit[], scanned: number, total: number): string {
  const partial = scanned < total ? ` Only the ${scanned} most recently changed of ${total} documents were searched; search again with other words, or list_documents, to look further.` : '';
  if (!hits.length) return `No document matches "${query}".${partial}`;
  const shown = hits.slice(0, MAX_RESULTS);
  const rows = shown.map((h) => `- "${h.name}" (id ${h.id})${h.where ? ` [${h.where.paragraph}] ${h.where.text}` : ' (the name matches)'}`);
  return `${hits.length === 1 ? '1 document matches' : `${hits.length} documents match`} "${query}"${hits.length > shown.length ? `; the best ${shown.length} are` : ':'}\n${rows.join('\n')}${partial}`;
}

/**
 * Which document `ref` means: an id from list_documents or search_documents, else a name (exactly,
 * ignoring case, or else as part of exactly one name). A string explaining the problem when it can't tell.
 */
export function resolveDocument<T extends Candidate>(ref: string, docs: readonly T[]): T | string {
  const wanted = ref.trim();
  if (!wanted) return 'Say which document: its id or name.';
  const byId = docs.find((d) => d.id === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  const exact = docs.filter((d) => d.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0]!;
  const stem = (name: string) => name.toLowerCase().replace(/\.[^.]*$/, '');
  const same = docs.filter((d) => stem(d.name) === lower);
  if (same.length === 1) return same[0]!;
  const part = exact.length ? exact : docs.filter((d) => d.name.toLowerCase().includes(lower));
  if (part.length === 1) return part[0]!;
  if (!part.length) return `No document is named "${wanted}". Use list_documents or search_documents to find its id.`;
  return `More than one document matches "${wanted}": ${part.slice(0, 6).map((d) => `"${d.name}" (id ${d.id})`).join(', ')}. Use the id.`;
}

/** What `list_documents` answers: the newest first, a page at a time. */
export function describeList(docs: readonly (Candidate & { updatedAt: number; place?: string })[], start: number, count: number): string {
  if (!docs.length) return 'The person has no other documents.';
  if (start >= docs.length) return `There are ${docs.length} documents; nothing at ${start}.`;
  const page = docs.slice(start, start + count);
  const rows = page.map((d) => `- "${d.name}" (id ${d.id}), ${new Date(d.updatedAt).toISOString().slice(0, 10)}${d.place ? `, ${d.place}` : ''}`);
  const end = start + page.length;
  return `Documents ${start + 1} to ${end} of ${docs.length}, newest first.${end < docs.length ? ` More follows: call again with start=${end}.` : ''}\n${rows.join('\n')}`;
}
