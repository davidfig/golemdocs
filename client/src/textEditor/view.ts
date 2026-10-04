// A viewer for text files too big to be a document (see docs/text-files.md): the file stays bytes,
// lines are found by a LineIndex, and only the lines in view are in the page. Scrolling any distance is one
// jump, search runs over the bytes in the background, and "show only matching lines" turns a log into
// what matched. The text can be edited: a caret and selection, typing, pasting, undo (see textDocument.ts for
// the piece table underneath), and lines can be selected by their numbers and copied.

import { t } from '../i18n/index.ts';
import { h } from '../ui/dom.ts';
import { CSS_PX_PER_POINT } from '../view/camera.ts';
import type { Camera } from '../view/camera.ts';
import type { AtlasLibrary } from '../webgl/text/gpuFace.ts';
import { LineIndex } from './lineIndex.ts';
import { clampPos, docEnd, isCollapsed, lineEnd, ordered, planBackspace, planDelete, planInsert, offsetOf, posOf, samePos, selectedText as textOfSelection, shown, stepCol, stepWord, wordAt } from './positions.ts';
import type { Plan, Pos, Selection } from './positions.ts';
import { describeMatches, planDeleteLines, planInsertLines, planReplaceLines, readLines } from './lineTools.ts';
import { compileSearch, escapeReplacement, expandReplacement, findInText } from '@golemdocs/editor/pattern';
import type { SearchOptions } from '@golemdocs/editor/pattern';
import { MAX_SHARED_REPLACEMENTS, nextMatch, replaceAllLines, replaceRangesOf, searchLines } from './search.ts';
import { mapOffset, type TextOp, type TextReplica } from '@golemdocs/ops/textOps';
import { readClipboard, writeClipboardText } from '../ui/clipboard.ts';
import { attachTextInput, editKey, type EditKey } from '../ui/textInput.ts';
import type { SpellIssue, TextMark } from '../layout/protocol.ts';
import { TextSpell } from './spell.ts';
import type { SpellDeps } from './spell.ts';
import { PieceTable } from './pieceTable.ts';
import { encodeTable } from './encoding.ts';
import { TextDocument } from './textDocument.ts';
import type { TextEncoding } from '../formats/textFiles.ts';
import type { Change } from './textDocument.ts';
import { LineRenderer } from './glRenderer.ts';
import type { LineFrame } from './glRenderer.ts';
import type { MonoFonts } from './fonts.ts';
export { MonoFonts } from './fonts.ts';
export { textRoom } from './textSync.ts';
export type { TextRoom, TextRoomOptions } from './textSync.ts';
import { CELL, LINE, LineScene } from './scene.ts';
import type { Entries, Rect } from './scene.ts';
import './view.css';

const MAX_COPY_LINES = 500_000;
const WRAP_KEY = 'wm.largeWrap';
/** Margin kept around the caret when the view pans to show it, in CSS pixels. */
const REVEAL_MARGIN_PX = 24;

/** Wrapping is on unless it was turned off (the choice is remembered). */
function readWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) !== '0';
  } catch {
    return true;
  }
}

/** What the view needs of the app: the shared camera, the GPU, and a way to ask for a frame. */
export interface TextEditorDeps {
  camera: Camera;
  gl: WebGL2RenderingContext;
  atlases: AtlasLibrary;
  /** Directory of the font manifest. */
  fontBase: string;
  locale(): string;
  /** Asks for a frame. */
  render(): void;
  /** The app's own view keys (zoom, fit); true if it took the key. */
  viewKey(e: KeyboardEvent): boolean;
  /** Spelling and grammar marks (see spell.ts); left out, nothing is underlined. */
  spell?: SpellDeps;
}

const sizeText = (n: number): string => (n < 1 << 20 ? `${Math.round(n / 1024)} KB` : `${(n / (1 << 20)).toFixed(n < 10 << 20 ? 1 : 0)} MB`);

export class TextEditorView {
  readonly el = h('div', { class: 'wm-large', attrs: { hidden: '' } });
  private readonly bar = h('div', { class: 'wm-large-bar', attrs: { hidden: '' } });
  private readonly findInput = h('input', { class: 'wm-input', attrs: { type: 'text', placeholder: t('textEditor.findPlaceholder'), 'aria-label': t('textEditor.find'), spellcheck: 'false' } });
  private readonly lineInput = h('input', { class: 'wm-input wm-large-line', attrs: { type: 'number', min: '1', placeholder: t('textEditor.goTo'), 'aria-label': t('textEditor.goTo') } });
  private readonly replaceInput = h('input', { class: 'wm-input', attrs: { type: 'text', placeholder: t('textEditor.replacePlaceholder'), 'aria-label': t('textEditor.replacePlaceholder'), spellcheck: 'false' } });
  private readonly replaceRow = h('div', { class: 'wm-large-replace', attrs: { hidden: '' } });
  private busy = false;
  /** Editing is held off (the file is being handed over to the room). */
  frozen = false;
  /** The person may only look (a file shared with them to view). */
  readOnly = false;
  private readonly message = h('span', { class: 'wm-large-message', attrs: { 'aria-live': 'polite' } });
  private readonly toggles: Record<'caseSensitive' | 'wholeWord' | 'regex' | 'filter', HTMLButtonElement>;

