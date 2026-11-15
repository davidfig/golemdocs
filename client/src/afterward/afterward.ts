// Afterward: an editor in the margin (docs/afterward.md). It reads along while the writer works (a fast model, at pauses, on
// what changed), leaves a few short notes beside the sentences a reader would stop at, and answers what the writer asks about
// a selection, streamed, beside it. It never writes the piece: a note may suggest cutting or moving the writer's own words, or
// offer a few words to choose from, and nothing changes until the writer accepts. The notes live in the comments panel's
// margin but not in the document; pinning one makes it an ordinary comment. This is the lazily loaded part.

import { t } from '../i18n/index.ts';
import type { ReaderText, SelectionUpdate, WireCommand } from '../layout/protocol.ts';
import { readerIcon, type AgentCard, type CommentAction, type CommentAgents } from '../ui/commentsPanel.ts';
import { CLOSE_ICON, h, iconButton } from '../ui/dom.ts';
import { showDialog } from '../ui/popup.ts';
import { showProgress } from '../ui/progressToast.ts';
import { agentColor, agentOf, BOARD } from './authors.ts';
import { askForKey } from './dialog.ts';
import { onReadAlong, readAlongOn } from './marks.ts';
import { costOf, directModel, FAST_MODEL, ModelError, partialField, type ModelRequest, type ReaderModel, type Usage } from './model.ts';
import { debugFlags, onDebugFlagsChange } from '../debug.ts';
import { showOutline } from './outline.ts';
import {
  ANSWER_SCHEMA,
  askTask,
  checkAnswer,
  checkOutline,
  checkQueries,
  checkQuotes,
  checkReadAlong,
  OUTLINE_SCHEMA,
  OUTLINE_TASK,
  QUERIES_SCHEMA,
  queriesTask,
  QUOTES_SCHEMA,
  quotesTask,
  READ_ALONG_SCHEMA,
  readAlongTask,
  ShapeError,
  system,
  type ChapterContext,
} from './prompts.ts';
import { emptyRecord, getSetting, KEY_SETTING, loadRecord, saveRecord, setSetting, type EditorNote, type ReviewRecord } from './record.ts';
import { cutRange, fingerprint, locateNote, numbered, pieceOf, plainChapter, scopeOf, selectedPassage, trimSources, unnumber, verifyQuote, visible, type Chapter, type Piece } from './text.ts';

type CommentInfo = SelectionUpdate['comments'][number];
type Mark = { paragraph: number; from: number; to: number; kind: number };

export interface AfterwardHost {
  readerText(): Promise<ReaderText | null>;
  send(command: WireCommand): void;
  /** The open document's id for its record, or null when none is open. */
  docKey(): string | null;
  docTitle(): string;
  comments(): readonly CommentInfo[];
  /** Draws the comments panel again (a card changed). */
  refresh(): void;
  /** Places the panel's cards again (one grew), without drawing them again. */
  reflow(): void;
  /** The editor's marks on the text (kinds as in overlayColors.ts SQUIGGLE_COLORS). */
  marks(marks: Mark[]): void;
  /** Documents of the writer's own library that the searches find (not the open one), each read whole as paragraphs. */
  findSources(queries: readonly string[]): Promise<{ name: string; paragraphs: string[] }[]>;
  /** Puts the caret at the start of a paragraph (its index among the document's). */
  goToParagraph(index: number): void;
  /** Selects [from, to) of a paragraph (and brings it into view). */
  select(paragraph: number, from: number, to: number): void;
  /** Replaces [from, to) of a paragraph with `text` ('' cuts), as the writer's own edit (Undo takes it back). */
  replace(paragraph: number, from: number, to: number, text: string): void;
  /** The model to ask; by default the Messages API with the key set on this device. For tests. */
  model?: () => ReaderModel;
}

/** How long the writer must stop typing before the editor reads what changed. */
const PAUSE_MS = 3500;
/** A paragraph shorter than this (in words) isn't worth reading along yet. */
const MIN_WORDS = 6;

/** Icons for the open card (12 × 12, stroked, as the app's others): a pin, and an arrow up to send. */
const PIN_ICON = 'M4 1.5h4M5 1.5v3.5L3 7h6L7 5V1.5M6 7v3.5';
const SEND_ICON = 'M6 10.5V2M2.5 5.5L6 2l3.5 3.5';

/** A token count, short: 812, 4.3k, 1.2M. */
const tokens = (n: number): string => (n < 1000 ? String(n) : n < 1_000_000 ? (n / 1000).toFixed(1) + 'k' : (n / 1_000_000).toFixed(1) + 'M');

