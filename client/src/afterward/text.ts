// The piece as the readers read it, and finding their quotes in it again (docs/afterward.md). Pure, so it is tested without a
// browser. Paragraph texts come from the layout worker (`ReaderText`): one character per model position, U+FFFC for anything
// that isn't text (comment markers, pictures), so an index in the text is an offset in the paragraph.

import type { ReaderText } from '../layout/protocol.ts';

const OBJECT = '￼';

/** A prose paragraph the readers read: its number in the piece (from 1) and its index among the document's paragraphs. */
export interface Para {
  n: number;
  index: number;
  text: string;
}

export interface Piece {
  /** Headings and numbered paragraphs, in order. */
  blocks: ({ heading: string } | Para)[];
  paragraphs: Para[];
}

/** Lists of references at the end aren't part of what a reader reads. */
const END_MATTER = /^(further reading|references|sources|bibliography|notes|works cited|endnotes)$/i;

/** Visible text: objects dropped, runs of white space made one space. */
export function visible(text: string): string {
  return text.replaceAll(OBJECT, '').replace(/\s+/g, ' ').trim();
}

/** The paragraphs a reader reads: prose, not headings, empty lines, tables or what follows a references heading. */
export function pieceOf(text: ReaderText, range: { from: number; to: number } = { from: 0, to: text.paragraphs.length }): Piece {
  const blocks: Piece['blocks'] = [];
  const paragraphs: Para[] = [];
  for (let index = range.from; index < range.to; index++) {
    const p = text.paragraphs[index];
    const shown = visible(p.text);
    if (!shown || p.table) continue;
    if (p.heading > 0) {
      if (END_MATTER.test(shown)) break;
      blocks.push({ heading: shown });
      continue;
    }
    const para = { n: paragraphs.length + 1, index, text: shown };
    paragraphs.push(para);
    blocks.push(para);
  }
  return { blocks, paragraphs };
}

// --- Chapters: how a long piece is read, one at a time ---------------------------------------------------------------------

/** A piece longer than this (in words) is read a chapter at a time; a shorter one is read whole. */
export const LONG_WORDS = 6000;
/** A long piece with no chapter headings is read in parts of about this many words. */
export const PART_WORDS = 4000;

/** A chapter: its title ('' for none), and the document paragraphs it covers, [from, to). */
export interface Chapter {
  title: string;
  from: number;
  to: number;
  words: number;
}

const wordsIn = (text: string): number => (visible(text).match(/\S+/g) ?? []).length;

/**
 * A long piece's chapters. The chapter headings are those of the highest level that appears at least twice (a lone title
 * above the chapters isn't one); what comes before the first is a chapter of its own when it holds any prose. A piece with
 * no such headings is cut into parts of about PART_WORDS words, between paragraphs. Titles of parts are left '' for the
 * caller to name.
 */
export function chaptersOf(text: ReaderText): Chapter[] {
  const counts = new Map<number, number>();
  for (const p of text.paragraphs) if (p.heading > 0 && visible(p.text)) counts.set(p.heading, (counts.get(p.heading) ?? 0) + 1);
  const level = [...counts.entries()].filter(([, n]) => n >= 2).map(([l]) => l).sort((a, b) => a - b)[0];
  const out: Chapter[] = [];
  const close = (to: number) => {
    const last = out[out.length - 1];
    if (last) last.to = to;
  };
  if (level !== undefined) {
    out.push({ title: '', from: 0, to: 0, words: 0 });
    for (let i = 0; i < text.paragraphs.length; i++) {
      const p = text.paragraphs[i];
      if (p.heading === level && visible(p.text)) {
        close(i);
        out.push({ title: visible(p.text), from: i, to: i, words: 0 });
      }
    }
    close(text.paragraphs.length);
  } else {
    let start = 0;
    let words = 0;
    for (let i = 0; i < text.paragraphs.length; i++) {
      words += wordsIn(text.paragraphs[i].text);
      if (words >= PART_WORDS && i + 1 < text.paragraphs.length) {
        out.push({ title: '', from: start, to: i + 1, words: 0 });
        start = i + 1;
        words = 0;
      }
    }
    out.push({ title: '', from: start, to: text.paragraphs.length, words: 0 });
  }
  for (const c of out) for (let i = c.from; i < c.to; i++) if (!text.paragraphs[i].heading) c.words += wordsIn(text.paragraphs[i].text);
  return out.filter((c) => c.words > 0 || c.title);
}

/** The words of prose in the whole piece. */
export function wordsOf(text: ReaderText): number {
  return text.paragraphs.reduce((n, p) => n + (p.heading || p.table ? 0 : wordsIn(p.text)), 0);
}

/**
 * What a reading of the paragraph at `index` covers: the whole piece when it is short, else the chapter it is in, with
 * the chapters before it (what a reader has read by then). `chapter` is null for a short piece.
 */
