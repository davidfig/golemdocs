// Screen Reader Mode, wired to the open document (see docs/architecture/accessibility.md): turns the mode on and off in the
// layout worker, keeps the hidden textarea mirroring the text around the caret (ui/caretMirror.ts), the reading layer over
// the pages (ui/readingLayer.ts), and says what only the canvas shows: formatting turned on or off, the heading or style the
// caret moved into, the page it reached, people joining and leaving. main.ts calls in from its own handlers.

import { t } from './i18n/index.ts';
import type { LayoutClient } from './layout/layoutClient.ts';
import type { SelectionUpdate } from './layout/protocol.ts';
import { announce } from './ui/announce.ts';
import { CaretMirror } from './ui/caretMirror.ts';
import { stripMnemonic } from './ui/dom.ts';
import { ReadingLayer, type PagePlace, type ReadingHost, type ViewPlace } from './ui/readingLayer.ts';
import { onScreenReaderChange, SCREEN_READER_SHORTCUT, screenReaderOn } from './ui/screenReader.ts';
import { formatShortcut, parseShortcut } from './ui/shortcuts.ts';
import type { Mark } from './ui/actions.ts';

const MARK_LABELS: Record<Mark, Parameters<typeof t>[0]> = {
  bold: 'chrome.format.bold',
  italic: 'chrome.format.italic',
  underline: 'chrome.format.underline',
  strikethrough: 'chrome.format.strikethrough',
  superscript: 'chrome.format.superscript',
  subscript: 'chrome.format.subscript',
  code: 'chrome.format.code',
};

/** What changed between two selections that a screen reader would not otherwise hear: the messages to say. */
export interface SpokenSelection {
  at: string;
  marks: Partial<Record<Mark, boolean>>;
  style: string;
  paragraph: number;
  page: number;
  /** The text around the caret (to tell moving from typing). */
  text?: string;
  /** The mistake the caret is in: which one, and what to say. */
  mistake?: { key: string; message: string } | null;
}

export function selectionMessages(before: SpokenSelection, after: SpokenSelection, pageCount: number): string[] {
  const out: string[] = [];
  // The first selection of a document (or since the mode came on) is where the reader starts: nothing changed.
  if (!before.at) return out;
  if (before.at === after.at) {
    // The caret did not move but the formatting changed: a mark was turned on or off.
    for (const mark of Object.keys(MARK_LABELS) as Mark[]) {
      const was = !!before.marks[mark];
      const is = !!after.marks[mark];
      if (was !== is) out.push(t(is ? 'a11y.markOn' : 'a11y.markOff', { name: stripMnemonic(t(MARK_LABELS[mark])) }));
    }
    return out;
  }
  if (after.paragraph !== before.paragraph && after.style && after.style !== before.style) out.push(after.style);
  if (after.page >= 0 && before.page >= 0 && after.page !== before.page) out.push(t('a11y.pageOf', { page: after.page + 1, pages: pageCount }));
  // A mistake the caret moved onto (not one being typed: the text is as it was).
  if (after.mistake && after.mistake.key !== before.mistake?.key && after.text === before.text) out.push(after.mistake.message);
  return out;
}

/** What a turned page of a book says: the page and how far through the book (Print layout), or only how far (Flow, no pages). */
export function pageTurnMessage(page: { page: number; pages: number } | null, percent: number): string {
  return page ? t('a11y.book.pageRead', { page: page.page, pages: page.pages, percent }) : t('panels.footer.progress', { percent });
}

/** How long a page turn's message waits for the caret to reach the page, to be said with what the caret found there. */
const TURN_WAIT_MS = 500;
/** How long after a page turn the caret's arrival on the page still counts as part of it (the worker may be busy laying out). */
const TURN_CARET_MS = 5000;
/** How long after saying a book is read-only it is not said again (each key typed would say it). */
const READ_ONLY_QUIET_MS = 3000;

/** The line a match is on, cut to a few words either side of it. */
export function foundSnippet(context: { text: string; anchor: number; focus: number }, radius = 40): string {
  const from = Math.min(context.anchor, context.focus);
  const to = Math.max(context.anchor, context.focus);
  const start = Math.max(0, context.text.lastIndexOf('\n', from - 1) + 1, from - radius);
  const newline = context.text.indexOf('\n', to);
  const end = Math.min(newline < 0 ? context.text.length : newline, to + radius);
  return `${start > 0 && context.text[start - 1] !== '\n' ? '…' : ''}${context.text.slice(start, end).trim()}${end < context.text.length && context.text[end] !== '\n' ? '…' : ''}`;
}

