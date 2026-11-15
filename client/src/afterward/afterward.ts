// Afterward: one reader who reviews a finished piece through the comments (docs/afterward.md). This is the lazily loaded part: it
// reads the document through the layout worker, asks the model, and writes what Afterward says as ordinary comments with
// ordinary commands, so a review is undoable, saved in every format and seen by everyone in a shared room. Only the session
// whose writer said something answers it, so two sessions never answer the same reply.

import { t } from '../i18n/index.ts';
import type { ReaderText, SelectionUpdate, WireCommand } from '../layout/protocol.ts';
import type { CommentAction, CommentAgents, MarksKey, SideMark } from '../ui/commentsPanel.ts';
import { showProgress } from '../ui/progressToast.ts';
import { showConfirm, showDialog } from '../ui/popup.ts';
import { h } from '../ui/dom.ts';
import { agentColor, agentOf, BOARD } from './authors.ts';
import { askForKey, showStartDialog } from './dialog.ts';
import { estimateBook } from './cost.ts';
import { getLocale } from '../i18n/index.ts';
import { directModel, ModelError, type ModelRequest, type ReaderModel } from './model.ts';
import {
  answerTask,
  BOOK_SCHEMA,
  bookTask,
  checkBook,
  checkJournal,
  checkReply,
  JOURNAL_SCHEMA,
  journalTask,
  journalText,
  rules,
  checkReread,
  checkReview,
  checkOutline,
  checkQueries,
  checkQuotes,
  checkStudies,
  conversationTask,
  OUTLINE_SCHEMA,
  OUTLINE_TASK,
  QUERIES_SCHEMA,
  queriesTask,
  QUOTES_SCHEMA,
  quotesTask,
  REPLY_SCHEMA,
  REREAD_SCHEMA,
  REVIEW_SCHEMA,
  rereadTask,
  reviewTask,
  type Said,
  ShapeError,
  STUDIES_SCHEMA,
  studiesTask,
  studyTask,
  system,
  type ChapterContext,
  type Review,
  type ThreadContext,
} from './prompts.ts';
import { afterwardMarksShown, onAfterwardMarks } from './marks.ts';
import { emptyRecord, getSetting, KEY_SETTING, loadRecord, saveRecord, setSetting, type ReviewRecord } from './record.ts';
import { anchorFor, callsAfterward, chaptersOf, LONG_WORDS, unnumber, commentedParagraph, commentedText, fingerprint, numbered, pieceOf, plainChapter, scopeOf, wordsOf, type Chapter, selectedPassage, trimSources, verifyQuote, visible, type Piece } from './text.ts';
import { showOutline } from './outline.ts';

type CommentInfo = SelectionUpdate['comments'][number];

export interface AfterwardHost {
  readerText(): Promise<ReaderText | null>;
  send(command: WireCommand): void;
  /** The open document's id for the review record, or null when none is open. */
  docKey(): string | null;
  docTitle(): string;
  /** The open document's comments, as the panel last heard them. */
  comments(): readonly CommentInfo[];
  /** Who this session's comments are from. */
  writer(): string;
  /** Draws the comments panel again (a note or button changed). */
  refresh(): void;
  openThread(id: string): void;
  setMarks(marks: SideMark[], key?: MarksKey | null): void;
  /** Documents of the writer's own library that the searches find (not the open one), each read whole as paragraphs. */
  findSources(queries: readonly string[]): Promise<{ name: string; paragraphs: string[] }[]>;
  /** Puts the caret at the start of a paragraph (its index among the document's). */
  goToParagraph(index: number): void;
  /** The model to ask; by default the Messages API with the key set on this device. For tests. */
  model?: () => ReaderModel;
}

/** What each attention level is called. */
const ATTENTION_KEYS = { leans_in: 'afterward.attention.leansIn', holds: 'afterward.attention.holds', drifts: 'afterward.attention.drifts', lost: 'afterward.attention.lost' } as const;

/** The ids Afterward's new comments get: decimal, as Word's are, and unlikely to be taken. */
const newId = (): string => String(1 + Math.floor(Math.random() * 0x7ffffffe));

export class Afterward implements CommentAgents {
  private record: ReviewRecord | null = null;
  private doc: string | null = null;
  /** Notes under threads: what is being worked on, or what went wrong. */
  private readonly notes = new Map<string, { text: string; error?: boolean; actions?: CommentAction[] }>();
  private readonly running = new Map<string, AbortController>();
  /** New comments written here that call Afterward in (their text), waiting for the document to report them. */
  private readonly asked: string[] = [];
  private version = 0;
  private marksTimer = 0;