export function scopeOf(text: ReaderText, index: number): { range: { from: number; to: number }; chapter: Chapter | null; before: Chapter[] } {
  if (wordsOf(text) <= LONG_WORDS) return { range: { from: 0, to: text.paragraphs.length }, chapter: null, before: [] };
  const chapters = chaptersOf(text);
  const at = Math.max(0, chapters.findIndex((c) => index >= c.from && index < c.to));
  const chapter = chapters[at];
  return { range: { from: chapter.from, to: chapter.to }, chapter, before: chapters.slice(0, at) };
}

/** A chapter's text as a reader remembers it: headings and paragraphs, unnumbered (context, not for comments). */
export function plainChapter(text: ReaderText, chapter: Chapter): string {
  const out: string[] = [];
  for (let i = chapter.from; i < chapter.to; i++) {
    const p = text.paragraphs[i];
    const shown = visible(p.text);
    if (!shown || p.table) continue;
    out.push(p.heading ? `## ${shown}` : shown);
  }
  return out.join('\n\n');
}

/** The piece for the model: headings marked, prose paragraphs numbered. */
export function numbered(piece: Piece): string {
  return piece.blocks.map((b) => ('heading' in b ? `## ${b.heading}` : `[${b.n}] ${b.text}`)).join('\n\n');
}