  private doc: TextDocument | null = null;
  private name = '';
  private source: { encoding: TextEncoding; bom: boolean; original: Uint8Array | null } = { encoding: 'utf-8', bom: false, original: null };
  private abort: AbortController | null = null;
  private searchAbort: AbortController | null = null;
  private searchTimer = 0;
  /** Lines that match the search, ascending; null with no search. */
  private matches: Uint32Array | null = null;
  private options: SearchOptions = { text: '', caseSensitive: false, wholeWord: false, regex: false };
  private filtering = false;
  private readonly spell: TextSpell | null;
  private highlight: { regex: RegExp; wholeWord: boolean } | null = null;
  /** The line the last search step landed on. */
  private current = -1;
  private sel: Selection = { anchor: { line: 0, col: 0 }, focus: { line: 0, col: 0 } };
  /** Where (in points across the page) the caret was at the start of a run of Up and Down keys, so the column it returns to stays the same. */
  private goalX: number | null = null;
  /** Text being composed by an input method (it is shown at the caret and put in the file when it is done). */
  private composing: string | null = null;
  private dragging = false;
  /** The pointer, in CSS pixels on the canvas, while a button is down. */
  private pointer = { x: 0, y: 0 };
  private dragFrame = 0;
  /** Frames left in which to pan to the caret (row heights settle as lines are laid out, so it is done in steps). */
  private revealing = 0;
  private lastFrame: LineFrame | null = null;
  /** Milliseconds the last frame took to build and draw (the CPU's part), and the slowest since the file opened. */
  private frameMs = 0;
  private slowestMs = 0;
  /** Called after every change to the text, and when the keyboard asks to save. */
  onEdit: (() => void) | null = null;
  onSave: (() => void) | null = null;
  /** Called when the selection or what can be undone changes (for the menus). */
  onState: (() => void) | null = null;
  /** The selection moved (as byte offsets of the text), for the other people in a room. */
  onPresence: ((anchor: number, focus: number) => void) | null = null;
  /** Where other people are, as byte offsets, by who they are. */
  private remotes = new Map<string, { color: number; anchor: number; focus: number }>();
  private readonly input = h('textarea', {
    class: 'wm-large-input',
    attrs: { 'aria-label': t('textEditor.editor'), autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', rows: '1', wrap: 'off', 'data-large-input': '' },
  });
  private wrap = readWrap();
  private readonly entriesList: Entries;
  private readonly scene: LineScene;
  private readonly renderer: LineRenderer;
  private lastIndexRebuild = 0;

  private get index(): LineIndex | null {
    return this.doc?.index ?? null;
  }

  constructor(
    parent: HTMLElement,
    private readonly deps: TextEditorDeps,
    fonts: MonoFonts,
  ) {
    const view = this;
    this.spell = deps.spell ? new TextSpell(deps.spell) : null;
    this.entriesList = { get count() { return view.rowCount; }, lineOf: (entry) => view.lineOfRow(entry), entryOf: (line) => view.rowOfLine(line) };
    this.scene = new LineScene(() => this.index, () => this.entriesList);
    this.scene.wrap = this.wrap;
    this.renderer = new LineRenderer(deps.gl, fonts, this.scene, () => this.index, () => this.entriesList);
    this.toggles = {
      caseSensitive: this.toggle('Aa', t('dialogs.find.matchCase')),
      wholeWord: this.toggle('W', t('dialogs.find.wholeWord')),
      regex: this.toggle('.*', t('dialogs.find.regex')),
      filter: this.toggle('☰', t('textEditor.filter')),
    };
    const previous = h('button', { class: 'wm-button', text: '↑', attrs: { type: 'button', title: t('textEditor.previous'), 'aria-label': t('textEditor.previous') } });
    const next = h('button', { class: 'wm-button', text: '↓', attrs: { type: 'button', title: t('textEditor.next'), 'aria-label': t('textEditor.next') } });
    const close = h('button', { class: 'wm-button', text: '×', attrs: { type: 'button', title: t('textEditor.close'), 'aria-label': t('textEditor.close') } });
    const replaceOne = h('button', { class: 'wm-button', text: t('textEditor.replace'), attrs: { type: 'button' } });
    const replaceAll = h('button', { class: 'wm-button', text: t('textEditor.replaceAll'), attrs: { type: 'button' } });
    this.replaceRow.append(this.replaceInput, replaceOne, replaceAll);
    this.bar.append(this.findInput, this.toggles.caseSensitive, this.toggles.wholeWord, this.toggles.regex, previous, next, this.toggles.filter, this.message, this.lineInput, close, this.replaceRow);
    replaceOne.addEventListener('click', () => void this.replaceCurrent());
    replaceAll.addEventListener('click', () => void this.replaceEverywhere());
    this.replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.replaceCurrent();
      else if (e.key === 'Escape') this.closeBar();
      else return;
      e.preventDefault();
    });
    // The text itself is drawn on the app's canvas, under this: the bar sits over its top.
    this.el.append(this.bar, h('div', { class: 'wm-large-fill' }), this.input);
    parent.append(this.el);