  constructor(private readonly host: AfterwardHost) {
    onAfterwardMarks(() => this.layoutChanged());
  }

  /** The record of the document open now (another may have opened since the last call). */
  private sync(): void {
    const doc = this.host.docKey();
    if (doc === this.doc) return;
    // A built-in document (known only by its name) becomes a copy of the writer's own at its first edit, which a read is:
    // its review goes with it.
    const from = this.carry ?? (this.doc?.startsWith('name:') && this.record ? { name: this.doc.slice('name:'.length), record: this.record } : null);
    const carried = from && doc && !doc.startsWith('name:') && this.host.docTitle() === from.name ? from.record : null;
    this.carry = null;
    this.doc = doc;
    this.record = doc ? (loadRecord(doc) ?? carried) : null;
    if (doc && carried && this.record === carried) saveRecord(doc, carried);
  }

  /**
   * Changes the open document's review record and keeps it. Always through here, after any wait: the document may have got
   * its id in the meantime (a new or built-in document is saved as its own at its first edit), and the record goes with it.
   */
  private keep(change: (record: ReviewRecord) => void): void {
    this.sync();
    if (!this.doc) return;
    const record = (this.record ??= emptyRecord());
    change(record);
    saveRecord(this.doc, record);
  }

  /** The review of a built-in document just left, for its copy. */
  private carry: { name: string; record: ReviewRecord } | null = null;

  // --- The document ---------------------------------------------------------------------------------------------------

  /** Another document is open (or none): its review record, its marks. */
  documentChanged(): void {
    for (const c of this.running.values()) c.abort();
    this.running.clear();
    this.notes.clear();
    this.asked.length = 0;
    this.carry = this.doc?.startsWith('name:') && this.record ? { name: this.doc.slice('name:'.length), record: this.record } : null;
    this.doc = null;
    this.record = null;
    this.host.setMarks([]);
    this.changed();
  }

  /** The comments changed: a new comment written here that calls Afterward in gets its answer. */
  commentsChanged(): void {
    this.sync();
    if (!this.asked.length) return;
    const writer = this.host.writer();
    for (const c of this.host.comments()) {
      if (c.parentId || c.author !== writer) continue;
      const i = this.asked.indexOf(c.text);
      if (i < 0) continue;
      this.asked.splice(i, 1);
      void this.answer(c.id, null);
    }
  }

  /** The pages were laid out again: the marks move with their text (soon, not on every change). */
  layoutChanged(): void {
    this.sync();
    clearTimeout(this.marksTimer);
    if (!this.marksShown() || !this.record) return this.host.setMarks([]);
    this.marksTimer = window.setTimeout(() => void this.drawMarks(), 400);
  }

  // --- Commands -------------------------------------------------------------------------------------------------------

  /** Tools › Read It Afterward…: who the piece is for, then the read. */
  async start(): Promise<void> {
    this.sync();
    if (!this.host.docKey()) return;
    const text = await this.host.readerText();
    const at = text ? this.scope(text, this.caret(text)) : null;
    const note = at?.chapter ? t('afterward.dialog.chapter', { title: at.name }) : '';
    const choice = await showStartDialog(this.record?.audience ?? '', !!getSetting(KEY_SETTING), () => setSetting(KEY_SETTING, ''), note);
    if (!choice) return;
    if (choice.key) setSetting(KEY_SETTING, choice.key);
    await this.read(choice.audience);
  }

