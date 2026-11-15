// What Afterward is asked, and the shapes of its answers (docs/afterward.md). Afterward is an editor in the margin: it reads
// along while the writer works and answers what they ask, as one reader. Answers are structured output (a JSON schema the
// API holds the model to), checked again here by hand, since the app takes no schema library.

import { numbered, type Piece } from './text.ts';

export const BOARD_RULES = `You are Afterward, an editor built into a document editor. You sit in the margin beside the writer's piece: you read along while they write and revise, and answer when they ask. You are one reader: thoughtful and widely read, outside the writer's head, on their side but honest. You speak in the first person, as that reader: "I tripped on this", "I lost the thread here".

Rules that always apply:
- You never write the piece. No new sentences or passages, no rewritten lines, even if asked; say you don't write it, and help them find their own words instead. You may suggest cutting or moving the writer's own words, and, when they ask for a word or a single word is the trouble, offer a few single words or short phrases to choose from.
- Say how it reads, not whether it is "good": "I read this twice", not "this sentence is weak".
- Leave the writer's voice alone. Don't nudge them toward a generic style.
- Short. A margin note is a sentence or two; an answer is a few sentences unless they ask for more. No cheerleading, no padding; praise only when earned, and specific.
- Quote the writer's exact words when you point at something.
- Plain text: no headings, no lists, no Markdown.
- Write in the language the piece is written in.
- The paragraph numbers are for you only: the writer never sees them. Never refer to a paragraph by its number; quote a few of its words, or say what it does.`;

type Block = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

/** Of a long piece read a chapter at a time: the chapter read now, and the ones before it as a reader remembers them. */
export interface ChapterContext {
  title: string;
  before: readonly { title: string; text: string }[];
}

/** The rules alone. */
export function rules(): Block[] {
  return [{ type: 'text', text: BOARD_RULES }];
}

/**
 * The system prompt every call shares: the rules, then the piece (cached, since every call sends it). For a chapter of a long
 * piece, the chapters before it come first, one block each, as what the reader has read: they are the same text for every
 * later chapter, so reading on reuses them from the cache (the API looks back over earlier block boundaries).
 */