const newId = (): string => String(1 + Math.floor(Math.random() * 0x7ffffffe));

export class Afterward implements CommentAgents {
  private record: ReviewRecord | null = null;
  private doc: string | null = null;
  private carry: { name: string; record: ReviewRecord } | null = null;
  private version = 0;
  /** The text as last read from the worker, and where each note is in it. */
  private text: ReaderText | null = null;
  private readonly places = new Map<string, { index: number; from: number; to: number }>();
  /** The note open in the margin, and what's typed in each note's box. */
  private active: string | null = null;
  private readonly drafts = new Map<string, string>();
  private focusNote: string | null = null;
  /** Answers streaming in, by note: the element the text goes in, and Stop. */
  private readonly streaming = new Map<string, { el: HTMLElement; abort: AbortController }>();
  private readonly errors = new Map<string, string>();
  /** Notes whose whole conversation is shown (the rest show the last two turns). */
  private readonly expanded = new Set<string>();
  /** A passage the editor pointed at, lit for a moment. */
  private flash: Mark | null = null;
  private refreshTimer = 0;
  private readTimer = 0;
  private reading: AbortController | null = null;
  private paused = '';
  /** What the editor has used on the writer's key since the page loaded (Admin › Debug › Token use). */
  private readonly used = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, dollars: 0, last: '' };

  constructor(private readonly host: AfterwardHost) {
    onReadAlong(() => this.layoutChanged());
    onDebugFlagsChange(() => this.changed());
  }

  // --- The document ---------------------------------------------------------------------------------------------------

  /** The record of the document open now (another may have opened since the last call). */
  private sync(): void {
    const doc = this.host.docKey();
    if (doc === this.doc) return;
    // A built-in document (known only by its name) becomes a copy of the writer's own at its first edit: its notes go with it.
    const from = this.carry ?? (this.doc?.startsWith('name:') && this.record ? { name: this.doc.slice('name:'.length), record: this.record } : null);
    const carried = from && doc && !doc.startsWith('name:') && this.host.docTitle() === from.name ? from.record : null;
    this.carry = null;
    this.doc = doc;
    this.record = doc ? (loadRecord(doc) ?? carried) : null;
    if (doc && carried && this.record === carried) saveRecord(doc, carried);
  }

  /** Changes the open document's record and keeps it (after any wait: the document may have got its id in the meantime). */
  private keep(change: (record: ReviewRecord) => void): void {
    this.sync();
    if (!this.doc) return;
    const record = (this.record ??= emptyRecord());
    change(record);
    saveRecord(this.doc, record);
  }

  /** Another document is open (or none). */
  documentChanged(): void {
    this.reading?.abort();
    for (const s of this.streaming.values()) s.abort.abort();
    this.streaming.clear();
    this.errors.clear();
    this.active = null;
    this.carry = this.doc?.startsWith('name:') && this.record ? { name: this.doc.slice('name:'.length), record: this.record } : null;
    this.doc = null;
    this.record = null;
    this.text = null;
    this.places.clear();
    this.host.marks([]);
    this.changed();
  }

  commentsChanged(): void {
    this.sync();
  }

  /** The text was laid out again (an edit, mostly): find the notes again soon, and read along after a pause. */
  layoutChanged(): void {
    this.sync();
    clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => void this.locate(), 300);
    clearTimeout(this.readTimer);
    if (readAlongOn() && this.doc && (getSetting(KEY_SETTING) || this.host.model)) this.readTimer = window.setTimeout(() => void this.readAlong(), PAUSE_MS);
    else if (!readAlongOn()) this.paused = '';
  }

  /** Finds every note in the text as it reads now; a note whose words are gone fades, unless the writer talked with it. */
  private async locate(): Promise<void> {
    const text = await this.host.readerText();
    this.text = text;
    this.places.clear();
    const record = this.record;
    if (!text || !record) {
      this.host.marks([]);
      return this.changed();
    }
    const gone: string[] = [];
    for (const note of record.notes) {
      const at = locateNote(text, note.quote, note.paragraph);
      if (at) this.places.set(note.id, at);
      else if (!note.talk.length && !this.streaming.has(note.id)) gone.push(note.id);
    }
    if (gone.length) this.keep((rec) => void (rec.notes = rec.notes.filter((n) => !gone.includes(n.id))));
    this.drawMarks();
    this.changed();
  }

  /** The marks on the text: a dotted line under each note's words; the open note's suggestion shown as a preview. */
  private drawMarks(): void {
    const marks: Mark[] = [];
    const text = this.text;
    for (const note of this.record?.notes ?? []) {
      const at = this.places.get(note.id);
      if (!at || !text) continue;
      const raw = text.paragraphs[at.index].text;
      const open = note.id === this.active;
      const find = (words: string) => (words ? locateNote(text, words, fingerprint(raw)) : null);
      const cut = open && note.cut ? find(note.cut) : null;
      const move = open && note.move ? find(note.move) : null;
      if (cut) marks.push({ paragraph: cut.index, from: cut.from, to: cut.to, kind: 3 });
      else if (move) marks.push({ paragraph: move.index, from: move.from, to: move.to, kind: 4 });
      else if (note.quote) marks.push({ paragraph: at.index, from: at.from, to: at.to, kind: 2 });
    }
    if (this.flash) marks.push(this.flash);
    this.host.marks(marks);
  }

  // --- Reading along ------------------------------------------------------------------------------------------------------

  /** At a pause: the fast model reads what changed (in the chapter the caret is in, for a long piece) and may leave a note or two. */
  private async readAlong(): Promise<void> {
    if (this.reading || !readAlongOn() || (!getSetting(KEY_SETTING) && !this.host.model)) return;
    const text = await this.host.readerText();
    if (!text || !this.doc) return;
    const { piece, system: sys } = this.scope(text, text.selection?.start[0] ?? 0);
    const record = this.record ?? emptyRecord();
    const read = new Set(record.read);
    const changed = piece.paragraphs.filter((p) => !read.has(fingerprint(p.text)) && p.text.split(/\s+/).length >= MIN_WORDS);
    if (!changed.length) return;
    this.reading = new AbortController();
    try {
      const answer = checkReadAlong(
        await this.ask({ system: sys, task: readAlongTask(changed.map((p) => p.n), record.readsAs, record.dismissed.slice(-30)), schema: READ_ALONG_SCHEMA, effort: 'low', maxTokens: 2000, model: FAST_MODEL }, this.reading.signal, 'read along'),
      );
      this.paused = '';
      const now = (await this.host.readerText()) ?? text;
      const fresh: EditorNote[] = [];
      for (const n of answer.notes) {
        const para = piece.paragraphs.find((p) => p.n === n.paragraph);
        if (!para || !changed.includes(para)) continue;
        if (!locateNote(now, n.quote, fingerprint(para.text))) continue;
        fresh.push({ id: newId(), quote: n.quote, paragraph: fingerprint(para.text), note: unnumber(n.note, piece), from: 'read', ...(n.cut && { cut: n.cut }), ...(n.words.length && { replace: n.quote, words: n.words }), talk: [], at: Date.now() });
      }
      const changedPrints = new Set(changed.map((p) => fingerprint(p.text)));
      const changedAt = new Set(changed.map((p) => p.index));
      this.keep((rec) => {
        rec.readsAs = answer.readsAs || rec.readsAs;
        // The old notes from reading along on a paragraph read again give way to what was read now (where it was made, or
        // where it is now: the paragraph's text changed, so its fingerprint did too); a conversation stays.
        const stale = (n: EditorNote) => n.from === 'read' && !n.talk.length && (changedPrints.has(n.paragraph) || changedAt.has(this.places.get(n.id)?.index ?? -1));
        const kept = rec.notes.filter((n) => !stale(n));
        // A note on words already noted isn't added twice.
        rec.notes = kept.concat(fresh.filter((f) => !kept.some((n) => n.quote && n.quote === f.quote)));
        rec.read = [...rec.read, ...changedPrints].slice(-3000);
      });
      void this.locate();
    } catch (e) {
      if (!(e instanceof ModelError && e.kind === 'stopped')) {
        this.paused = explain(e);
        this.changed();
      }
    } finally {
      this.reading = null;
    }
  }

  // --- Asking -------------------------------------------------------------------------------------------------------------

  /** Tools › Ask the Editor: a box in the margin beside the selection (or the paragraph at the caret), to ask about it. */
  async askAbout(): Promise<void> {
    this.sync();
    const text = await this.host.readerText();
    if (!text || !this.host.docKey()) return;
    const at = selectedPassage(text);
    if (!at) return this.complain(t('afterward.quotes.nothingSelected'));
    if (!(await this.haveKey())) return;
    const raw = text.paragraphs[at.paragraph].text;
    const whole = at.from === 0 && at.to === raw.length;
    const note: EditorNote = { id: newId(), quote: whole ? '' : visible(raw.slice(at.from, at.to)), paragraph: fingerprint(raw), note: '', from: 'ask', talk: [], at: Date.now() };
    // An empty question box left from before goes; the new one opens.
    this.keep((rec) => void (rec.notes = rec.notes.filter((n) => n.note || n.talk.length || n.quotes).concat(note)));
    this.text = text;
    this.places.set(note.id, { index: at.paragraph, from: at.from, to: at.to });
    this.open(note.id, true);
  }

  /** Sends what's typed in a note's box: the deep model answers, streamed into the card. */
  private async send(id: string): Promise<void> {
    const question = (this.drafts.get(id) ?? '').trim();
    const note = this.record?.notes.find((n) => n.id === id);
    if (!question || !note || this.streaming.has(id)) return;
    if (!(await this.haveKey())) return;
    const text = this.text ?? (await this.host.readerText());
    const at = this.places.get(id);
    if (!text || !at) return;
    this.drafts.delete(id);
    this.errors.delete(id);
    const raw = text.paragraphs[at.index].text;
    const { piece, system: sys } = this.scope(text, at.index);
    const before = note.talk;
    const talk = [...before, { who: 'writer' as const, text: question }];
    this.keep((rec) => {
      const n = rec.notes.find((x) => x.id === id);
      if (n) n.talk = talk;
    });
    const abort = new AbortController();
    const el = h('p', { class: 'wm-editor-reply wm-editor-streaming', text: t('afterward.replying') });
    this.streaming.set(id, { el, abort });
    this.changed();
    try {
      const answer = checkAnswer(
        await this.ask(
          {
            system: sys,
            task: askTask(question, note.quote || visible(raw), visible(raw), before, this.record?.readsAs ?? '', note.note),
            schema: ANSWER_SCHEMA,
            effort: 'medium',
            maxTokens: 8000,
            onText: (soFar) => {
              const reply = partialField(soFar, 'reply');
              if (reply) {
                el.textContent = reply;
                this.host.reflow();
              }
            },
          },
          abort.signal,
          'ask',
        ),
      );
      this.keep((rec) => {
        const n = rec.notes.find((x) => x.id === id);
        if (!n) return;
        n.talk = [...talk, { who: 'editor', text: unnumber(answer.reply, piece) }];
        n.show = answer.show;
        n.cut = answer.cut || undefined;
        n.move = answer.move && answer.after ? answer.move : undefined;
        n.after = answer.move && answer.after ? answer.after : undefined;
        n.replace = answer.words.length && answer.replace ? answer.replace : undefined;
        n.words = answer.words.length && answer.replace ? answer.words : undefined;
      });
    } catch (e) {
      if (!(e instanceof ModelError && e.kind === 'stopped')) this.errors.set(id, explain(e));
      // The question goes back in the box, to send again.
      this.drafts.set(id, question);
      this.keep((rec) => {
        const n = rec.notes.find((x) => x.id === id);
        if (n) n.talk = before;
      });
    } finally {
      this.streaming.delete(id);
      this.focusNote = id;
      this.drawMarks();
      this.changed();
    }
  }

  // --- Acting on a note ---------------------------------------------------------------------------------------------------

  private open(id: string | null, focus = false): void {
    this.active = id;
    if (focus && id) this.focusNote = id;
    this.drawMarks();
    this.changed();
  }

  /** Lights a passage the editor pointed at, and selects it so it is in view. */
  private show(words: string): void {
    const text = this.text;
    const at = text ? locateNote(text, words, '') : null;
    if (!at) return;
    this.flash = { paragraph: at.index, from: at.from, to: at.to, kind: 5 };
    this.drawMarks();
    this.host.select(at.index, at.from, at.to);
    window.setTimeout(() => {
      this.flash = null;
      this.drawMarks();
    }, 1600);
  }

  /** Cuts the words a note suggests cutting, as the writer's own edit. */
  private acceptCut(note: EditorNote): void {
    const text = this.text;
    const at = text && note.cut ? locateNote(text, note.cut, note.paragraph) : null;
    if (!text || !at) return;
    const [from, to] = cutRange(text.paragraphs[at.index].text, at.from, at.to);
    this.host.replace(at.index, from, to, '');
    this.drop(note.id);
  }

  /** Moves the words a note suggests moving to after the words it names: put in there, taken out here. */
  private acceptMove(note: EditorNote): void {
    const text = this.text;
    const move = text && note.move ? locateNote(text, note.move, note.paragraph) : null;
    const after = text && note.after ? locateNote(text, note.after, '') : null;
    if (!text || !move || !after) return;
    const words = visible(text.paragraphs[move.index].text.slice(move.from, move.to));
    const [from, to] = cutRange(text.paragraphs[move.index].text, move.from, move.to);
    const insert = () => this.host.replace(after.index, after.to, after.to, ` ${words}`);
    const remove = () => this.host.replace(move.index, from, to, '');
    // Whichever is later in its paragraph goes first, so the other's offsets still hold.
    if (after.index === move.index && after.to > from) {
      insert();
      remove();
    } else {
      remove();
      insert();
    }
    this.drop(note.id);
  }

  /** Swaps the word a note is about for the one the writer picked. */
  private swap(note: EditorNote, word: string): void {
    const text = this.text;
    const at = text && note.replace ? locateNote(text, note.replace, note.paragraph) : null;
    if (!text || !at) return;
    this.host.replace(at.index, at.from, at.to, word);
    this.drop(note.id);
  }

  /** Keeps a note as a comment in the document (its words, and what was said), and takes it out of the margin. */
  private pin(note: EditorNote): void {
    const at = this.places.get(note.id);
    if (!at) return;
    const said = note.talk.map((turn) => `${turn.who === 'writer' ? t('afterward.writer') : BOARD}: ${turn.text}`);
    const quotes = (note.quotes ?? []).map((q) => t('afterward.quotes.quote', { quote: q.text, source: q.source, why: q.why }));
    const body = [note.note, ...quotes, ...said].filter(Boolean).join('\n\n');
    this.host.send({ kind: 'addComments', comments: [{ paragraph: at.index, from: at.from, to: at.to, text: body, author: BOARD }] });
    this.drop(note.id);
  }

  /** Dismisses a note; reading along won't raise it again. */
  private dismiss(note: EditorNote): void {
    if (note.note && note.from === 'read') this.keep((rec) => void (rec.dismissed = [...rec.dismissed, `"${note.quote}": ${note.note}`].slice(-50)));
    this.drop(note.id);
  }

  private drop(id: string): void {
    this.streaming.get(id)?.abort.abort();
    this.keep((rec) => void (rec.notes = rec.notes.filter((n) => n.id !== id)));
    this.places.delete(id);
    if (this.active === id) this.active = null;
    this.drawMarks();
    this.changed();
    void this.locate();
  }



  // --- Commands that work on the piece ------------------------------------------------------------------------------------

  /** Tools › Reverse Outline: what each paragraph does (a long piece: the chapter at the caret), kept while it is the same. */
  async outline(): Promise<void> {
    this.sync();
    const text = await this.host.readerText();
    if (!text || !this.host.docKey()) return;
    const { piece, system: sys } = this.scope(text, text.selection?.start[0] ?? 0);
    if (!piece.paragraphs.length) return this.complain(t('afterward.error.empty'));
    const key = fingerprint(numbered(piece));
    const kept = this.record?.outlines?.[key];
    if (kept) return showOutline(piece, kept, (i) => this.host.goToParagraph(i));
    if (!(await this.haveKey())) return;
    const progress = showProgress(t('afterward.outlining'), true);
    try {
      const outline = checkOutline(await this.ask({ system: sys, task: OUTLINE_TASK, schema: OUTLINE_SCHEMA, effort: 'medium', maxTokens: 32000 }, progress.signal, 'outline'));
      this.keep((rec) => {
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
   * Tools › Find Quotes in My Notes: passages of the writer's own library that bear on the selection, as a note in the margin.
   * Every quote is found again in its source, and the note holds the source's own words, never the model's.
   */
  async findQuotes(): Promise<void> {
    this.sync();
    const text = await this.host.readerText();
    if (!text || !this.host.docKey()) return;
    const at = selectedPassage(text);
    if (!at) return this.complain(t('afterward.quotes.nothingSelected'));
    if (!(await this.haveKey())) return;
    const { piece, system: sys } = this.scope(text, at.paragraph);
    const progress = showProgress(t('afterward.quotes.finding'), true);
    try {
      progress.update(0, 3, t('afterward.quotes.searching'));
      const queries = checkQueries(await this.ask({ system: sys, task: queriesTask(at.passage), schema: QUERIES_SCHEMA, effort: 'low', maxTokens: 2000 }, progress.signal, 'quotes: search'));
      const sources = trimSources(await this.host.findSources(queries));
      if (!sources.length) {
        progress.close();
        return this.complain(t('afterward.quotes.noSources'));
      }
      progress.update(1, 3, t('afterward.quotes.reading', { count: sources.length }));
      const found = checkQuotes(await this.ask({ system: sys, task: quotesTask(at.passage, at.around, sources), schema: QUOTES_SCHEMA, effort: 'medium' }, progress.signal, 'quotes'));
      const quotes: { text: string; source: string; why: string }[] = [];
      for (const q of found) {
        const verified = verifyQuote(sources, q.source - 1, q.quote);
        if (verified && !quotes.some((x) => x.text === verified.text)) quotes.push({ text: verified.text, source: sources[verified.source].name, why: unnumber(q.why, piece) });
      }
      progress.finish();
      if (!quotes.length) return this.complain(t('afterward.quotes.none', { count: sources.length }));
      const raw = text.paragraphs[at.paragraph].text;
      const whole = at.from === 0 && at.to === raw.length;
      const note: EditorNote = {
        id: newId(),
        quote: whole ? '' : visible(raw.slice(at.from, at.to)),
        paragraph: fingerprint(raw),
        note: t('afterward.quotes.intro', { count: quotes.length, names: [...new Set(quotes.map((q) => q.source))].join(', ') }),
        from: 'quotes',
        quotes,
        talk: [],
        at: Date.now(),
      };
      this.keep((rec) => void rec.notes.push(note));
      this.text = text;
      this.places.set(note.id, { index: at.paragraph, from: at.from, to: at.to });
      this.open(note.id);
    } catch (e) {
      progress.close();
      if (!(e instanceof ModelError && e.kind === 'stopped')) this.complain(explain(e));
    }
  }

  // --- CommentAgents: the margin ------------------------------------------------------------------------------------------

  agent(author: string): { name: string; color: string; title?: string } | null {
    const who = agentOf(author);
    if (!who) return null;
    return { name: who.name, color: agentColor(who.name, who.board), ...(who.board ? { title: t('afterward.boardAbout') } : {}) };
  }

  note(): null {
    return null;
  }

  actions(): CommentAction[] {
    return [];
  }

  mentions(): string[] {
    return [];
  }

  key(): string {
    return String(this.version);
  }

  /** The panel's title while it holds only the editor's notes ("Comments (0)" would say nothing). */
  title(): string {
    return this.record?.notes.some((n) => this.places.has(n.id)) ? t('afterward.title') : '';
  }

  subtitle(): string {
    const record = this.record;
    let line = '';
    if (this.paused && readAlongOn()) line = t('afterward.paused', { reason: this.paused });
    else if (record?.readsAs && (readAlongOn() || record.notes.length)) line = t('afterward.readsAs', { text: record.readsAs });
    return [line, this.usageLine()].filter(Boolean).join('\n');
  }

  cards(): AgentCard[] {
    const text = this.text;
    if (!text || !this.record) return [];
    return this.record.notes.flatMap((note) => {
      const at = this.places.get(note.id);
      const place = at ? text.paragraphs[at.index]?.place : null;
      if (!at || !place) return [];
      return [{ id: note.id, el: this.card(note), at: { page: place[0], y: place[1] }, active: note.id === this.active }];
    });
  }

  /** After the panel has drawn the cards: the keyboard goes to the box it was waiting for. */
  drawn(): void {
    const id = this.focusNote;
    this.focusNote = null;
    if (!id) return;
    document.querySelector<HTMLTextAreaElement>(`.wm-editor-note[data-note="${CSS.escape(id)}"] textarea`)?.focus();
  }

  /**
   * One note's card. Closed: what the editor noticed, whole, and nothing else. Open (a click): the conversation, the change it
   * suggests as one button that says what it does, a box to ask in (with a send arrow), and Pin and Dismiss as icons above.
   */
  private card(note: EditorNote): HTMLElement {
    const open = note.id === this.active;
    const card = h('article', { class: `wm-comment wm-editor-note${open ? ' wm-comment-active' : ''}`, attrs: { tabindex: '0', 'data-note': note.id, 'aria-label': t('afterward.title'), 'aria-expanded': String(open) } });
    const avatar = h('span', { class: 'wm-comment-avatar wm-comment-agent', attrs: { 'aria-hidden': 'true' } }, readerIcon());
    avatar.style.background = agentColor(BOARD, true);
    const header = h('header', {}, avatar, h('strong', { text: BOARD, title: t('afterward.boardAbout') }));
    if (open) {
      const icons = h('span', { class: 'wm-editor-icons' });
      if (note.note || note.talk.length || note.quotes) {
        const pin = iconButton('wm-editor-icon', PIN_ICON, t('afterward.pin'));
        pin.addEventListener('click', () => this.pin(note));
        icons.append(pin);
      }
      const dismiss = iconButton('wm-editor-icon', CLOSE_ICON, t('afterward.dismiss'));
      dismiss.addEventListener('click', () => this.dismiss(note));
      icons.append(dismiss);
      header.append(icons);
    }
    card.append(header);
    if (note.note) card.append(h('p', { text: note.note }));
    // A question the writer started has no note: closed, it shows the last thing the editor said.
    if (!open && !note.note && note.talk.length) card.append(h('p', { text: note.talk[note.talk.length - 1].text }));
    if (open) this.fill(card, note);
    card.addEventListener('click', (e) => {
      if (this.active === note.id || (e.target instanceof Element && e.target.closest('button, textarea'))) return;
      this.open(note.id, true);
    });
    card.addEventListener('keydown', (e) => {
      if (e.target === card && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        this.open(note.id, true);
      }
    });
    return card;
  }

  private fill(card: HTMLElement, note: EditorNote): void {
    const button = (label: string, run: () => void, kind: 'primary' | 'quiet' | 'link' = 'quiet') => {
      const b = h('button', { text: label, class: kind === 'primary' ? 'wm-comment-primary' : kind === 'link' ? 'wm-editor-link' : 'wm-editor-quiet', attrs: { type: 'button' } });
      b.addEventListener('click', run);
      return b;
    };
    for (const q of note.quotes ?? []) card.append(h('blockquote', { class: 'wm-editor-quote' }, h('p', { text: `“${q.text}”` }), h('p', { class: 'wm-editor-source', text: `— ${q.source}` }), h('p', { text: q.why })));
    // The conversation: the last two turns, unless all are shown.
    const turns = this.expanded.has(note.id) ? note.talk : note.talk.slice(-2);
    if (turns.length < note.talk.length)
      card.append(
        button(
          t('afterward.showAll', { count: note.talk.length }),
          () => {
            this.expanded.add(note.id);
            this.changed();
          },
          'link',
        ),
      );
    for (const turn of turns) card.append(h('p', { class: turn.who === 'writer' ? 'wm-editor-writer' : 'wm-editor-reply', text: turn.text }));
    const streaming = this.streaming.get(note.id);
    if (streaming) {
      card.append(streaming.el, h('div', { class: 'wm-editor-row' }, button(t('afterward.stop'), () => streaming.abort.abort())));
      return;
    }
    const error = this.errors.get(note.id);
    if (error) card.append(h('p', { class: 'wm-comment-note wm-comment-note-error', attrs: { role: 'alert' }, text: error }));
    for (const words of note.show ?? []) card.append(h('div', {}, button(t('afterward.showMe', { text: words.length > 48 ? `${words.slice(0, 47)}…` : words }), () => this.show(words), 'link')));
    // What it suggests doing to the writer's own words: shown in the text while the card is open, done only on a click.
    if (note.cut) card.append(h('div', { class: 'wm-editor-row' }, button(t('afterward.cutPrompt', { text: note.cut }), () => this.acceptCut(note), 'primary'), button(t('afterward.keep'), () => this.clearSuggestion(note.id))));
    if (note.move && note.after) card.append(h('div', { class: 'wm-editor-row' }, button(t('afterward.movePrompt', { text: note.move, after: note.after }), () => this.acceptMove(note), 'primary'), button(t('afterward.leave'), () => this.clearSuggestion(note.id))));
    if (note.words?.length && note.replace) {
      const chips = note.words.map((w) => {
        const b = h('button', { class: 'wm-editor-word', text: w, attrs: { type: 'button' } });
        b.addEventListener('click', () => this.swap(note, w));
        return b;
      });
      card.append(h('div', { class: 'wm-editor-row' }, h('span', { class: 'wm-editor-label', text: t('afterward.wordsPrompt', { text: note.replace }) }), ...chips));
    }
    // Asking: the box, with its send arrow inside it.
    const box = h('textarea', { class: 'wm-comment-box', attrs: { rows: '1', 'aria-label': t('afterward.askPlaceholder'), placeholder: t('afterward.askPlaceholder') } });
    box.value = this.drafts.get(note.id) ?? '';
    const send = iconButton('wm-editor-icon wm-editor-send', SEND_ICON, t('afterward.ask'));
    send.addEventListener('click', () => void this.send(note.id));
    box.addEventListener('input', () => {
      this.drafts.set(note.id, box.value);
      box.style.height = 'auto';
      box.style.height = `${box.scrollHeight}px`;
      this.host.reflow();
    });
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void this.send(note.id);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.open(null);
      }
    });
    card.append(h('div', { class: 'wm-editor-ask' }, box, send));
  }

  private clearSuggestion(id: string): void {
    this.keep((rec) => {
      const n = rec.notes.find((x) => x.id === id);
      if (n) n.cut = n.move = n.after = n.replace = n.words = undefined;
    });
    this.drawMarks();
    this.changed();
  }

  // --- Helpers ------------------------------------------------------------------------------------------------------------

  /** What a reading at the paragraph `index` covers: the whole piece when it is short; for a long one, its chapter, with those before. */
  private scope(text: ReaderText, index: number): { piece: Piece; system: ReturnType<typeof system>; chapter: Chapter | null } {
    const scope = scopeOf(text, index);
    const piece = pieceOf(text, scope.range);
    let chapter: ChapterContext | null = null;
    if (scope.chapter) {
      const before = scope.before.map((c, i) => ({ title: c.title || this.chapterName(c, i), text: plainChapter(text, c) }));
      let size = before.reduce((n, c) => n + c.text.length, 0);
      while (before.length > 1 && size > 600_000) size -= before.shift()!.text.length;
      chapter = { title: scope.chapter.title || this.chapterName(scope.chapter, scope.before.length), before };
    }
    return { piece, system: system(piece, this.host.docTitle(), chapter), chapter: scope.chapter };
  }

  private chapterName(chapter: Chapter, index: number): string {
    return chapter.from === 0 && index === 0 ? t('afterward.opening') : t('afterward.part', { n: index + 1 });
  }

  /** Whether there is a key to ask with: asks for one when there is none (reading along never asks; it waits for a key). */
  private async haveKey(): Promise<boolean> {
    if (this.host.model || getSetting(KEY_SETTING)) return true;
    const key = await askForKey();
    if (key) {
      setSetting(KEY_SETTING, key);
      this.layoutChanged();
    }
    return !!key;
  }

  private ask(request: ModelRequest, signal: AbortSignal | undefined, label: string): Promise<unknown> {
    const model = this.host.model?.() ?? directModel(getSetting(KEY_SETTING));
    if (!this.host.model && !getSetting(KEY_SETTING)) return Promise.reject(new ModelError('key', 'no key'));
    const started = performance.now();
    return model.ask({ ...request, onUsage: (usage) => this.tally(label, usage, performance.now() - started) }, signal);
  }

  /** Counts what a call used; logged to the console, and shown in the margin with Admin › Debug › Token use. */
  private tally(label: string, usage: Usage, ms: number): void {
    const u = this.used;
    const dollars = costOf(usage);
    u.calls++;
    u.input += usage.input;
    u.output += usage.output;
    u.cacheRead += usage.cacheRead;
    u.cacheWrite += usage.cacheWrite;
    u.dollars += dollars;
    const model = usage.model.replace(/^claude-/, '');
    const read = usage.input + usage.cacheRead + usage.cacheWrite;
    u.last = label + ', ' + model + ': ' + tokens(read) + ' in (' + tokens(usage.cacheRead) + ' cached), ' + tokens(usage.output) + ' out, ' + (ms / 1000).toFixed(1) + ' s';
    console.debug('[afterward]', label, { ...usage, dollars: Number(dollars.toFixed(4)), seconds: Number((ms / 1000).toFixed(2)) });
    if (debugFlags().afterwardTokens) this.changed();
  }

  /** The token lines under the reading line (Admin › Debug › Token use), or '' when the flag is off. Developers' English, as the other debug readouts. */
  private usageLine(): string {
    if (!debugFlags().afterwardTokens) return '';
    const u = this.used;
    if (!u.calls) return 'Tokens: no calls yet';
    const total = u.input + u.cacheRead + u.cacheWrite;
    const cost = '$' + u.dollars.toFixed(u.dollars < 0.01 ? 4 : u.dollars < 1 ? 3 : 2);
    return 'Tokens: ' + u.calls + (u.calls === 1 ? ' call' : ' calls') + ' · ' + tokens(total) + ' in (' + tokens(u.cacheRead) + ' cached, ' + tokens(u.cacheWrite) + ' written) · ' + tokens(u.output) + ' out · ≈ ' + cost + '\nLast: ' + u.last;
  }

  private changed(): void {
    this.version++;
    this.host.refresh();
  }

  private complain(text: string): void {
    showDialog(t('afterward.title'), h('p', { text }));
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