  /**
   * Afterward reads the piece (a long one, the chapter the caret is in): 3 to 5 moments become threads, each opening with a
   * question; attention is kept.
   */
  async read(audience: string): Promise<void> {
    const text = await this.host.readerText();
    const doc = this.host.docKey();
    if (!text || !doc) return;
    const { piece, system: sys, chapter, name } = this.scope(text, this.caret(text), audience);
    if (!piece.paragraphs.length) return this.complain(t('afterward.error.empty'));
    const record = this.record ?? emptyRecord();
    const progress = showProgress(chapter ? t('afterward.readingChapter', { title: name }) : t('afterward.reading'), true);
    progress.update(0, 1, t('afterward.readingDetail', { count: piece.paragraphs.length }));
    let review: Review;
    try {
      review = checkReview(await this.ask({ system: sys, task: reviewTask(record.notes), schema: REVIEW_SCHEMA, effort: 'high', maxTokens: 32000 }, progress.signal));
    } catch (e) {
      progress.close();
      if (!(e instanceof ModelError && e.kind === 'stopped')) this.complain(explain(e));
      return;
    } finally {
      progress.finish();
    }
    // The document may have changed during the read: anchor in what it is now.
    const now = (await this.host.readerText()) ?? text;
    const nowPiece = pieceOf(now, scopeOf(now, chapter ? Math.min(chapter.from, now.paragraphs.length - 1) : 0).range);
    const comments: Extract<WireCommand, { kind: 'addComments' }>['comments'] = [];
    const threads: ReviewRecord['threads'] = {};
    for (const m of review.moments) {
      const at = anchorFor(nowPiece, now, m.paragraph, m.quote);
      if (!at || !m.question) continue;
      const id = newId();
      comments.push({ ...at, id, text: unnumber(m.question, nowPiece), author: BOARD });
      const raw = now.paragraphs[at.paragraph].text;
      threads[id] = {
        kind: 'moment',
        passage: visible(raw.slice(at.from, at.to)),
        paragraph: visible(raw),
        reaction: m.reaction,
        revealed: false,
      };
    }
    this.keep((rec) => {
      rec.audience = audience;
      Object.assign(rec.threads, threads);
      this.keepAttention(rec, piece, review.attention);
    });
    if (comments.length) {
      this.host.send({ kind: 'addComments', comments });
      this.host.openThread(comments[0].id!);
    } else this.complain(t('afterward.error.nothingFound'));
    this.changed();
    this.layoutChanged();
  }

  /** Tools › Read Again: Afterward rereads; in each open thread whose passage changed, it says what changed for it. */
  async readAgain(): Promise<void> {
    this.sync();
    const record = this.record;
    const doc = this.host.docKey();
    if (!record || !doc) return this.start();
    if (!(await this.haveKey())) return;
    const text = await this.host.readerText();
    if (!text) return;
    // A long piece: the chapter the caret is in, and its threads.
    const { piece, system: sys } = this.scope(text, this.caret(text));
    const inScope = new Set(piece.paragraphs.map((p) => p.index));
    const roots = new Map(this.host.comments().map((c) => [c.id, c]));
    const changed = Object.entries(record.threads)
      .filter(([id]) => roots.has(id) && !roots.get(id)!.resolved && inScope.has(this.threadAt(text, id)))
      .map(([id, th]) => ({ id, th, after: commentedParagraph(text, id) }))
      .filter((c) => c.after && fingerprint(c.after) !== fingerprint(c.th.paragraph));
    const progress = showProgress(t('afterward.rereading'), true);
    progress.update(0, 1, changed.length ? t('afterward.rereadingDetail', { count: changed.length }) : '');
    try {
      const answer = checkReread(
        await this.ask(
          {
            system: sys,
            task: rereadTask(changed.map((c) => ({ thread: c.id, before: c.th.paragraph, after: c.after, said: this.said(c.id) })), record.notes),
            schema: REREAD_SCHEMA,
            effort: 'high',
          },
          progress.signal,
        ),
      );
      for (const th of answer.threads) if (changed.some((c) => c.id === th.thread)) this.post(th.thread, th.reply, piece);
      this.keep((rec) => {
        for (const c of changed) {
          const th = rec.threads[c.id] ?? c.th;
          th.paragraph = c.after;
          th.passage = commentedText(text, c.id) || th.passage;
          rec.threads[c.id] = th;
        }
        this.keepAttention(rec, piece, answer.attention);
      });
      if (!changed.length) this.complain(t('afterward.nothingChanged'), t('afterward.rereadDone'));
    } catch (e) {
      if (!(e instanceof ModelError && e.kind === 'stopped')) this.complain(explain(e));
    } finally {
      progress.finish();
    }
    this.layoutChanged();
  }