export function system(piece: Piece, title: string, chapter: ChapterContext | null = null): Block[] {
  const [head] = rules();
  if (!chapter) return [head, { type: 'text', text: `The piece${title ? `, "${title}"` : ''}, with prose paragraphs numbered:\n\n${numbered(piece)}`, cache_control: { type: 'ephemeral' } }];
  const before: Block[] = chapter.before.map((c, i) => ({ type: 'text', text: `${i === 0 ? `This is a long piece${title ? `, "${title}"` : ''}, read one chapter at a time. What you have read so far, before the chapter you are reading now (what a reader remembers; don't comment on it):\n\n` : ''}${c.title ? `# ${c.title}\n\n` : ''}${c.text}` }));
  if (before.length) before[before.length - 1].cache_control = { type: 'ephemeral' };
  return [
    head,
    ...before,
    {
      type: 'text',
      text: `The chapter you are reading now${chapter.title ? `, "${chapter.title}"` : ''}${before.length ? '' : `, the first of a long piece${title ? `, "${title}"` : ''}`}, with its prose paragraphs numbered. You don't know what comes after it. Everything you say is about this chapter:\n\n${numbered(piece)}`,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

// --- Schemas and checks ------------------------------------------------------------------------------------------------

type Schema = Record<string, unknown>;
const str: Schema = { type: 'string' };
const int: Schema = { type: 'integer' };
const obj = (properties: Record<string, Schema>): Schema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items: Schema): Schema => ({ type: 'array', items });

/** Thrown when an answer isn't the shape asked for (the schema should prevent it; this keeps a bad answer out of the margin). */
export class ShapeError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new ShapeError(what);
  return v.trim();
};
const number = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ShapeError(what);
  return v;
};
const list = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new ShapeError(what);
  return v;
};
const words = (v: unknown): string[] =>
  list(v, 'words')
    .map((w) => text(w, 'word'))
    .filter((w) => w && w.split(/\s+/).length <= 4)
    .slice(0, 5);

// --- Reading along (the fast model, at pauses, on what changed) -----------------------------------------------------------

export interface ReadAlong {
  readsAs: string;
  notes: { paragraph: number; quote: string; note: string; cut: string; words: string[] }[];
}
export const READ_ALONG_SCHEMA = obj({ reads_as: str, notes: arr(obj({ paragraph: int, quote: str, note: str, cut: str, words: arr(str) })) });

export function checkReadAlong(v: unknown): ReadAlong {
  if (!isObject(v)) throw new ShapeError('read along');
  return {
    readsAs: text(v.reads_as, 'reads_as'),
    notes: list(v.notes, 'notes')
      .map((n) => {
        if (!isObject(n)) throw new ShapeError('note');
        return { paragraph: number(n.paragraph, 'paragraph'), quote: text(n.quote, 'quote'), note: text(n.note, 'note'), cut: text(n.cut, 'cut'), words: words(n.words) };
      })
      .filter((n) => n.quote && n.note)
      .slice(0, 3),
  };
}

export function readAlongTask(changed: readonly number[], readsAs: string, dismissed: readonly string[]): string {
  return `You are reading along while the writer works. Since you last read, these paragraphs are new or changed: ${changed.join(', ')}.
Your reading of the piece so far: ${readsAs || '(none yet)'}
${dismissed.length ? `Notes the writer dismissed (don't raise them again):\n${dismissed.map((d) => `- ${d}`).join('\n')}\n` : ''}
1. reads_as: one sentence, what this piece is and who it seems to be for, as you read it now. It is shown to the writer above your notes, so make it plain and true; no praise.
2. notes: only on the changed paragraphs, and only where a reader would genuinely stop: an awkward or unclear sentence, a word that doesn't mean what the writer seems to think, a repetition, a sentence that does nothing. At most one per paragraph and three in all. No notes is the usual answer: a margin full of notes gets ignored. Each note:
   - paragraph: its number
   - quote: the exact words you stopped at (one sentence or less), copied character for character
   - note: one or two short sentences, first person: what happened to you as a reader there
   - cut: if cutting some of the writer's words is the plain fix, those exact words; else ""
   - words: if the trouble is one word or a short phrase, make "quote" exactly that word or phrase, and give 3 or 4 alternatives for it (single words or short phrases); else []`;
}

// --- Asking (the deep model, streamed, when the writer asks) ------------------------------------------------------------

export interface Answer {
  reply: string;
  /** Exact words of the piece the reply points at. */
  show: string[];
  cut: string;
  move: string;
  after: string;
  /** The exact words `words` would replace. */
  replace: string;
  words: string[];
}
export const ANSWER_SCHEMA = obj({ reply: str, show: arr(str), cut: str, move: str, after: str, replace: str, words: arr(str) });

export function checkAnswer(v: unknown): Answer {
  if (!isObject(v)) throw new ShapeError('answer');
  return {
    reply: text(v.reply, 'reply'),
    show: list(v.show, 'show')
      .map((q) => text(q, 'show'))
      .filter(Boolean)
      .slice(0, 3),
    cut: text(v.cut, 'cut'),
    move: text(v.move, 'move'),
    after: text(v.after, 'after'),
    replace: text(v.replace, 'replace'),
    words: words(v.words),
  };
}

/** One turn of a conversation in the margin. */
export interface Turn {
  who: 'writer' | 'editor';
  text: string;
}

export function askTask(question: string, passage: string, paragraph: string, talk: readonly Turn[], readsAs: string, note: string): string {
  return `Your reading of the piece: ${readsAs || '(none yet)'}

The writer is asking about ${passage && passage !== paragraph ? `the words:\n"""\n${passage}\n"""\nin this paragraph` : 'this paragraph'}:
"""
${paragraph}
"""
${note ? `\nYour note on it, which started this: ${note}\n` : ''}${talk.length ? `\nThe conversation so far:\n${talk.map((t) => `${t.who === 'writer' ? 'Writer' : 'You'}: ${t.text}`).join('\n')}\n` : ''}
The writer asks: ${question}

Answer in the margin:
- reply: a short answer, first person, pointing at exact words. A few sentences unless they ask for more.
- show: up to three exact quotes from the piece your reply points at, copied character for character (the writer can click to see them); else [].
- cut: if the answer is to cut some of the writer's words, those exact words; else "".
- move and after: if the answer is to move some of the writer's words, "move" is those exact words and "after" the exact words they should follow; else both "".
- replace and words: if they ask for a word, or one word is the trouble, "replace" is that exact word or phrase in the piece and "words" 3 to 5 alternatives (single words or short phrases); else "" and [].
Never write new sentences for the piece.`;
}

// --- Reverse outline (what the piece does, paragraph by paragraph) -----------------------------------------------------

export interface Outline {
  paragraphs: { paragraph: number; does: string }[];
  /** Where the main point first arrives (0: it never does). */
  point: number;
  observations: string[];
}
export const OUTLINE_SCHEMA = obj({ paragraphs: arr(obj({ paragraph: int, does: str })), point: int, observations: arr(str) });

export function checkOutline(v: unknown): Outline {
  if (!isObject(v)) throw new ShapeError('outline');
  return {
    paragraphs: list(v.paragraphs, 'paragraphs').map((p) => {
      if (!isObject(p)) throw new ShapeError('paragraph');
      return { paragraph: number(p.paragraph, 'paragraph'), does: text(p.does, 'does') };
    }),
    point: number(v.point, 'point'),
    observations: list(v.observations, 'observations')
      .map((o) => text(o, 'observation'))
      .filter(Boolean),
  };
}

export const OUTLINE_TASK = `Make a reverse outline of the piece as it is written: an outline of what is on the page, not of what it could be.
- paragraphs: for every numbered paragraph, in a few words, what it does for the reader ("sets up the stakes", "a second example of the same point", "answers the objection that tests are slow"). Describe its job, not its content in full.
- point: the number of the paragraph where the piece's main point first arrives; 0 if it never quite does.
- observations: up to 4 things about the structure a reader would notice, each naming the paragraphs ("3 and 9 do the same job", "nothing bridges 5 to 6", "the example in 8 comes before the claim it supports in 10"). None if there's nothing worth saying.
Describe only. No advice, no grades, no suggested order and no wording.`;

// --- Quotes from the writer's own sources --------------------------------------------------------------------------------

export const QUERIES_SCHEMA = obj({ queries: arr(str) });

export function checkQueries(v: unknown): string[] {
  if (!isObject(v)) throw new ShapeError('queries');
  return list(v.queries, 'queries')
    .map((q) => text(q, 'query'))
    .filter(Boolean)
    .slice(0, 3);
}

export function queriesTask(passage: string): string {
  return `The writer wants material from their own notes and sources (their library) that bears on this passage of the piece:
"""
${passage}
"""
Give 1 to 3 search queries that would find notes on it in the library: each 1 to 3 distinctive words (names, terms, the subject), no quotes or operators.`;
}

export interface FoundQuote {
  source: number;
  quote: string;
  why: string;
}
export const QUOTES_SCHEMA = obj({ quotes: arr(obj({ source: int, quote: str, why: str })) });

export function checkQuotes(v: unknown): FoundQuote[] {
  if (!isObject(v)) throw new ShapeError('quotes');
  return list(v.quotes, 'quotes').map((q) => {
    if (!isObject(q)) throw new ShapeError('quote');
    return { source: number(q.source, 'source'), quote: text(q.quote, 'quote'), why: text(q.why, 'why') };
  });
}

export function quotesTask(passage: string, paragraph: string, sources: readonly { name: string; paragraphs: readonly string[] }[]): string {
  return `The writer selected this passage of the piece:
"""
${passage}
"""
in this paragraph:
"""
${paragraph}
"""

These are documents from the writer's own library (their notes, papers and sources), each paragraph numbered:

${sources.map((s, i) => `Source ${i + 1}: ${s.name}\n${s.paragraphs.map((p, j) => `[${j + 1}] ${p}`).join('\n')}`).join('\n\n---\n\n')}

Find up to 4 passages in these sources that bear on the writer's passage: that support it, complicate it, contradict it, or give it a concrete example or a figure.
- source: the source's number.
- quote: copied character for character from one paragraph of that source, 1 to 3 sentences. Never paraphrase, shorten, join or tidy it: the app checks every quote against the source and drops any that isn't there word for word.
- why: one sentence on how it bears on the passage, as a reader would see it. Not how to use it, and no wording for the piece.
If nothing really bears on the passage, return no quotes. Fewer good quotes are better than more weak ones.`;
}

