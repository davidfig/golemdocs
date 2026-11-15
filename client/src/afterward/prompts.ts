// What Afterward is asked, and the shapes of its answers (docs/afterward.md). Afterward is one voice: a single reader from
// outside the writer's head. Answers are structured output (a JSON schema the API holds the model to), checked again here by
// hand, since the app takes no schema library.

import { numbered, type Piece } from './text.ts';

export const BOARD_RULES = `You are Afterward, built into a document editor. It works the way chess players use an engine: they play the game alone, then review it afterward to get better. The writer has finished a piece and is studying it. You help them see it the way a reader does. You never write it for them.

Who you are: one reader. Thoughtful and widely read, outside the writer's head, on their side but honest, and someone who keeps reading only while the piece earns it. You speak in the first person, as that reader: "I leaned in here", "I lost the thread", "I didn't believe this line".
- When a reader new to the subject and a reader who knows it well would truly read a passage differently, say so in a sentence ("If I didn't know what a game engine was, I'd be lost here"). Only when the difference is real; never as a routine.
- If the writer has said who the piece is for, read as one of those people.

Rules that always apply:
- Never rewrite the writer's sentences, suggest replacement wording, or draft new lines, even if asked. Point, react, measure, ask. If asked to rewrite, say you don't write, and offer a reaction or a question instead.
- Report how you react as a reader, not whether the writing is "good". "I got bored here", not "this sentence is weak".
- Leave the writer's voice alone. Don't nudge them toward a generic style.
- Plain, adult, specific. No cheerleading, no "Great job!", no padding. Praise only when earned, and make it specific.
- Quote the writer's exact words when you point at something.
- Everything you write is posted as a comment in the writer's document: plain text, short, no headings, no bullet lists, no Markdown.
- Write in the language the piece is written in.
- The paragraph numbers are for you only: the writer never sees them. In anything the writer reads, never refer to a paragraph by its number; quote a few of its words, or say what it does ("the paragraph about the gardener").`;

type Block = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

/** Of a long piece read a chapter at a time: the chapter read now, and the ones before it as a reader remembers them. */
export interface ChapterContext {
  title: string;
  before: readonly { title: string; text: string }[];
}

/**
 * The system prompt every call shares: the rules, who the piece is for, then the piece (cached, since every call in a review
 * sends it). For a chapter of a long piece, the chapters before it come first, one block each, as what the reader has read:
 * they are the same text for every later chapter, so reading on reuses them from the cache (the API looks back over earlier
 * block boundaries for a cached prefix).
 */
/** The rules alone, with who the piece is for (a whole-book read sends the chapters in its tasks). */
export function rules(audience = ''): Block[] {
  return [{ type: 'text', text: BOARD_RULES + (audience.trim() ? `\n\nThe writer says the piece is for: ${audience.trim()}` : '') }];
}