  /** Tools › Make Studies: two or three short exercises on the writer's own passages, each a thread. */
  async makeStudies(): Promise<void> {
    this.sync();
    const record = this.record;
    const doc = this.host.docKey();
    if (!record || !doc) return this.start();
    if (!(await this.haveKey())) return;
    const text = await this.host.readerText();
    if (!text) return;
    const { piece, system: sys } = this.scope(text, this.caret(text));
    const inScope = new Set(piece.paragraphs.map((p) => p.index));
    const threads = Object.keys(record.threads)
      .filter((id) => this.host.comments().some((c) => c.id === id) && inScope.has(this.threadAt(text, id)))
      .map((id) => ({ passage: record.threads[id].passage, said: this.said(id) }));
    const progress = showProgress(t('afterward.studying'), true);
    try {
      const studies = checkStudies(await this.ask({ system: sys, task: studiesTask(threads, record.notes), schema: STUDIES_SCHEMA, effort: 'high' }, progress.signal));
      const comments: Extract<WireCommand, { kind: 'addComments' }>['comments'] = [];
      for (const s of studies) {
        const at = anchorFor(piece, text, s.paragraph, s.quote);
        if (!at) continue;
        const id = newId();
        comments.push({ ...at, id, text: t('afterward.study', { pattern: unnumber(s.pattern, piece), exercise: unnumber(s.exercise, piece) }), author: BOARD });
        const raw = text.paragraphs[at.paragraph].text;
        const study = { kind: 'study' as const, passage: visible(raw.slice(at.from, at.to)), paragraph: visible(raw), pattern: s.pattern, exercise: s.exercise };
        this.keep((rec) => void (rec.threads[id] = study));
      }
      if (comments.length) {
        this.host.send({ kind: 'addComments', comments });
        this.host.openThread(comments[0].id!);
      }
    } catch (e) {
      if (!(e instanceof ModelError && e.kind === 'stopped')) this.complain(explain(e));
    } finally {
      progress.finish();
    }
  }

  /** Tools › Reverse Outline: what each paragraph does, shown beside the piece (again without asking while the piece is the same). */
  async outline(): Promise<void> {
    this.sync();
    const doc = this.host.docKey();
    const text = await this.host.readerText();
    if (!text || !doc) return;
    const { piece, system: sys } = this.scope(text, this.caret(text));
    if (!piece.paragraphs.length) return this.complain(t('afterward.error.empty'));
    const record = (this.record ??= emptyRecord());
    const key = fingerprint(numbered(piece));
    const kept = record.outlines?.[key];
    if (kept) return showOutline(piece, kept, (i) => this.host.goToParagraph(i));
    if (!(await this.haveKey())) return;
    const progress = showProgress(t('afterward.outlining'), true);
    try {
      const outline = checkOutline(await this.ask({ system: sys, task: OUTLINE_TASK, schema: OUTLINE_SCHEMA, effort: 'medium', maxTokens: 32000 }, progress.signal));
      this.keep((rec) => {
        // One outline a chapter, the latest kept; a chapter changed since is outlined again.
        const outlines = (rec.outlines ??= {});
        outlines[key] = outline;
        for (const k of Object.keys(outlines).slice(0, -40)) delete outlines[k];
      });
      progress.close();
      showOutline(piece, outline, (i) => this.host.goToParagraph(i));
    } catch (e) {
      progress.close();
      if (!(e instanceof ModelError && e.kind === 'stopped')) this.complain(explain(e));
    }
  }

  /**
   * Tools › Find Quotes in My Notes: passages of the writer's own library that bear on the selected passage, as a thread on
   * it. The library is searched, the documents found are read whole, and the model may only point at what is there: every
   * quote is found in its source again, and the comment holds the source's own words, never the model's.
   */
  async findQuotes(): Promise<void> {
    this.sync();
    const doc = this.host.docKey();
    const text = await this.host.readerText();
    if (!text || !doc) return;
    const at = selectedPassage(text);
    if (!at) return this.complain(t('afterward.quotes.nothingSelected'));
    if (!(await this.haveKey())) return;
    const { piece, system: sys } = this.scope(text, at.paragraph);
    const progress = showProgress(t('afterward.quotes.finding'), true);
    try {
      progress.update(0, 3, t('afterward.quotes.searching'));
      const queries = checkQueries(await this.ask({ system: sys, task: queriesTask(at.passage), schema: QUERIES_SCHEMA, effort: 'low', maxTokens: 2000 }, progress.signal));
      const sources = trimSources(await this.host.findSources(queries));
      if (!sources.length) {
        progress.close();
        return this.complain(t('afterward.quotes.noSources'));
      }
      progress.update(1, 3, t('afterward.quotes.reading', { count: sources.length }));
      const found = checkQuotes(await this.ask({ system: sys, task: quotesTask(at.passage, at.around, sources), schema: QUOTES_SCHEMA, effort: 'medium' }, progress.signal));
      const quotes: { text: string; source: string; why: string }[] = [];
      for (const q of found) {
        const verified = verifyQuote(sources, q.source - 1, q.quote);
        if (verified && !quotes.some((x) => x.text === verified.text)) quotes.push({ text: verified.text, source: sources[verified.source].name, why: unnumber(q.why, piece) });
      }
      progress.finish();
      if (!quotes.length) return this.complain(t('afterward.quotes.none', { count: sources.length }));
      const id = newId();
      this.keep((rec) => void (rec.threads[id] = { kind: 'quotes', passage: at.passage, paragraph: at.around }));
      this.host.send({
        kind: 'addComments',
        comments: [{ paragraph: at.paragraph, from: at.from, to: at.to, id, author: BOARD, text: t('afterward.quotes.intro', { count: quotes.length, names: [...new Set(quotes.map((q) => q.source))].join(', ') }) }],
      });
      for (const q of quotes) this.host.send({ kind: 'replyComment', id, author: BOARD, text: t('afterward.quotes.quote', { quote: q.text, source: q.source, why: q.why }) });
      this.host.openThread(id);
    } catch (e) {
      progress.close();
      if (!(e instanceof ModelError && e.kind === 'stopped')) this.complain(explain(e));
    }
  }