/** Folds what a quote may change: case, curly quotes and dashes, Markdown emphasis. */
function fold(ch: string): string {
  if (/[‘’‚‛′`]/.test(ch)) return "'";
  if (/[“”„‟″«»]/.test(ch)) return '"';
  if (/[‐‑‒–—―]/.test(ch)) return '-';
  if (ch === '…') return '...';
  return ch.toLowerCase();
}

/** A text folded for matching, with each folded character's position in the original. Objects, emphasis marks and extra white space drop out. */
function folded(text: string): { text: string; at: number[] } {
  let out = '';
  const at: number[] = [];
  let space = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === OBJECT || ch === '*' || ch === '_') continue;
    if (/\s/.test(ch)) {
      if (!space) {
        out += ' ';
        at.push(i);
      }
      space = true;
      continue;
    }
    space = false;
    for (const f of fold(ch)) {
      out += f;
      at.push(i);
    }
  }
  if (out.endsWith(' ')) {
    out = out.slice(0, -1);
    at.pop();
  }
  return { text: out, at };
}

/**
 * Where a quote is in a paragraph's text, as [from, to) offsets: exact first, then ignoring case, quotes, dashes, emphasis and
 * spacing. A quote cut short with "..." matches from its start to its end. Null when it isn't there.
 */
export function findQuote(text: string, quote: string): [number, number] | null {
  let q = quote.trim();
  // Quotes around the whole quote are the reader's, not the writer's.
  if (/^["“'‘]/.test(q) && /["”'’]$/.test(q) && text.indexOf(q) < 0) q = q.slice(1, -1).trim();
  if (!q) return null;
  const exact = text.indexOf(q);
  if (exact >= 0) return [exact, exact + q.length];
  const hay = folded(text);
  const parts = folded(q).text.split(/\s*\.\.\.\s*/).filter(Boolean);
  if (!parts.length) return null;
  const start = hay.text.indexOf(parts[0]);
  if (start < 0) return null;
  let end = start + parts[0].length;
  for (const part of parts.slice(1)) {
    const next = hay.text.indexOf(part, end);
    if (next < 0) break;
    end = next + part.length;
  }
  return [hay.at[start], hay.at[end - 1] + 1];
}

/**
 * Where to comment for a reader's quote in paragraph `n` of the piece: the quote if it is found there (or, failing that, in a
 * paragraph next to it), else the whole paragraph.
 */
export function anchorFor(piece: Piece, text: ReaderText, n: number, quote: string): { paragraph: number; from: number; to: number } | null {
  const at = piece.paragraphs.findIndex((p) => p.n === n);
  const order = at < 0 ? piece.paragraphs.map((_, i) => i) : [at, at + 1, at - 1, ...piece.paragraphs.map((_, i) => i)];
  for (const i of order) {
    const para = piece.paragraphs[i];
    if (!para) continue;
    const found = findQuote(text.paragraphs[para.index].text, quote);
    if (found) return { paragraph: para.index, from: found[0], to: found[1] };
  }
  const para = piece.paragraphs[at];
  if (!para) return null;
  const raw = text.paragraphs[para.index].text;
  return { paragraph: para.index, from: 0, to: raw.length };
}

/** Whether a comment calls Afterward in (`@Afterward`, in any case). */
export function callsAfterward(comment: string): boolean {
  return /(^|\s)@afterward\b/i.test(comment);
}

/** A short, stable fingerprint of a text (to tell whether a passage changed). */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (const ch of visible(text)) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193);
  return (h >>> 0).toString(36);
}

/** The text a comment is on, as it reads now (objects dropped), or '' when its range is gone. */
export function commentedText(text: ReaderText, id: string): string {
  const c = text.comments.find((x) => x.id === id);
  if (!c) return '';
  const out: string[] = [];
  for (let i = c.start[0]; i <= c.end[0]; i++) {
    const raw = text.paragraphs[i]?.text ?? '';
    out.push(raw.slice(i === c.start[0] ? c.start[1] : 0, i === c.end[0] ? c.end[1] : raw.length));
  }
  return visible(out.join('\n'));
}

/** The whole paragraph a comment starts in, as it reads now. */
export function commentedParagraph(text: ReaderText, id: string): string {
  const c = text.comments.find((x) => x.id === id);
  return c ? visible(text.paragraphs[c.start[0]]?.text ?? '') : '';
}

/**
 * The passage the writer selected, and where to comment on it: the selection, or with none the paragraph at the caret. A
 * selection over several paragraphs is commented on in its first (a comment is on one paragraph here), and read whole.
 */
export function selectedPassage(text: ReaderText): { paragraph: number; from: number; to: number; passage: string; around: string } | null {
  const sel = text.selection;
  if (!sel) return null;
  const [p, a] = sel.start;
  const raw = text.paragraphs[p]?.text ?? '';
  if (!visible(raw)) return null;
  if (sel.start[0] === sel.end[0] && sel.start[1] === sel.end[1]) return { paragraph: p, from: 0, to: raw.length, passage: visible(raw), around: visible(raw) };
  const parts: string[] = [];
  for (let i = sel.start[0]; i <= sel.end[0]; i++) {
    const t = text.paragraphs[i]?.text ?? '';
    parts.push(t.slice(i === sel.start[0] ? sel.start[1] : 0, i === sel.end[0] ? sel.end[1] : t.length));
  }
  const passage = visible(parts.join('\n'));
  if (!passage) return null;
  return { paragraph: p, from: a, to: sel.start[0] === sel.end[0] ? sel.end[1] : raw.length, passage, around: visible(raw) };
}

/** A source's words, as the app found them: the source, its paragraph (from 0), and the text exactly as the source has it. */
export interface Verified {
  source: number;
  paragraph: number;
  text: string;
}

/**
 * Where a quote the model gave is in the sources, word for word (allowing only case, quote marks, dashes and spacing to
 * differ), looking first in the source it named. The text returned is the source's own, never the model's. Null when the
 * quote isn't there, or is too short to be worth quoting.
 */
export function verifyQuote(sources: readonly { paragraphs: readonly string[] }[], named: number, quote: string): Verified | null {
  if (visible(quote).length < 12) return null;
  const order = [named, ...sources.map((_, i) => i).filter((i) => i !== named)];
  for (const s of order) {
    const paragraphs = sources[s]?.paragraphs ?? [];
    for (let j = 0; j < paragraphs.length; j++) {
      const at = findQuote(paragraphs[j], quote);
      // Not one cut short with "...": a quote has to be whole.
      if (at && !quote.includes('...') && !quote.includes('…')) return { source: s, paragraph: j, text: visible(paragraphs[j].slice(at[0], at[1])) };
    }
  }
  return null;
}

/** Sources cut to what one request should carry: each to `each` characters of whole paragraphs, all to `total`. */
export function trimSources<T extends { paragraphs: readonly string[] }>(sources: readonly T[], each = 15_000, total = 60_000): T[] {
  let left = total;
  const out: T[] = [];
  for (const source of sources) {
    const kept: string[] = [];
    let used = 0;
    for (const p of source.paragraphs) {
      if (used + p.length > Math.min(each, left)) break;
      kept.push(p);
      used += p.length;
    }
    if (!kept.length) continue;
    out.push({ ...source, paragraphs: kept });
    left -= used;
    if (left <= 0) break;
  }
  return out;
}

/** A paragraph by its first words, for the writer, who never sees its number: “It was a slow morning…”. */
function opening(piece: Piece, n: number): string | null {
  const para = piece.paragraphs.find((p) => p.n === n);
  if (!para) return null;
  const words = para.text.split(/\s+/);
  return `“${words.slice(0, 5).join(' ').replace(/[,.;:!?]+$/, '')}${words.length > 5 ? '…' : ''}”`;
}

/**
 * What the readers wrote, with any paragraph numbers that slipped through (the prompt asks for none) put as the paragraph's
 * opening words: "paragraphs 6 and 7" becomes "the paragraphs beginning “…” and “…”". English only; numbers it can't place
 * are left.
 */
export function unnumber(text: string, piece: Piece): string {
  return text.replace(/\b(the )?(paragraphs?|¶)\s*(\d+)((?:\s*(?:,|and|or|&)\s*(?:¶\s*)?\d+)*)/gi, (whole, the: string | undefined, word: string, first: string, rest: string) => {
    const numbers = [first, ...rest.split(/[^\d]+/).filter(Boolean)].map(Number);
    const quoted = numbers.map((n) => opening(piece, n));
    if (quoted.some((q) => q === null)) return whole;
    const list = quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}` : quoted[0]!;
    const capital = !the && /^[PT]/.test(word) ? 'The' : 'the';
    return `${the ? the.replace(/^t/i, (c) => c) : `${capital} `}paragraph${quoted.length > 1 ? 's' : ''} beginning ${list}`;
  });
}