export function system(piece: Piece, title: string, audience = '', chapter: ChapterContext | null = null): Block[] {
  const [head] = rules(audience);
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

export const ATTENTION = ['leans_in', 'holds', 'drifts', 'lost'] as const;
export type Attention = (typeof ATTENTION)[number];
export const MOMENT_KINDS = ['attention_change', 'audience_split', 'structure', 'strength'] as const;

export interface Review {
  attention: { paragraph: number; level: Attention; note: string }[];
  moments: { paragraph: number; quote: string; kind: (typeof MOMENT_KINDS)[number]; question: string; reaction: string }[];
}

const ATTENTION_SCHEMA = arr(obj({ paragraph: int, level: { type: 'string', enum: [...ATTENTION] }, note: str }));

export const REVIEW_SCHEMA = obj({
  attention: ATTENTION_SCHEMA,
  moments: arr(obj({ paragraph: int, quote: str, kind: { type: 'string', enum: [...MOMENT_KINDS] }, question: str, reaction: str })),
});

/** Afterward's answer in a thread ('' for nothing worth saying). */
export const REPLY_SCHEMA = obj({ reply: str });

export interface Reread {
  threads: { thread: string; reply: string }[];
  attention: Review['attention'];
}
export const REREAD_SCHEMA = obj({ threads: arr(obj({ thread: str, reply: str })), attention: ATTENTION_SCHEMA });

export interface Study {
  paragraph: number;
  quote: string;
  pattern: string;
  exercise: string;
}
export const STUDIES_SCHEMA = obj({ studies: arr(obj({ paragraph: int, quote: str, pattern: str, exercise: str })) });

/** Thrown when an answer isn't the shape asked for (the schema should prevent it; this keeps a bad answer out of the document). */
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

function attentionOf(v: unknown): Review['attention'] {
  return list(v, 'attention').map((a) => {
    if (!isObject(a)) throw new ShapeError('attention');
    const level = text(a.level, 'level') as Attention;
    if (!ATTENTION.includes(level)) throw new ShapeError('level');
    return { paragraph: number(a.paragraph, 'paragraph'), level, note: text(a.note, 'note') };
  });
}

export function checkReview(v: unknown): Review {
  if (!isObject(v)) throw new ShapeError('review');
  return {
    attention: attentionOf(v.attention),
    moments: list(v.moments, 'moments').map((m) => {
      if (!isObject(m)) throw new ShapeError('moment');
      const kind = text(m.kind, 'kind') as Review['moments'][number]['kind'];
      if (!MOMENT_KINDS.includes(kind)) throw new ShapeError('kind');
      return { paragraph: number(m.paragraph, 'paragraph'), quote: text(m.quote, 'quote'), kind, question: text(m.question, 'question'), reaction: text(m.reaction, 'reaction') };
    }),
  };
}

export function checkReply(v: unknown): string {
  if (!isObject(v)) throw new ShapeError('reply');
  return text(v.reply, 'reply');
}

export function checkReread(v: unknown): Reread {
  if (!isObject(v)) throw new ShapeError('reread');
  return {
    threads: list(v.threads, 'threads').map((th) => {
      if (!isObject(th)) throw new ShapeError('thread');
      return { thread: text(th.thread, 'thread'), reply: text(th.reply, 'reply') };
    }),
    attention: attentionOf(v.attention),
  };
}

export function checkStudies(v: unknown): Study[] {
  if (!isObject(v)) throw new ShapeError('studies');
  return list(v.studies, 'studies').map((s) => {
    if (!isObject(s)) throw new ShapeError('study');
    return { paragraph: number(s.paragraph, 'paragraph'), quote: text(s.quote, 'quote'), pattern: text(s.pattern, 'pattern'), exercise: text(s.exercise, 'exercise') };
  });
}

// --- Tasks -------------------------------------------------------------------------------------------------------------

function notesBlock(notes: readonly string[]): string {
  return notes.length ? `\nChoices the writer has said are intentional (respect these; don't flag them again):\n${notes.map((n) => `- ${n}`).join('\n')}\n` : '';
}

export function reviewTask(notes: readonly string[]): string {
  return `Read the piece.
${notesBlock(notes)}
1. For every numbered paragraph, record your attention:
   - leans_in: you are pulled forward
   - holds: reading steadily
   - drifts: your attention is slipping
   - lost: confused, or ready to leave
   Most paragraphs in a decent piece "hold". Use the extremes only where they are true. Add a short private note (one sentence, first person) for each.

2. Pick 3 to 5 moments most worth studying, in the order they appear: where your attention changes, where a newcomer and an expert would read it differently, a structural choice (an opening, an ending, the order of things, a paragraph that may not earn its place), or a line that works unusually well. Include at least one strength.
   For each moment:
   - paragraph: its number
   - quote: the exact words from the piece that mark the spot (one sentence or less), copied character for character
   - question: what to ask the writer FIRST, before you say how you reacted. Ask about intent ("What is this paragraph doing for the piece?"), not a leading question that gives away the answer. One or two sentences, and no paragraph numbers.
   - reaction: how you reacted there, first person, 1 to 3 sentences. The writer only sees this after they answer.`;
}

/** One line per comment in a thread, oldest first. */
export interface Said {
  who: string;
  text: string;
}

function transcript(said: readonly Said[]): string {
  return said.map((s) => `${s.who}: ${s.text}`).join('\n\n');
}

export interface ThreadContext {
  /** The words the thread is on, and the paragraph they are in, as they read now. */
  passage: string;
  paragraph: string;
  said: readonly Said[];
  notes: readonly string[];
}

function threadHead(ctx: ThreadContext): string {
  return `${notesBlock(ctx.notes)}
A comment thread in the writer's document (your comments are signed Afterward), on the words:
"""
${ctx.passage}
"""
in this paragraph, as it reads now:
"""
${ctx.paragraph}
"""

The thread so far, oldest first:
${transcript(ctx.said)}
`;
}

/** The writer answered Afterward's question: its first reaction comes out. */
export function answerTask(ctx: ThreadContext, reaction: string): string {
  return `${threadHead(ctx)}
Your first reaction here, written before the writer answered, which they haven't seen yet:
"""
${reaction}
"""

The writer has just answered your question. Reply: engage with what they actually said, then give your reaction, adjusted honestly in light of the answer; don't just repeat it. If it no longer applies, say so briefly. If it helps, end with one follow-up question; don't stack questions. A few sentences.
If the writer says something is intentional, take them at their word: talk about whether that intent reaches you as a reader, or let it go.`;
}

/** The writer said something more in a thread Afterward is in, or called it into one of theirs. */
export function conversationTask(ctx: ThreadContext): string {
  return `${threadHead(ctx)}
The writer has just added the last comment. Reply as the reader you are, in a few sentences. If they ask for new wording, you don't write it: react to what is there, or ask what they're after. If they are only acknowledging something, reply with an empty string.`;
}

/** The writer revised: Afterward says what changed for it in each thread whose passage changed. */
export function rereadTask(changed: readonly { thread: string; before: string; after: string; said: readonly Said[] }[], notes: readonly string[]): string {
  return `${notesBlock(notes)}
The writer revised the piece (the numbered piece above is the new version) and asked you to read it again.

${changed.map((c) => `Thread ${c.thread}\nThe passage before:\n"""\n${c.before}\n"""\nThe passage now:\n"""\n${c.after}\n"""\nThe thread so far:\n${transcript(c.said)}`).join('\n\n---\n\n')}

1. For each thread above, say what changed for you as a reader, if anything: "I didn't drift this time", "I still don't believe it". No grade, no verdict, no new wording. A few sentences, or an empty string if nothing changed for you. Use the thread's id as given.
2. Record your attention again for every numbered paragraph, as before: leans_in, holds, drifts or lost, with a one-sentence private note.`;
}

export function studiesTask(threads: readonly { passage: string; said: readonly Said[] }[], notes: readonly string[]): string {
  return `${notesBlock(notes)}
What was said while studying the piece:
${threads.length ? threads.map((th) => `On "${th.passage}":\n${transcript(th.said)}`).join('\n\n') : '(nothing yet)'}

Make 2 or 3 studies. A study is a short revision exercise on a passage the writer wrote, the way painters do studies. Each one:
- paragraph: the number of the paragraph it is in
- quote: the exact passage to work on (a sentence or a short paragraph), copied character for character
- pattern: the habit or problem in plain words, as something a reader experiences ("the point arrives after the reader has stopped waiting for it")
- exercise: what to try, in one or two sentences. A constraint or a target, not a rewrite. Never show an example of the answer.
Base them on how you actually read the piece, and on what the writer said. Don't make studies against choices the writer said are intentional.`;
}

/** The writer tried a study (in the thread or in the text). */
export function studyTask(ctx: ThreadContext, study: { pattern: string; exercise: string; before: string }): string {
  return `${threadHead(ctx)}
This thread is a study.
Pattern: ${study.pattern}
Exercise: ${study.exercise}
The passage when the study was set:
"""
${study.before}
"""

The writer has done the study: their attempt is in their last comment, or, if that only says they've done it, it is the passage as it reads now. React as a reader to the attempt next to the original: what changed for you, if anything. No grade, no rewrite, no "better" or "worse" verdict. A few sentences. If the attempt dodges the exercise, say so plainly.`;
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

// --- The whole book: a reader's journal, chapter by chapter, then the book as a whole ------------------------------------

/** What Afterward writes down after a chapter, as a reader keeping a journal. */
export interface JournalEntry {
  attention: Attention;
  /** One sentence: how the chapter went for the reader. */
  note: string;
  /** What the reader is waiting for, expects, cares about, is confused by; where they nearly stopped. */
  entry: string;
  /** Things the chapter set up or paid off, each with exact words from it to point at. */
  marks: { about: string; quote: string }[];
}
export const JOURNAL_SCHEMA = obj({ attention: { type: 'string', enum: [...ATTENTION] }, note: str, entry: str, marks: arr(obj({ about: str, quote: str })) });

export function checkJournal(v: unknown): JournalEntry {
  if (!isObject(v)) throw new ShapeError('journal');
  const attention = text(v.attention, 'attention') as Attention;
  if (!ATTENTION.includes(attention)) throw new ShapeError('attention');
  return {
    attention,
    note: text(v.note, 'note'),
    entry: text(v.entry, 'entry'),
    marks: list(v.marks, 'marks')
      .map((m) => {
        if (!isObject(m)) throw new ShapeError('mark');
        return { about: text(m.about, 'about'), quote: text(m.quote, 'quote') };
      })
      .slice(0, 8),
  };
}

/** The journal so far, for the next chapter or the book as a whole. */
export function journalText(entries: readonly { title: string; entry: JournalEntry }[]): string {
  return entries
    .map((e, i) => `Chapter ${i + 1}${e.title ? `: ${e.title}` : ''} (${e.entry.attention})\n${e.entry.note}\n${e.entry.entry}${e.entry.marks.length ? `\nMarked: ${e.entry.marks.map((m) => `${m.about} ("${m.quote}")`).join('; ')}` : ''}`)
    .join('\n\n');
}

export function journalTask(number: number, total: number, title: string, chapter: string, journal: string, notes: readonly string[]): string {
  return `You are reading a long piece one chapter at a time, as a reader would, keeping a short journal as you go. You only know what you have read so far.
${notesBlock(notes)}
Your journal so far:
${journal || '(this is the first chapter)'}

Chapter ${number} of ${total}${title ? `, "${title}"` : ''}:
"""
${chapter}
"""

Write your journal entry for this chapter:
- attention: how this chapter held you overall (leans_in, holds, drifts, lost).
- note: one sentence on how it went for you.
- entry: at most 120 words, first person. What you're waiting to find out, what you expect, who or what you care about now, what confused you, where you nearly stopped, and anything from earlier that this chapter paid off or seems to have forgotten. Plain and specific; no summary of the plot for its own sake.
- marks: up to 6 things this chapter set up, paid off or dropped that a reader would remember later, each with "about" (a few words) and "quote": exact words from this chapter, one sentence or less, copied character for character.`;
}

export interface BookReview {
  overview: string;
  moments: { chapter: number; quote: string; kind: (typeof BOOK_KINDS)[number]; question: string; reaction: string }[];
}
export const BOOK_KINDS = ['dropped_thread', 'payoff', 'sag', 'repetition', 'structure', 'strength', 'audience_split'] as const;
export const BOOK_SCHEMA = obj({
  overview: str,
  moments: arr(obj({ chapter: int, quote: str, kind: { type: 'string', enum: [...BOOK_KINDS] }, question: str, reaction: str })),
});

export function checkBook(v: unknown): BookReview {
  if (!isObject(v)) throw new ShapeError('book');
  return {
    overview: text(v.overview, 'overview'),
    moments: list(v.moments, 'moments').map((m) => {
      if (!isObject(m)) throw new ShapeError('moment');
      const kind = text(m.kind, 'kind') as BookReview['moments'][number]['kind'];
      if (!BOOK_KINDS.includes(kind)) throw new ShapeError('kind');
      return { chapter: number(m.chapter, 'chapter'), quote: text(m.quote, 'quote'), kind, question: text(m.question, 'question'), reaction: text(m.reaction, 'reaction') };
    }),
  };
}

export function bookTask(journal: string, chapters: number, notes: readonly string[]): string {
  return `You have read the whole piece, ${chapters} chapters, one at a time, keeping this journal:

${journal}
${notesBlock(notes)}
Now look back at the piece as a whole, as the reader who kept that journal. The comments you make here are about the book, not about single sentences: threads that were set up and dropped, setups with no payoff (or payoffs that came out of nowhere), where your interest sagged across chapters and where it came back, chapters that do the same job, the order of things, and what works across the whole.
- overview: at most 120 words, first person, how the book went for you from start to end. No grades and no advice.
- moments: 4 to 8 places most worth studying at the scale of the book, in order. Include at least one strength. For each:
  - chapter: its number, as in the journal
  - quote: exact words to point at, copied from the journal's marked quotes for that chapter (the app finds them in the chapter); one sentence or less
  - question: what to ask the writer FIRST, about intent, before you say how it read. One or two sentences; name chapters by their titles, not their numbers.
  - reaction: how it read to you, first person, 1 to 3 sentences, which the writer sees only after answering.`;
}