  /**
   * Tools › Read the Whole Book: Afterward reads a long piece chapter by chapter, keeping a reader's journal (what it waits
   * for, expects, cares about; where it nearly stopped), then looks back at the whole and comments on the book: dropped
   * threads, setups with no payoff, a sagging middle. It says what that costs first. The journal is kept as it goes, so a
   * stop keeps what was read, and reading again starts from the first chapter that changed.
   */
  async readBook(): Promise<void> {
    this.sync();
    const doc = this.host.docKey();
    const text = await this.host.readerText();
    if (!text || !doc) return;
    // A short piece is read whole, as any piece.
    if (wordsOf(text) <= LONG_WORDS) return this.start();
    if (!(await this.haveKey())) return;
    const chapters = chaptersOf(text);
    const names = chapters.map((c, i) => c.title || this.chapterName(c, i));
    const bodies = chapters.map((c) => plainChapter(text, c));
    const prints = bodies.map((b) => fingerprint(b));
    const old = this.record?.journal ?? [];
    let reused = 0;
    while (reused < chapters.length && old[reused]?.chapter === prints[reused]) reused++;
    const { requests, dollars } = estimateBook(bodies.map((b) => b.length), reused);
    const cost = new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(Math.max(dollars, 0.01));
    const body = h('div', {}, h('p', { text: t('afterward.book.confirm', { chapters: chapters.length, words: new Intl.NumberFormat(getLocale()).format(wordsOf(text)), requests, cost }) }));
    if (reused) body.append(h('p', { class: 'wm-hint', text: t('afterward.book.reused', { count: reused }) }));
    if (!(await showConfirm(t('afterward.book.title'), body, t('afterward.book.read')))) return;
    const record = this.record ?? emptyRecord();
    const journal = old.slice(0, reused);
    const total = chapters.length;
    const progress = showProgress(t('afterward.book.reading'), true);
    progress.startTimer();
    try {
      for (let i = reused; i < total; i++) {
        progress.update(i, total + 1, t('afterward.book.chapter', { n: i + 1, total, title: names[i] }));
        const entry = checkJournal(
          await this.ask(
            { system: rules(record.audience), task: journalTask(i + 1, total, names[i], bodies[i], journalText(journal), record.notes), schema: JOURNAL_SCHEMA, effort: 'medium', maxTokens: 4000 },
            progress.signal,
          ),
        );
        journal.push({ chapter: prints[i], title: names[i], entry });
        // Kept as it goes: a stop keeps what was read.
        this.keep((rec) => void (rec.journal = journal.slice()));
        this.layoutChanged();
      }
      progress.update(total, total + 1, t('afterward.book.lookingBack'));
      const book = checkBook(await this.ask({ system: rules(record.audience), task: bookTask(journalText(journal), total, record.notes), schema: BOOK_SCHEMA, effort: 'high', maxTokens: 16000 }, progress.signal));
      progress.finish();
      this.postBook(book, (await this.host.readerText()) ?? text);
    } catch (e) {
      progress.close();
      if (e instanceof ModelError && e.kind === 'stopped') this.complain(t('afterward.book.stopped', { n: journal.length, total }));
      else this.complain(explain(e));
    }
    this.layoutChanged();
  }