export class ScreenReaderSupport {
  readonly layer: ReadingLayer;
  private readonly mirror: CaretMirror;
  private last: SpokenSelection = { at: '', marks: {}, style: '', paragraph: -1, page: -1 };
  private people = new Set<string>();
  /** A book's page was just turned: what to say, whether it was said yet, and when. The caret's arrival on the page is part of it. */
  private turn: { message: string; said: boolean; at: number } | null = null;
  private turnTimer = 0;
  private readOnlySaid = 0;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly input: HTMLTextAreaElement,
    worker: LayoutClient,
    host: ReadingHost & { documentName(): string },
  ) {
    this.mirror = new CaretMirror(input);
    this.layer = new ReadingLayer(host);
    input.before(this.layer.root);
    worker.onA11yPages = (pages, headings) => this.layer.receive(pages, headings);
    const apply = (on: boolean) => {
      worker.setScreenReader(on);
      this.layer.setOn(on, host.documentName());
      if (!on) input.value = '';
      this.label();
    };
    this.unsubscribe = onScreenReaderChange((on) => {
      apply(on);
      announce(t(on ? 'a11y.on' : 'a11y.off'), true);
    });
    if (screenReaderOn()) apply(true);
    else this.label();
  }

  /** Stops following the mode and takes the reading layer away (the viewer, taken down). */
  dispose(): void {
    this.unsubscribe();
    this.layer.root.remove();
  }

  /** The words are in another language now (the viewer's, loaded after it started): the names are written again. */
  relabel(documentName: string): void {
    this.label();
    this.layer.setName(documentName);
  }

  /** The textarea's name, and while the mode is off, how to turn it on (read after the name when it gets the keyboard). */
  private label(): void {
    this.input.setAttribute('aria-label', t('a11y.document'));
    if (screenReaderOn()) this.input.removeAttribute('aria-description');
    else this.input.setAttribute('aria-description', t('a11y.hint', { shortcut: formatShortcut(parseShortcut(SCREEN_READER_SHORTCUT)!) }));
  }

  /** A document opened (or none is): the layer starts again with its name. */
  opened(name: string): void {
    this.layer.clear();
    this.layer.setName(name);
    this.last = { at: '', marks: {}, style: '', paragraph: -1, page: -1 };
    this.people.clear();
  }

  /** The worker sent a selection. `page`: where the caret's page is among the pages, and how many there are. */
  selection(update: SelectionUpdate, page: { index: number; count: number } | null): void {
    // Kept while the mode is off too, so turning it on does not announce where the caret already is.
    const mistake = update.mistake && { key: `${update.mistake.paragraph}:${update.mistake.start}:${update.mistake.text}`, message: t(update.mistake.kind === 'spelling' ? 'a11y.spelling' : 'a11y.grammar', { text: update.mistake.text }) };
    const next: SpokenSelection = { at: JSON.stringify(update.at ?? null), marks: update.format.marks ?? {}, style: update.format.style ?? '', paragraph: update.at?.focus[0] ?? -1, page: page?.index ?? -1, text: update.context?.text, mistake };
    const before = this.last;
    this.last = next;
    if (!screenReaderOn()) {
      this.input.value = '';
      return;
    }
    this.mirror.show(update.context);
    // The caret reached the page a book turned to: its page is the turn's (said once, with what is there, a heading's style say).
    const turn = this.turn && before.at !== next.at && Date.now() - this.turn.at < TURN_CARET_MS ? this.turn : null;
    if (turn) {
      this.turn = null;
      clearTimeout(this.turnTimer);
    }
    const messages = selectionMessages(turn ? { ...before, page: -1 } : before, next, page?.count ?? 0);
    if (turn && !turn.said) messages.unshift(turn.message);
    // Find moved the selection while the focus stays in its dialog: say where.
    if (update.search?.found && update.context) messages.unshift(t('a11y.found', { text: foundSnippet(update.context) }));
    if (messages.length) announce(messages.join('. '));
  }

  /** A book's page was turned (main.ts moves the caret to its top next): where the reader is now is said. */
  pageTurned(page: { page: number; pages: number } | null, percent: number): void {
    if (!screenReaderOn()) return;
    const turn = { message: pageTurnMessage(page, percent), said: false, at: Date.now() };
    this.turn = turn;
    // Said with what the caret finds on the page when it gets there; on its own if that takes a while.
    clearTimeout(this.turnTimer);
    this.turnTimer = window.setTimeout(() => {
      if (this.turn !== turn) return;
      turn.said = true;
      announce(turn.message);
    }, TURN_WAIT_MS);
  }

  /** Something was typed in a document that can only be read (a book): said, though not again for every key. */
  readOnly(): void {
    if (!screenReaderOn() || Date.now() - this.readOnlySaid < READ_ONLY_QUIET_MS) return;
    this.readOnlySaid = Date.now();
    announce(t('a11y.book.readOnly', { menu: `${stripMnemonic(t('chrome.menu.file'))} › ${stripMnemonic(t('chrome.file.convertTo'))}` }));
  }

  /** The pages were laid out again: those dropped are no longer described. */
  layout(dropped: readonly number[]): void {
    if (screenReaderOn()) this.layer.changed(dropped);
  }

  /** Called every frame: keeps the reading layer over the pages. */
  render(view: ViewPlace, pages: readonly PagePlace[]): void {
    this.layer.position(view, pages);
  }

  /** The other people in the room: who joined and who left is said. */
  room(names: readonly string[]): void {
    const now = new Set(names);
    if (screenReaderOn()) {
      for (const name of now) if (!this.people.has(name)) announce(t('a11y.joined', { name }));
      for (const name of this.people) if (!now.has(name)) announce(t('a11y.left', { name }));
    }
    this.people = now;
  }
}