    this.listenToInput();
    this.findInput.addEventListener('input', () => this.searchSoon());
    this.findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.step(e.shiftKey);
      else if (e.key === 'Escape') this.closeBar();
      else return;
      e.preventDefault();
    });
    this.lineInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.goToLine(Number(this.lineInput.value));
      else if (e.key === 'Escape') this.closeBar();
      else return;
      e.preventDefault();
    });
    for (const input of [this.findInput, this.lineInput, this.replaceInput]) input.addEventListener('keydown', (e) => e.stopPropagation());
    previous.addEventListener('click', () => this.step(true));
    next.addEventListener('click', () => this.step(false));
    close.addEventListener('click', () => this.closeBar());
    for (const [key, button] of Object.entries(this.toggles) as [keyof typeof this.toggles, HTMLButtonElement][]) {
      button.addEventListener('click', () => {
        button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
        if (key === 'filter') {
          this.filtering = button.getAttribute('aria-pressed') === 'true';
          this.entriesChanged(true);
        } else this.searchSoon(0);
      });
    }
  }

  private toggle(text: string, title: string): HTMLButtonElement {
    return h('button', { class: 'wm-button wm-large-toggle', text, attrs: { type: 'button', title, 'aria-label': title, 'aria-pressed': 'false' } });
  }

  get active(): boolean {
    return !this.el.hidden;
  }

  /** The open file as it is now, in the encoding it was opened in (for saving or downloading it). Untouched, it is the file exactly as it came. */
  snapshot(): Uint8Array | null {
    const doc = this.doc;
    if (!doc) return null;
    if (!doc.edited && this.source.original) return this.source.original;
    return encodeTable(doc.table, this.source.encoding, this.source.bom);
  }

  /** Goes up with every change to the text. */
  get version(): number {
    return this.doc?.version ?? 0;
  }

  get edited(): boolean {
    return this.doc?.edited ?? false;
  }

  get canUndo(): boolean {
    return this.doc?.canUndo ?? false;
  }

  get canRedo(): boolean {
    return this.doc?.canRedo ?? false;
  }

  /** Whether any text is selected. */
  get hasSelection(): boolean {
    return !isCollapsed(this.sel);
  }

  /** Whether the keyboard is in the text (the caret shows only then). */
  get hasFocus(): boolean {
    return this.focused;
  }

  // --- Opening and closing ---

  /** Opens a file's text (as UTF-8). `source` is what it came as, which saving restores: its encoding, and its bytes for as long as it is not edited. */
  open(name: string, bytes: Uint8Array, source: { encoding: TextEncoding; bom: boolean; original: Uint8Array | null } = { encoding: 'utf-8', bom: false, original: bytes }): void {
    this.close();
    this.name = name;
    this.source = source;
    this.doc = new TextDocument(bytes);
    this.abort = new AbortController();
    this.spell?.reset(name, new TextDecoder().decode(bytes.subarray(0, 4000)));
    this.matches = null;
    this.highlight = null;
    this.filtering = false;
    this.toggles.filter.setAttribute('aria-pressed', 'false');
    this.findInput.value = '';
    this.message.textContent = '';
    this.sel = { anchor: { line: 0, col: 0 }, focus: { line: 0, col: 0 } };
    this.goalX = null;
    this.composing = null;
    this.current = -1;
    this.scene.widest = 0;
    this.scene.wrap = this.wrap;
    this.bar.hidden = true;
    this.el.hidden = false;
    const camera = this.deps.camera;
    camera.zoom = 1;
    camera.x = 0;
    camera.y = 0;
    const index = this.doc.index;
    void index
      .build(() => {
        // The lines found so far are shown while the rest is looked for, a few times a second.
        const now = performance.now();
        if (now - this.lastIndexRebuild > 200) {
          this.lastIndexRebuild = now;
          if (this.index === index) this.entriesChanged(true);
        }
      }, this.abort.signal)
      .then(() => {
        if (this.index === index) this.entriesChanged(true);
      });
    this.entriesChanged(false);
    this.focus();
  }

  close(): void {
    this.abort?.abort();
    this.searchAbort?.abort();
    clearTimeout(this.searchTimer);
    cancelAnimationFrame(this.dragFrame);
    this.dragging = false;
    this.doc = null;
    this.matches = null;
    this.remotes.clear();
    this.el.hidden = true;
    this.renderer.reset();
  }

  // --- What is shown ---

  /** How many entries the list has: every line, or just the matching ones when filtering. */
  private get rowCount(): number {
    if (!this.index) return 0;
    return this.filtering && this.matches ? this.matches.length : this.index.count;
  }

  private lineOfRow(row: number): number {
    return this.filtering && this.matches ? this.matches[row] : row;
  }

  private rowOfLine(line: number): number {
    if (!(this.filtering && this.matches)) return line;
    // The first shown line at or after it.
    let lo = 0;
    let hi = this.matches.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.matches[mid] < line) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, Math.max(this.matches.length - 1, 0));
  }

  /** The line at the top of the view. */
  private topLine(): number {
    return this.index ? this.lineOfRow(this.scene.locate(this.deps.camera.y).entry) : 0;
  }

  /** The list changed (the file, the search, the filter, wrapping): the rows are worked out again and what was drawn is forgotten; the view stays at the same line. */
  private entriesChanged(keepPosition: boolean): void {
    if (!this.index) return;
    const line = keepPosition ? this.topLine() : 0;
    this.scene.rebuild();
    this.renderer.reset();
    const camera = this.deps.camera;
    const inset = this.bar.hidden ? 0 : this.bar.offsetHeight / (camera.zoom * CSS_PX_PER_POINT);
    if (keepPosition) camera.y = this.scene.top(this.rowOfLine(line));
    else camera.y = -inset;
    this.deps.render();
  }

  /** The area the text fills, in points, for the camera to keep the view within: the bar, which covers its top, is made room for. */
  bounds(): Rect {
    const content = this.scene.bounds;
    const k = this.deps.camera.zoom * CSS_PX_PER_POINT;
    const top = this.bar.hidden ? 0 : this.bar.offsetHeight / k;
    return { x: content.x, y: -top, width: content.width, height: content.height + top };
  }

  /** Whether long lines are broken to fit the width (else the view scrolls sideways). */
  get wrapping(): boolean {
    return this.wrap;
  }

  setWrap(on: boolean): void {
    this.wrap = on;
    this.scene.wrap = on;
    this.scene.widest = 0;
    try {
      localStorage.setItem(WRAP_KEY, on ? '1' : '0');
    } catch {
      // The choice lasts until the page closes.
    }
    if (on) this.deps.camera.x = 0;
    this.entriesChanged(true);
  }

  /** Draws the text on the canvas, as the (shared) camera sees it. Null when nothing is open. */
  draw(darkPages: boolean, caretOn: boolean): LineFrame | null {
    const index = this.index;
    if (!index) return null;
    const started = performance.now();
    if (this.revealing > 0) this.applyReveal();
    const frame = this.renderer.draw(this.deps.camera, { darkPages, caretVisible: caretOn && this.focused, selection: this.sel, highlight: this.highlight, current: this.current, composing: this.composing, marks: this.spell?.active ? (line, text) => this.marksOf(line, text) : undefined, remotes: this.remotePositions() });
    // Laying lines out settled their heights; a caret still out of view is brought in.
    if (this.revealing > 0) this.applyReveal();
    this.lastFrame = frame;
    this.frameMs = performance.now() - started;
    this.slowestMs = Math.max(this.slowestMs, this.frameMs);
    if (frame.pending) this.deps.render();
    this.moveInput();
    return frame;
  }

  /** The marks to draw in a line: the word being typed (the caret is in it) is not marked until the caret leaves it. */
  private marksOf(line: number, text: string): readonly TextMark[] | undefined {
    const marks = this.spell?.marksOf(text);
    const { anchor, focus } = this.sel;
    if (!marks?.length || line !== focus.line || !samePos(anchor, focus)) return marks;
    return marks.filter((m) => !(m.start < focus.col && focus.col <= m.end));
  }

  private remotePositions(): { color: number; anchor: Pos; focus: Pos }[] | undefined {
    const index = this.index;
    if (!index || !this.remotes.size) return undefined;
    return [...this.remotes.values()].map((p) => ({ color: p.color, anchor: posOf(index, p.anchor), focus: posOf(index, p.focus) }));
  }

  /** The people in the room and where their carets are (null selection: they have none). */
  setPeople(people: readonly { client: string; color: number; selection: { anchor: number; focus: number } | null }[], me: string): void {
    this.remotes = new Map(people.filter((p) => p.client !== me && p.selection).map((p) => [p.client, { color: p.color, ...p.selection! }]));
    this.deps.render();
  }

  private announceSelection(): void {
    const index = this.index;
    if (index && this.onPresence) this.onPresence(offsetOf(index, this.sel.anchor), offsetOf(index, this.sel.focus));
  }

  /** What counts as a mistake changed (the person turned checking on or off, or added or ignored a word): check the lines again. */
  spellReset(): void {
    if (!this.doc) return;
    this.spell?.reset(this.name);
    this.deps.render();
  }

  /**
   * The next problem for the Spelling and Grammar dialog, from the start of the file, or from where the selection starts or ends: it is
   * selected, and described with its suggestions. Null when there is none before the end of the file.
   */
  async spellNext(from: 'documentStart' | 'selectionStart' | 'selectionEnd', grammar: boolean): Promise<SpellIssue | null> {
    const index = this.index;
    const spell = this.spell;
    if (!index || !spell) return null;
    const { from: start, to: end } = ordered(this.sel);
    const origin = from === 'documentStart' ? { line: 0, col: 0 } : from === 'selectionStart' ? start : end;
    const BATCH = 100;
    for (let first = origin.line; first < index.count; first += BATCH) {
      const last = Math.min(first + BATCH, index.count);
      const texts: string[] = [];
      for (let line = first; line < last; line++) texts.push(shown(index, line).text.slice(0, 2000));
      const marks = await spell.scan(texts, grammar);
      if (this.index !== index) return null;
      for (let k = 0; k < texts.length; k++) {
        const line = first + k;
        const mark = marks[k]?.find((m) => line > origin.line || m.start >= origin.col);
        if (!mark) continue;
        const issue = await spell.describe(texts[k]!, mark.start, grammar);
        if (!issue || this.index !== index) return null;
        this.setSelection({ anchor: { line, col: mark.start }, focus: { line, col: mark.end } });
        return issue;
      }
    }
    return null;
  }

  /** The problem under a window point, with the word selected, for the right-click menu; null when there is none. */
  async spellIssueAt(x: number, y: number): Promise<SpellIssue | null> {
    const index = this.index;
    if (!index || !this.spell?.active) return null;
    const point = this.deps.camera.toDocument(x, y);
    const hit = this.scene.inGutter(point.x) ? null : this.scene.pointAt(point.x, point.y);
    if (!hit) return null;
    const { text } = shown(index, hit.line);
    const issue = await this.spell.issueAt(text, hit.col);
    if (!issue || this.index !== index) return null;
    // The problem is a word (or phrase) that touches the click: the nearest place its text is.
    let from = -1;
    for (let at = text.indexOf(issue.text); at >= 0; at = text.indexOf(issue.text, at + 1)) if (at <= hit.col && hit.col <= at + issue.text.length) from = at;
    if (from >= 0) this.setSelection({ anchor: { line: hit.line, col: from }, focus: { line: hit.line, col: from + issue.text.length } });
    return issue;
  }

  /** What the status bar says about the file (null when none is open). */
  footerInfo(): { summary: string; position: string; progress: string; wrap: boolean } | null {
    const index = this.index;
    if (!index) return null;
    return {
      summary: t('textEditor.lines', { count: index.count.toLocaleString() }) + ` · ${sizeText(index.length)}`,
      position: this.rowCount ? t('textEditor.line', { line: (this.topLine() + 1).toLocaleString() }) : '',
      progress: index.done ? '' : t('textEditor.indexing', { percent: Math.floor((index.scanned / Math.max(index.length, 1)) * 100) }),
      wrap: this.wrap,
    };
  }

  // --- Moving ---

  /** Moves the view so a line is a few rows below the top, and marks it. */
  private reveal(line: number, mark = true): void {
    if (!this.index) return;
    const entry = this.rowOfLine(line);
    if (mark) this.current = this.lineOfRow(entry);
    const camera = this.deps.camera;
    const inset = this.bar.hidden ? 0 : this.bar.offsetHeight / (camera.zoom * CSS_PX_PER_POINT);
    camera.y = this.scene.top(Math.max(entry - 3, 0)) - inset;
    this.deps.render();
  }

  goToLine(number: number): void {
    if (!this.index || !Number.isFinite(number)) return;
    this.reveal(Math.min(Math.max(Math.floor(number) - 1, 0), Math.max(this.index.count - 1, 0)));
    this.focus();
  }

  // --- Search ---

  /** Opens the find bar and puts the cursor in it (selected text is not taken: it may be in a line that is no longer shown). */
  find(replace = false): void {
    this.showBar();
    this.replaceRow.hidden = !replace;
    this.findInput.focus();
    this.findInput.select();
  }

  /** Opens the bar with the cursor in the line number box. */
  goTo(): void {
    this.showBar();
    this.replaceRow.hidden = true;
    this.lineInput.focus();
    this.lineInput.select();
  }

  /** The bar sits over the top of the view: opening it moves the text down by its height, so nothing is hidden, and closing it moves it back. */
  private showBar(): void {
    if (!this.bar.hidden) return;
    this.bar.hidden = false;
    const camera = this.deps.camera;
    camera.y -= this.bar.offsetHeight / (camera.zoom * CSS_PX_PER_POINT);
    this.deps.render();
  }

  private closeBar(): void {
    if (!this.bar.hidden) {
      const camera = this.deps.camera;
      camera.y += this.bar.offsetHeight / (camera.zoom * CSS_PX_PER_POINT);
      this.bar.hidden = true;
      this.deps.render();
    }
    this.focus();
  }

  private searchSoon(delay = 150): void {
    clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => void this.search(), delay);
  }

  private readOptions(): SearchOptions {
    return {
      text: this.findInput.value,
      caseSensitive: this.toggles.caseSensitive.getAttribute('aria-pressed') === 'true',
      wholeWord: this.toggles.wholeWord.getAttribute('aria-pressed') === 'true',
      regex: this.toggles.regex.getAttribute('aria-pressed') === 'true',
    };
  }

  private async search(): Promise<void> {
    const index = this.index;
    if (!index) return;
    this.searchAbort?.abort();
    const abort = (this.searchAbort = new AbortController());
    this.options = this.readOptions();
    this.message.classList.remove('wm-large-error');
    if (!this.options.text) {
      this.matches = null;
      this.highlight = null;
      this.message.textContent = '';
      this.entriesChanged(true);
      return;
    }
    if (!compileSearch(this.options)) {
      this.message.textContent = t('textEditor.badRegex');
      this.message.classList.add('wm-large-error');
      return;
    }
    const regex = compileSearch(this.options);
    this.highlight = regex && { regex, wholeWord: this.options.wholeWord };
    const from = this.topLine();
    const result = await searchLines(index, this.options, {
      signal: abort.signal,
      onProgress: (fraction, count) => {
        if (abort.signal.aborted) return;
        this.message.textContent = t('textEditor.searching', { percent: Math.floor(fraction * 100) }) + ` · ${count.toLocaleString()}`;
      },
    });
    if (abort.signal.aborted || this.index !== index) return;
    this.matches = result.lines;
    this.message.textContent = result.lines.length ? t(result.truncated ? 'textEditor.matchesMore' : 'textEditor.matches', { count: result.lines.length.toLocaleString() }) : t('textEditor.noMatches');
    this.entriesChanged(true);
    // The first match from where the view was.
    const first = nextMatch(result.lines, from);
    if (first >= 0 && !this.filtering) this.reveal(first);
    else if (result.lines.length) this.reveal(result.lines[0]);
  }

  /** The next match after the current one (or the top of the view), or the one before it. */
  private step(backward: boolean): void {
    if (!this.matches?.length) {
      this.searchSoon(0);
      return;
    }
    const from = this.current >= 0 ? this.current : this.topLine();
    let line = nextMatch(this.matches, backward ? from - 1 : from + 1, backward);
    // Past the last match, round to the first (and back from the first, to the last).
    if (line < 0) line = backward ? this.matches[this.matches.length - 1] : this.matches[0];
    this.reveal(line);
  }

  // --- Selecting and copying ---

  /** The selected text, or null when none is selected or it is too long to copy. */
  get selectedText(): string | null {
    if (!this.index || isCollapsed(this.sel)) return null;
    return textOfSelection(this.index, this.sel, MAX_COPY_LINES);
  }

  /** Copies the selection (all of it, however many lines are in view). */
  async copy(): Promise<string | null> {
    const text = this.copyText();
    if (text !== null) await writeClipboardText(text);
    return text;
  }

  /** Copies the selection and deletes it. */
  async cut(): Promise<void> {
    if ((await this.copy()) !== null) this.edit(planInsert(this.index!, this.sel, ''));
  }

  /** Puts the clipboard's text at the caret, over the selection. */
  async paste(): Promise<void> {
    this.insert((await readClipboard())?.text ?? '');
    this.focus();
  }

  selectAll(): void {
    const index = this.index;
    if (!index?.count) return;
    this.setSelection({ anchor: { line: 0, col: 0 }, focus: docEnd(index) });
  }

  /** Puts the keyboard focus in the text, so typing and the arrow, page and home/end keys work. */
  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  private get focused(): boolean {
    return document.activeElement === this.input;
  }

  // --- Editing ---

  /** The keyboard and clipboard: typing arrives in the hidden textarea, which is where the browser's input methods work. */
  private listenToInput(): void {
    const input = this.input;
    input.addEventListener('keydown', (e) => this.key(e));
    // Typed text, input methods, copy, cut and paste: the same as in a document (ui/textInput.ts).
    attachTextInput(input, {
      insert: (text) => this.insert(text),
      key: (key) => void this.run(key),
      compose: (preview) => {
        // An input method writes over the selection.
        if (preview === '' && this.composing === null && this.index && !isCollapsed(this.sel)) this.edit(planInsert(this.index, this.sel, ''));
        this.composing = preview;
        this.deps.render();
      },
      copy: () => this.copyText(),
      cut: () => void this.edit(planInsert(this.index!, this.sel, '')),
      paste: (clip) => this.insert(clip.text ?? ''),
    });
    input.addEventListener('focus', () => this.deps.render());
    input.addEventListener('blur', () => this.deps.render());
  }

  /** The selected text for a copy (null: nothing is selected, or too much to copy, which is said). */
  private copyText(): string | null {
    if (isCollapsed(this.sel)) return null;
    const text = this.selectedText;
    if (text === null) this.message.textContent = t('textEditor.copyTooLarge', { max: MAX_COPY_LINES.toLocaleString() });
    return text;
  }

  /** Types text at the caret (over the selection). */
  insert(text: string): void {
    if (!this.index || !text) return;
    this.edit(planInsert(this.index, this.sel, text, text.length <= 2 && !/[\r\n]/.test(text) ? 'type' : null));
  }

  /** Why an edit cannot be made now (the file is still being indexed, or while showing only matching lines it would add, join or remove lines), or null. */
  private refusal(plan: Plan): string | null {
    const doc = this.doc;
    if (this.readOnly) return t('textEditor.readOnly');
    if (!doc || this.busy || this.frozen) return t('textEditor.busy');
    if (!doc.index.done) return t('textEditor.indexingFirst');
    const lines = doc.index.lineAt(plan.at) !== doc.index.lineAt(plan.at + plan.removeLength) || plan.insert.includes(10) || plan.insert.includes(13);
    return this.filtering && lines ? t('textEditor.filterEdit') : null;
  }

  /** Makes an edit, unless it is refused (and says why). */
  private edit(plan: Plan | null): boolean {
    const doc = this.doc;
    if (!doc || !plan) return false;
    const refused = this.refusal(plan);
    if (refused) {
      this.message.textContent = refused;
      return false;
    }
    const change = doc.replace(plan.at, plan.removeLength, plan.insert, plan.group);
    if (!change) return false;
    this.changed(change, plan.caret);
    return true;
  }

  /** The first lines of the text, for a thumbnail. */
  headLines(count = 60): string[] {
    const doc = this.doc;
    if (!doc) return [];
    return new TextDecoder().decode(doc.table.slice(0, Math.min(doc.table.length, 12_000))).split(/\r\n|\r|\n/).slice(0, count);
  }

  /** Bytes of the text. */
  get size(): number {
    return this.doc?.table.length ?? 0;
  }

  /** Whether the file is edited together with others. */
  get shared(): boolean {
    return this.doc?.shared ?? false;
  }

  /** Starts sending changes to a room (see textSync.ts). */
  share(replica: TextReplica, client: string): void {
    this.doc?.share(replica, client);
    this.onState?.();
  }

  unshare(): void {
    this.doc?.unshare();
    this.onState?.();
  }

  /** The text as it is, in UTF-8 (what a room starts from). */
  flatten(): Uint8Array {
    return this.doc?.table.flatten() ?? new Uint8Array(0);
  }

  /** Others' changes arrived: they are put in, and the caret and selection stay where they were in the text. */
  applyRemote(ops: readonly TextOp[]): void {
    const doc = this.doc;
    const index = this.index;
    if (!doc || !index) return;
    const anchor = mapOffset(offsetOf(index, this.sel.anchor), ops);
    const focus = mapOffset(offsetOf(index, this.sel.focus), ops);
    const change = doc.remote(ops);
    if (!change) return;
    this.changed(change, 0, false);
    this.sel = { anchor: posOf(index, anchor), focus: posOf(index, focus) };
    for (const person of this.remotes.values()) {
      person.anchor = mapOffset(person.anchor, ops);
      person.focus = mapOffset(person.focus, ops);
    }
    this.current = -1;
    this.deps.render();
  }

  undo(): void {
    const change = this.doc?.undo();
    if (change) this.changed(change);
  }

  redo(): void {
    const change = this.doc?.redo();
    if (change) this.changed(change);
  }

  /** Brings the view up to date with a change to the text, and puts the caret where it belongs. */
  private changed(change: Change, caret = change.caret, moveCaret = true): void {
    const index = this.index;
    if (!index) return;
    if (change.whole) {
      const searched = this.matches !== null;
      this.matches = null;
      this.scene.widest = 0;
      this.entriesChanged(false);
      if (searched && this.options.text) this.searchSoon(100);
    } else if (change.lineDelta) {
      // Lines were added or removed: where every line after them is has changed.
      this.entriesChanged(true);
    } else {
      this.scene.forget(change.firstLine, change.lastLine);
      this.renderer.forgetFrom(this.rowOfLine(change.firstLine), this.rowOfLine(change.lastLine));
    }
    // Lines moved, so the lines that matched are not known any more: look again a moment after typing stops.
    // (Showing only matching lines, an undo can still add or remove lines, and the list of them is then wrong.)
    if (this.matches && this.options.text && (!this.filtering || change.lineDelta !== 0)) {
      this.matches = null;
      this.searchSoon(this.filtering ? 0 : 400);
    }
    if (moveCaret) {
      const at = posOf(index, caret);
      this.sel = { anchor: at, focus: at };
      this.goalX = null;
      this.current = -1;
      this.revealCaret();
      this.announceSelection();
    }
    this.onEdit?.();
  }

  setSelection(sel: Selection, keepGoal = false): void {
    const index = this.index;
    if (!index) return;
    this.sel = { anchor: clampPos(index, sel.anchor), focus: clampPos(index, sel.focus) };
    if (!keepGoal) this.goalX = null;
    this.revealCaret();
    this.onState?.();
    this.announceSelection();
  }

  /** Pans the camera, over the next few frames (row heights settle as lines are laid out), until the caret is in view. */
  private revealCaret(): void {
    this.revealing = 4;
    this.deps.render();
  }

  private applyReveal(): void {
    const camera = this.deps.camera;
    const box = this.scene.caretBox(this.sel.focus);
    if (!box) return;
    this.revealing--;
    const k = camera.zoom * CSS_PX_PER_POINT;
    const margin = REVEAL_MARGIN_PX / k;
    const viewHeight = camera.height / camera.scale;
    const viewWidth = camera.width / camera.scale;
    const top = this.bar.hidden ? 0 : this.bar.offsetHeight / k;
    // The view moves only when the caret is out of it (or under the bar), and then to leave some room around it.
    let y = camera.y;
    if (box.y < y + top) y = box.y - top - margin;
    else if (box.y + LINE > y + viewHeight) y = box.y + LINE - viewHeight + margin;
    let x = camera.x;
    if (box.x < x) x = box.x <= this.scene.textLeft + 2 * CELL ? 0 : box.x - margin;
    else if (box.x > x + viewWidth) x = box.x - viewWidth + margin;
    if (y !== camera.y || x !== camera.x) {
      camera.y = y;
      camera.x = x;
      this.deps.render();
    } else this.revealing = 0;
  }

  /** The textarea goes where the caret is, so an input method's window opens there. */
  private moveInput(): void {
    const camera = this.deps.camera;
    const box = this.scene.caretBox(this.sel.focus);
    if (!box) return;
    const k = camera.zoom * CSS_PX_PER_POINT;
    this.input.style.left = `${(box.x - camera.x) * k}px`;
    this.input.style.top = `${(box.y - camera.y) * k}px`;
    this.input.style.height = `${LINE * k}px`;
  }

  // --- Replacing ---

  /** The replacement as String.replace takes it: what was typed when searching by regular expression (where `$1` means a group), else taken literally. */
  private replacement(options: SearchOptions): string {
    return options.regex ? this.replaceInput.value : escapeReplacement(this.replaceInput.value);
  }

  /** Replaces the selection if it is a match, and selects the next match after it. */
  private async replaceCurrent(): Promise<void> {
    const index = this.index;
    const options = this.readOptions();
    const regex = compileSearch(options);
    if (!index?.done || !regex || this.busy) return;
    this.options = options;
    this.highlight = { regex, wholeWord: options.wholeWord };
    const { from, to } = ordered(this.sel);
    if (from.line === to.line && from.col < to.col) {
      const found = findInText(shown(index, from.line).text, regex, options.wholeWord).find((m) => m.index === from.col);
      if (found && found[0].length === to.col - from.col) {
        if (!this.edit(planInsert(index, this.sel, expandReplacement(found, this.replacement(options))))) return;
      }
    }
    const next = await this.matchFrom(this.sel.focus, regex, options.wholeWord);
    if (!next) {
      this.message.textContent = t('textEditor.noMatches');
      return;
    }
    this.current = next.line;
    this.setSelection({ anchor: { line: next.line, col: next.from }, focus: { line: next.line, col: next.to } });
  }

  /** The first match at or after a position, going on to the start of the file after the last line. */
  private async matchFrom(pos: Pos, regex: RegExp, wholeWord: boolean): Promise<{ line: number; from: number; to: number } | null> {
    const index = this.index;
    if (!index?.count) return null;
    const total = index.count;
    for (let step = 0; step <= total; step++) {
      const line = (pos.line + step) % total;
      const { text } = shown(index, line);
      const m = findInText(text, regex, wholeWord).find((found) => step > 0 || found.index >= pos.col);
      if (m) return { line, from: m.index, to: m.index + m[0].length };
      if (step % 4000 === 3999) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (this.index !== index) return null;
      }
    }
    return null;
  }

  /** Replaces every match in the file, as one change that can be undone: how many, or null when it cannot be done now. `replacement` is a String.replace replacement. */
  private async replaceAllWith(options: SearchOptions, replacement: string): Promise<number | null> {
    const doc = this.doc;
    if (!doc || this.busy || !doc.index.done) return null;
    const version = doc.version;
    this.busy = true;
    try {
      if (doc.shared) {
        // Edited together the whole text cannot be swapped: the matches go in as changes the room can order (and each person can undo as one).
        const ops = await replaceRangesOf(doc.index, options, replacement, { onProgress: (fraction) => (this.message.textContent = t('textEditor.replacing', { percent: Math.floor(fraction * 100) })) });
        if (this.doc !== doc || doc.version !== version) return null;
        if (!ops) {
          this.message.textContent = t('textEditor.sharedTooMany', { max: MAX_SHARED_REPLACEMENTS.toLocaleString(this.deps.locale()) });
          return null;
        }
        const change = doc.replaceRanges(ops);
        if (change) this.changed(change);
        return ops.length;
      }
      const result = await replaceAllLines(doc.index, options, replacement, {
        onProgress: (fraction) => (this.message.textContent = t('textEditor.replacing', { percent: Math.floor(fraction * 100) })),
      });
      if (!result?.count) return 0;
      const table = new PieceTable(result.bytes);
      const next = new LineIndex(table);
      await next.build();
      // Typing is held off while this runs, but the document could still have been closed or replaced.
      if (this.doc !== doc || doc.version !== version) return null;
      this.changed(doc.swap({ table, index: next }));
      return result.count;
    } finally {
      this.busy = false;
    }
  }

  /** The Replace all button. */
  private async replaceEverywhere(): Promise<void> {
    const doc = this.doc;
    if (!doc || this.busy) return;
    if (!doc.index.done) {
      this.message.textContent = t('textEditor.indexingFirst');
      return;
    }
    const options = this.readOptions();
    if (!compileSearch(options)) {
      this.message.textContent = t(options.text ? 'textEditor.badRegex' : 'textEditor.replaceNone');
      return;
    }
    const count = await this.replaceAllWith(options, this.replacement(options));
    this.message.textContent = count ? t('textEditor.replaced', { count: count.toLocaleString() }) : t('textEditor.replaceNone');
  }

  // --- For the assistant ---
  // Lines are numbered from 1, as the gutter shows them. Each answers in words for the model; "Error:" says it did nothing.

  /** What the model is told about the open file. */
  describe(): string {
    const index = this.index;
    if (!index) return '';
    return `a large text file in the large-text editor: ${index.count.toLocaleString('en-US')} lines, ${sizeText(index.length)}${index.done ? '' : ' (still being indexed: wait before editing)'}. It has lines, not paragraphs`;
  }

  read(start: number, count: number): string {
    return this.index ? readLines(this.index, start, count) : 'Error: no large text file is open.';
  }

  async findAll(options: SearchOptions): Promise<string> {
    const index = this.index;
    if (!index) return 'Error: no large text file is open.';
    if (!options.text) return 'Error: `text` is what to find.';
    if (!compileSearch(options)) return `Error: ${t('textEditor.badRegex')}.`;
    const result = await searchLines(index, options, { limit: 100_000 });
    return describeMatches(index, result.lines, result.truncated);
  }

  /** Replaces every match in the file (as the Replace all button does). */
  async replaceFile(options: SearchOptions, replacement: string): Promise<string> {
    if (!this.doc) return 'Error: no large text file is open.';
    if (!options.text) return 'Error: `text` is what to find.';
    if (!compileSearch(options)) return `Error: ${t('textEditor.badRegex')}.`;
    const count = await this.replaceAllWith(options, options.regex ? replacement : replacement.replace(/\$/g, '$$$$'));
    if (count === null) return 'Error: it could not be done now (the file is still being indexed, or another change is under way).';
    return count ? `Replaced ${count.toLocaleString('en-US')} matches; undo steps back.` : 'No line matches, so nothing was replaced.';
  }

  /** Makes an edit that a line tool planned, or says why not. */
  private applyPlanned(plan: Plan | string, done: string): string {
    if (typeof plan === 'string') return plan;
    const refused = this.refusal(plan);
    if (refused) return `Error: ${refused}`;
    return this.edit(plan) ? done : 'Error: nothing changed.';
  }

  editLines(first: number, last: number, text: string): string {
    if (!this.index) return 'Error: no large text file is open.';
    return this.applyPlanned(planReplaceLines(this.index, first, last, text), `Replaced lines ${first} to ${last}; undo steps back. Line numbers after them may have changed.`);
  }

  insertLines(after: number, text: string): string {
    if (!this.index) return 'Error: no large text file is open.';
    return this.applyPlanned(planInsertLines(this.index, after, text), `Inserted the lines after line ${after}; undo steps back. Line numbers after them have moved.`);
  }

  deleteLines(first: number, last: number): string {
    if (!this.index) return 'Error: no large text file is open.';
    return this.applyPlanned(planDeleteLines(this.index, first, last), `Deleted lines ${first} to ${last}; undo steps back. Line numbers after them have moved.`);
  }

  undoStep(): string {
    if (!this.canUndo) return 'There is nothing to undo.';
    this.undo();
    return 'Undid the last change.';
  }

  redoStep(): string {
    if (!this.canRedo) return 'There is nothing to redo.';
    this.redo();
    return 'Redid the change.';
  }

  // --- Pointer ---
  // The app's canvas hands the pointer over: x and y are CSS pixels on it.

  /** Whether a button is down on the text (the app sends moves to `drag` meanwhile). */
  get isDragging(): boolean {
    return this.dragging;
  }

  /** A press: puts the caret down, selects a word or a line for a double or triple click, or a line by its number. */
  press(x: number, y: number, shift: boolean, clicks: number): void {
    const index = this.index;
    if (!index) return;
    this.focus();
    const point = this.deps.camera.toDocument(x, y);
    const hit = this.scene.pointAt(point.x, point.y);
    if (!hit) return;
    if (this.scene.inGutter(point.x)) {
      // The number selects the whole line (and, with Shift, every line down to it).
      const anchorLine = shift ? this.sel.anchor.line : hit.line;
      this.setSelection(hit.line >= anchorLine ? { anchor: { line: anchorLine, col: 0 }, focus: lineEnd(index, hit.line) } : { anchor: lineEnd(index, anchorLine), focus: { line: hit.line, col: 0 } });
      return;
    }
    const { text } = shown(index, hit.line);
    if (clicks >= 3) this.setSelection({ anchor: { line: hit.line, col: 0 }, focus: lineEnd(index, hit.line) });
    else if (clicks === 2) {
      const word = wordAt(text, hit.col);
      this.setSelection({ anchor: { line: hit.line, col: word.from }, focus: { line: hit.line, col: word.to } });
    } else this.setSelection({ anchor: shift ? this.sel.anchor : hit, focus: hit });
    this.dragging = clicks < 2;
    this.pointer = { x, y };
  }

  /** The pointer moved with the button down: the selection follows it (once a frame), and the view scrolls when it is past an edge. */
  drag(x: number, y: number): void {
    if (!this.dragging) return;
    this.pointer = { x, y };
    this.followPointer();
    // Past the top or bottom edge the text keeps scrolling, even while the pointer is still.
    if (!this.dragFrame && this.beyondEdge() !== 0) this.dragFrame = requestAnimationFrame(() => this.dragStep());
  }

  release(): void {
    this.dragging = false;
  }

  /** How far (CSS pixels) the pointer is above the top of the canvas or below its bottom; 0 inside. */
  private beyondEdge(): number {
    const camera = this.deps.camera;
    const height = camera.height / camera.dpr;
    return this.pointer.y < 0 ? this.pointer.y : this.pointer.y > height ? this.pointer.y - height : 0;
  }

  /** The selection's end goes to where the pointer is (clamped to the canvas). */
  private followPointer(): void {
    const camera = this.deps.camera;
    const height = camera.height / camera.dpr;
    const point = camera.toDocument(this.pointer.x, Math.min(Math.max(this.pointer.y, 0), height));
    const hit = this.scene.pointAt(point.x, point.y);
    if (hit && !samePos(hit, this.sel.focus)) {
      this.sel = { anchor: this.sel.anchor, focus: hit };
      this.deps.render();
      this.onState?.();
    }
  }

  private dragStep(): void {
    this.dragFrame = 0;
    if (!this.dragging || !this.index) return;
    const over = this.beyondEdge();
    if (over) this.deps.camera.panBy(0, Math.sign(over) * Math.min(Math.abs(over) / 2 + 10, 150));
    this.followPointer();
    this.deps.render();
    if (over) this.dragFrame = requestAnimationFrame(() => this.dragStep());
  }

  // --- For tests ---

  /** What is on screen, as text: for tests (and debugging), since the text is drawn by the GPU. */
  debugState(): {
    lines: number;
    indexed: boolean;
    zoom: number;
    columns: number;
    wrap: boolean;
    caret: Pos;
    anchor: Pos;
    selected: string | null;
    topLine: number;
    visible: { line: number; text: string }[];
    version: number;
    glyphs: number;
    chunks: number;
    drawCalls: number;
    filtering: boolean;
    current: number;
    cameraX: number;
    composing: string | null;
    frameMs: number;
    slowestMs: number;
    marks: { line: number; text: string; kind: number }[];
    /** Where other people's carets are. */
    remotes: Pos[];
  } | null {
    const index = this.index;
    if (!index) return null;
    const camera = this.deps.camera;
    const first = this.scene.locate(camera.y).entry;
    const last = this.scene.locate(camera.y + camera.height / camera.scale).entry;
    const visible: { line: number; text: string }[] = [];
    for (let entry = first; entry <= last && entry < this.rowCount && visible.length < 400; entry++) {
      const line = this.lineOfRow(entry);
      visible.push({ line, text: this.scene.layout(line).text });
    }
    return {
      lines: index.count,
      indexed: index.done,
      zoom: camera.zoom,
      columns: this.scene.columns,
      wrap: this.wrap,
      caret: this.sel.focus,
      anchor: this.sel.anchor,
      selected: this.selectedText,
      topLine: this.topLine(),
      visible,
      version: this.version,
      glyphs: this.lastFrame?.glyphs ?? 0,
      chunks: this.lastFrame?.chunks ?? 0,
      drawCalls: this.lastFrame?.drawCalls ?? 0,
      filtering: this.filtering,
      current: this.current,
      cameraX: camera.x,
      composing: this.composing,
      frameMs: this.frameMs,
      slowestMs: this.slowestMs,
      remotes: (this.remotePositions() ?? []).map((p) => p.focus),
      marks: visible.flatMap((v) => (this.spell?.marksOf(v.text) ?? []).map((m) => ({ line: v.line, text: v.text.slice(m.start, m.end), kind: m.kind }))),
    };
  }

  /** Where a line and column are on the canvas, in CSS pixels (the middle of the row): where a test clicks. */
  pointOf(pos: Pos): { x: number; y: number } | null {
    const box = this.scene.caretBox(pos);
    if (!box) return null;
    const camera = this.deps.camera;
    const k = camera.zoom * CSS_PX_PER_POINT;
    return { x: (box.x - camera.x) * k, y: (box.y - camera.y + LINE / 2) * k };
  }

  /** Where a line's number is on the canvas, in CSS pixels. */
  numberPoint(line: number): { x: number; y: number } | null {
    const box = this.scene.caretBox({ line, col: 0 });
    if (!box) return null;
    const camera = this.deps.camera;
    const k = camera.zoom * CSS_PX_PER_POINT;
    return { x: (this.scene.gutterWidth / 2 - camera.x) * k, y: (box.y - camera.y + LINE / 2) * k };
  }

  // --- Keys ---

  private key(e: KeyboardEvent): void {
    if (!this.index || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      if (!isCollapsed(this.sel)) this.setSelection({ anchor: this.sel.focus, focus: this.sel.focus });
      return;
    }
    const key = editKey(e);
    // Undo, redo and select all are the app's own (its menus and shortcuts); Shift+Tab leaves the text, so the keyboard is not trapped in it; Ctrl+Enter is not a line break.
    if (key && key.kind !== 'selectAll' && key.kind !== 'undo' && key.kind !== 'redo') {
      if (key.kind === 'tab' && (key.backward || e.ctrlKey || e.metaKey || e.altKey)) return;
      if (key.kind === 'enter' && (e.ctrlKey || e.metaKey)) return;
      if (this.run(key)) e.preventDefault();
      return;
    }
    if (key) return;
    // Ctrl/Cmd+S, and the keys the app itself acts on (zoom, fit), are not typing.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.onSave?.();
    } else if (e.altKey && e.code === 'KeyZ') {
      e.preventDefault();
      this.setWrap(!this.wrap);
    } else if ((((e.metaKey || e.ctrlKey) && ['=', '+', '-', '0'].includes(e.key)) || (e.altKey && e.code === 'KeyF')) && this.deps.viewKey(e)) {
      e.preventDefault();
    }
  }

  /** Does what an editing key asks for; false when it is not one the text editor acts on. */
  private run(key: EditKey): boolean {
    const index = this.index;
    if (!index) return false;
    const { from, to } = ordered(this.sel);
    const collapsed = isCollapsed(this.sel);
    const focus = this.sel.focus;
    switch (key.kind) {
      case 'move': {
        const { text, length } = shown(index, focus.line);
        const page = Math.max(Math.floor(this.deps.camera.height / this.deps.camera.scale / LINE) - 1, 1);
        let target: Pos | null = null;
        let keepGoal = false;
        switch (key.to) {
          case 'left':
          case 'wordLeft':
            if (!key.extend && !collapsed) target = from;
            else if (focus.col > 0) target = { line: focus.line, col: (key.to === 'wordLeft' ? stepWord : stepCol)(text, focus.col, -1) };
            else target = focus.line > 0 ? lineEnd(index, focus.line - 1) : focus;
            break;
          case 'right':
          case 'wordRight':
            if (!key.extend && !collapsed) target = to;
            else if (focus.col < length) target = { line: focus.line, col: (key.to === 'wordRight' ? stepWord : stepCol)(text, focus.col, 1) };
            else target = focus.line + 1 < index.count ? { line: focus.line + 1, col: 0 } : focus;
            break;
          case 'up':
          case 'down':
            target = this.vertical(key.to === 'up' ? -1 : 1, 1);
            keepGoal = true;
            break;
          case 'pageUp':
          case 'pageDown':
            target = this.vertical(key.to === 'pageUp' ? -1 : 1, page);
            keepGoal = true;
            break;
          case 'lineStart':
            target = { line: focus.line, col: 0 };
            break;
          case 'lineEnd':
            target = lineEnd(index, focus.line);
            break;
          case 'documentStart':
            target = { line: 0, col: 0 };
            break;
          case 'documentEnd':
            target = docEnd(index);
            break;
        }
        if (target) this.setSelection({ anchor: key.extend ? this.sel.anchor : target, focus: target }, keepGoal);
        return true;
      }
      case 'delete':
        if (key.direction === 'forward') this.edit(planDelete(index, this.sel, key.unit === 'word'));
        else if (key.unit === 'line') this.edit(planInsert(index, { anchor: { line: focus.line, col: 0 }, focus: collapsed ? focus : to }, ''));
        else this.edit(planBackspace(index, this.sel, key.unit === 'word'));
        return true;
      case 'enter':
        this.insert('\n');
        return true;
      case 'tab':
        this.insert('\t');
        return true;
      default:
        return false;
    }
  }

  /** The position a number of rows above or below the caret, in the same column on screen (the text rows are laid out the same everywhere, so this is arithmetic). */
  private vertical(direction: -1 | 1, rows: number): Pos | null {
    const box = this.scene.caretBox(this.sel.focus);
    if (!box) return null;
    this.goalX ??= box.x;
    return this.scene.pointAt(this.goalX + 0.01, box.y + LINE / 2 + direction * rows * LINE);
  }

  get fileName(): string {
    return this.name;
  }
}