  /** The look back at the whole book, as threads: the overview on the book's first words, each moment in its chapter. */
  private postBook(book: ReturnType<typeof checkBook>, text: ReaderText): void {
    const chapters = chaptersOf(text);
    const comments: Extract<WireCommand, { kind: 'addComments' }>['comments'] = [];
    const threads: ReviewRecord['threads'] = {};
    const place = (chapter: number, quote: string) => {
      const c = chapters[Math.min(Math.max(chapter, 0), chapters.length - 1)];
      const piece = pieceOf(text, { from: c.from, to: c.to });
      return { at: anchorFor(piece, text, 1, quote), piece };
    };
    if (book.overview) {
      const { at } = place(0, '');
      if (at) {
        const id = newId();
        const raw = text.paragraphs[at.paragraph].text;
        comments.push({ ...at, id, author: BOARD, text: `${t('afterward.book.overviewTitle')}

${book.overview}` });
        threads[id] = { kind: 'book', passage: visible(raw.slice(at.from, at.to)), paragraph: visible(raw) };
      }
    }
    for (const m of book.moments) {
      const { at, piece } = place(m.chapter - 1, m.quote);
      if (!at || !m.question) continue;
      const id = newId();
      const raw = text.paragraphs[at.paragraph].text;
      comments.push({ ...at, id, author: BOARD, text: unnumber(m.question, piece) });
      threads[id] = { kind: 'moment', passage: visible(raw.slice(at.from, at.to)), paragraph: visible(raw), reaction: m.reaction, revealed: false };
    }
    this.keep((rec) => void Object.assign(rec.threads, threads));
    if (!comments.length) return this.complain(t('afterward.error.nothingFound'));
    this.host.send({ kind: 'addComments', comments });
    this.host.openThread(comments[0].id!);
    this.changed();
  }

  private marksShown(): boolean {
    return afterwardMarksShown();
  }

  // --- Conversation ---------------------------------------------------------------------------------------------------

  /** The writer replied in a thread (its first comment's id) here: Afterward answers, if the thread is its own or the reply calls it in. */
  replied(thread: string, text: string): void {
    this.sync();
    if (this.record?.threads[thread] || this.isAfterwards(thread) || callsAfterward(text)) void this.answer(thread, text);
  }

  /** The writer is adding a comment here: if it calls Afterward in, Afterward answers once the document has it. */
  commenting(text: string): void {
    this.sync();
    if (callsAfterward(text)) this.asked.push(text);
  }

  /** Afterward answers in the thread: the first answer to a moment's question brings out its reaction; a study gets a reaction to the attempt. */
  private async answer(thread: string, latest: string | null): Promise<void> {
    if (this.running.has(thread) || !(await this.haveKey())) return;
    const doc = this.host.docKey();
    const text = await this.host.readerText();
    if (!text || !doc) return;
    const record = this.record ?? emptyRecord();
    const { piece, system: sys } = this.scope(text, this.threadAt(text, thread));
    const th = record.threads[thread];
    const said = this.said(thread, latest);
    const ctx: ThreadContext = {
      passage: commentedText(text, thread) || th?.passage || '',
      paragraph: commentedParagraph(text, thread) || th?.paragraph || '',
      said,
      notes: record.notes,
    };
    let task: string;
    if (th?.kind === 'moment' && !th.revealed && th.reaction) task = answerTask(ctx, th.reaction);
    else if (th?.kind === 'study') task = studyTask(ctx, { pattern: th.pattern ?? '', exercise: th.exercise ?? '', before: th.passage });
    else task = conversationTask(ctx);
    await this.run(thread, t('afterward.replying'), async (signal) => {
      const reply = checkReply(await this.ask({ system: sys, task, schema: REPLY_SCHEMA, effort: 'medium' }, signal));
      this.post(thread, reply, piece);
      if (th?.kind === 'moment' && !th.revealed) {
        this.keep((rec) => void ((rec.threads[thread] ??= th).revealed = true));
      }
    });
  }

  /** It's on purpose: the thread is resolved, and later reads respect the choice. */
  private onPurpose(root: CommentInfo, replies: readonly CommentInfo[]): void {
    const doc = this.host.docKey();
    if (!doc) return;
    const record = (this.record ??= emptyRecord());
    const th = record.threads[root.id];
    const writer = this.host.writer();
    const why = [...replies].reverse().find((c) => c.author === writer)?.text;
    const passage = th?.passage ?? '';
    this.keep((rec) => void rec.notes.push(why ? t('afterward.note', { passage, why }) : t('afterward.noteBare', { passage })));
    this.host.send({ kind: 'resolveComment', id: root.id, resolved: true });
  }

  /** Puts Afterward's reply in the thread (none when it has nothing to say). */
  private post(thread: string, reply: string, piece: Piece): void {
    if (reply) this.host.send({ kind: 'replyComment', id: thread, text: unnumber(reply, piece), author: BOARD });
  }

  /** What has been said in a thread, oldest first, with the writer's newest comment if the document doesn't have it yet. */
  private said(thread: string, latest: string | null = null): Said[] {
    const writer = this.host.writer();
    const comments = this.host.comments().filter((c) => c.id === thread || c.parentId === thread);
    const out = comments.map((c) => {
      const agent = agentOf(c.author);
      return { who: agent ? agent.name : c.author === writer ? t('afterward.writer') : c.author || t('afterward.writer'), text: c.text };
    });
    if (latest && out[out.length - 1]?.text !== latest) out.push({ who: t('afterward.writer'), text: latest });
    return out;
  }

  /** Runs a request for a thread with a note under it (and Stop); a failure stays as a note with Try Again. */
  private async run(thread: string, label: string, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const abort = new AbortController();
    this.running.set(thread, abort);
    this.notes.set(thread, { text: label, actions: [{ label: t('afterward.stop'), run: () => abort.abort() }] });
    this.changed();
    try {
      await work(abort.signal);
      this.notes.delete(thread);
    } catch (e) {
      if (e instanceof ModelError && e.kind === 'stopped') this.notes.delete(thread);
      else
        this.notes.set(thread, {
          text: explain(e),
          error: true,
          actions: [
            {
              label: t('afterward.tryAgain'),
              run: () => {
                this.notes.delete(thread);
                void this.answer(thread, null);
              },
            },
            {
              label: t('afterward.dismiss'),
              run: () => {
                this.notes.delete(thread);
                this.changed();
              },
            },
          ],
        });
    } finally {
      this.running.delete(thread);
      this.changed();
    }
  }

  // --- CommentAgents --------------------------------------------------------------------------------------------------

  agent(author: string): { name: string; color: string; title?: string } | null {
    const who = agentOf(author);
    if (!who) return null;
    return { name: who.name, color: agentColor(who.name, who.board), ...(who.board ? { title: t('afterward.boardAbout') } : {}) };
  }

  note(thread: string): { text: string; error?: boolean; actions?: CommentAction[] } | null {
    return this.notes.get(thread) ?? null;
  }

  actions(root: CommentInfo, replies: readonly CommentInfo[]): CommentAction[] {
    if (!this.record?.threads[root.id] && !this.isAfterwards(root.id) && !replies.some((c) => agentOf(c.author))) return [];
    const out: CommentAction[] = [];
    if (!root.resolved && (this.record?.threads[root.id]?.kind ?? 'moment') === 'moment') out.push({ label: t('afterward.onPurpose'), run: () => this.onPurpose(root, replies) });
    // A thread of quotes starts with replies (the quotes): Afterward comes in once the writer says something there.
    const writer = this.host.writer();
    const asked = this.record?.threads[root.id]?.kind !== 'quotes' || replies.some((c) => c.author === writer);
    if (replies.length && asked && !this.running.has(root.id)) out.push({ label: t('afterward.askAgain'), run: () => void this.answer(root.id, null) });
    return out;
  }

  mentions(): string[] {
    return [BOARD];
  }

  key(): string {
    return String(this.version);
  }

  // --- Helpers ----------------------------------------------------------------------------------------------------------

  /** Whether a thread was started by Afterward. */
  private isAfterwards(thread: string): boolean {
    return this.host.comments().some((c) => c.id === thread && c.author === BOARD);
  }

  /** Whether there is a key to read with: asks for one when there is none. */
  private async haveKey(): Promise<boolean> {
    if (this.host.model || getSetting(KEY_SETTING)) return true;
    const key = await askForKey();
    if (key) setSetting(KEY_SETTING, key);
    return !!key;
  }

  private ask(request: ModelRequest, signal?: AbortSignal): Promise<unknown> {
    const model = this.host.model?.() ?? directModel(getSetting(KEY_SETTING));
    if (!this.host.model && !getSetting(KEY_SETTING)) return Promise.reject(new ModelError('key', 'no key'));
    return model.ask(request, signal);
  }

  /**
   * What a reading at the paragraph `index` covers, and its system prompt: the whole piece when it is short; for a long one,
   * the chapter it is in, with the chapters before it as what the reader has read (the most recent, when they'd be too much).
   */
  private scope(text: ReaderText, index: number, audience = this.record?.audience ?? ''): { piece: Piece; system: ReturnType<typeof system>; chapter: Chapter | null; name: string } {
    const scope = scopeOf(text, index);
    const piece = pieceOf(text, scope.range);
    let chapter: ChapterContext | null = null;
    const name = scope.chapter ? scope.chapter.title || this.chapterName(scope.chapter, scope.before.length) : '';
    if (scope.chapter) {
      const before = scope.before.map((c, i) => ({ title: c.title || this.chapterName(c, i), text: plainChapter(text, c) }));
      // About 150,000 tokens of what came before is plenty for a reader's memory; the earliest go first.
      let size = before.reduce((n, c) => n + c.text.length, 0);
      while (before.length > 1 && size > 600_000) size -= before.shift()!.text.length;
      chapter = { title: name, before };
    }
    return { piece, system: system(piece, this.host.docTitle(), audience, chapter), chapter: scope.chapter, name };
  }

  /** What to call a chapter without a heading: the opening, or a part by its number. */
  private chapterName(chapter: Chapter, index: number): string {
    return chapter.from === 0 && index === 0 ? t('afterward.opening') : t('afterward.part', { n: index + 1 });
  }

  /** The paragraph the caret is in (where a reading of "this chapter" starts from). */
  private caret(text: ReaderText): number {
    return text.selection?.start[0] ?? 0;
  }

  /** The paragraph a thread is on. */
  private threadAt(text: ReaderText, thread: string): number {
    return text.comments.find((c) => c.id === thread)?.start[0] ?? this.caret(text);
  }

  /** Keeps the attention of the paragraphs just read, in place of what was kept for them (other chapters' stays). */
  private keepAttention(record: ReviewRecord, piece: Piece, attention: Review['attention']): void {
    for (const p of piece.paragraphs) delete record.attention[fingerprint(p.text)];
    for (const a of attention) {
      const para = piece.paragraphs.find((p) => p.n === a.paragraph);
      if (!para) continue;
      record.attention[fingerprint(para.text)] = { level: a.level, note: a.note };
    }
  }

  private async drawMarks(): Promise<void> {
    const record = this.record;
    if (!record || !this.marksShown()) return this.host.setMarks([]);
    // (Below: a dot a paragraph read, and a chapter dot for each chapter of a whole-book read.)
    const text = await this.host.readerText();
    if (!text) return this.host.setMarks([]);
    const marks: SideMark[] = [];
    for (const para of pieceOf(text).paragraphs) {
      const seen = record.attention[fingerprint(para.text)];
      const place = text.paragraphs[para.index].place;
      if (!seen || !place) continue;
      marks.push({ page: place[0], y: place[1], dots: [{ level: seen.level, title: `${t(ATTENTION_KEYS[seen.level])}. ${seen.note}` }] });
    }
    // A whole-book read: a larger dot a chapter, on its heading, for how the chapter held as a whole.
    const journal = record.journal ?? [];
    if (journal.length && wordsOf(text) > LONG_WORDS) {
      chaptersOf(text).forEach((c, i) => {
        const kept = journal[i];
        const place = text.paragraphs[c.from]?.place;
        if (!kept || !place || kept.chapter !== fingerprint(plainChapter(text, c))) return;
        marks.push({ page: place[0], y: place[1], dots: [{ level: kept.entry.attention, kind: 'chapter', title: `${kept.title}: ${t(ATTENTION_KEYS[kept.entry.attention])}. ${kept.entry.note}` }] });
      });
    }
    const key: MarksKey = {
      levels: (['leans_in', 'holds', 'drifts', 'lost'] as const).map((level) => ({ level, label: t(ATTENTION_KEYS[level]) })),
    };
    this.host.setMarks(marks, key);
  }

  private changed(): void {
    this.version++;
    this.host.refresh();
  }

  private complain(text: string, title = t('afterward.title')): void {
    showDialog(title, h('p', { text }));
  }
}

/** What went wrong, in plain words. */
export function explain(e: unknown): string {
  if (e instanceof ShapeError) return t('afterward.error.shape');
  if (e instanceof ModelError) {
    if (e.kind === 'other') return t('afterward.error.other', { message: e.message });
    return t(`afterward.error.${e.kind}`);
  }
  return t('afterward.error.other', { message: e instanceof Error ? e.message : String(e) });
}
