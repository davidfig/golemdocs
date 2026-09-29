// A viewer for text files too big to be a document (see docs/large-text-files.md): the file stays bytes,
// lines are found by a LineIndex, and only the lines in view are in the page. Scrolling any distance is one
// jump, search runs over the bytes in the background, and "show only matching lines" turns a log into
// what matched. Lines can be selected by their numbers and copied.

import { t } from '../i18n/index.ts';
import { h } from '../ui/dom.ts';
import { LineIndex, lineText, linesText } from './lineIndex.ts';
import { compileSearch, nextMatch, searchLines } from './search.ts';
import type { SearchOptions } from './search.ts';
import './view.css';

/** Elements taller than this misbehave in browsers (about 33 million pixels), so a longer file scrolls through a shorter one. */
const MAX_SCROLL_HEIGHT = 30_000_000;
const OVERSCAN = 20;
const MAX_COPY_LINES = 500_000;
const BASE_SIZE = 13;

export interface LargeTextHost {
  notify(message: string): void;
}

const level = (text: string): string =>
  /\b(ERROR|FATAL|SEVERE|CRITICAL|Exception)\b/.test(text) ? 'wm-large-error' : /\b(WARN|WARNING)\b/.test(text) ? 'wm-large-warn' : /\b(DEBUG|TRACE)\b/.test(text) ? 'wm-large-dim' : '';

const sizeText = (n: number): string => (n < 1 << 20 ? `${Math.round(n / 1024)} KB` : `${(n / (1 << 20)).toFixed(n < 10 << 20 ? 1 : 0)} MB`);

export class LargeTextView {
  readonly el = h('div', { class: 'wm-large', attrs: { hidden: '' } });
  private readonly scroller = h('div', { class: 'wm-large-scroll', attrs: { tabindex: '0', role: 'document' } });
  private readonly spacer = h('div', { class: 'wm-large-spacer' });
  private readonly rows = h('div', { class: 'wm-large-rows' });
  private readonly bar = h('div', { class: 'wm-large-bar', attrs: { hidden: '' } });
  private readonly findInput = h('input', { class: 'wm-input', attrs: { type: 'text', placeholder: t('largeText.findPlaceholder'), 'aria-label': t('largeText.find'), spellcheck: 'false' } });
  private readonly lineInput = h('input', { class: 'wm-input wm-large-line', attrs: { type: 'number', min: '1', placeholder: t('largeText.goTo'), 'aria-label': t('largeText.goTo') } });
  private readonly message = h('span', { class: 'wm-large-message', attrs: { 'aria-live': 'polite' } });
  private readonly status = h('div', { class: 'wm-large-status' });
  private readonly statusLines = h('span');
  private readonly statusPosition = h('span');
  private readonly statusProgress = h('span');
  private readonly toggles: Record<'caseSensitive' | 'wholeWord' | 'regex' | 'filter', HTMLButtonElement>;

  private index: LineIndex | null = null;
  private name = '';
  private abort: AbortController | null = null;
  private searchAbort: AbortController | null = null;
  private searchTimer = 0;
  private fontSize = BASE_SIZE;
  /** Lines that match the search, ascending; null with no search. */
  private matches: Uint32Array | null = null;
  private options: SearchOptions = { text: '', caseSensitive: false, wholeWord: false, regex: false };
  private filtering = false;
  private highlight: RegExp | null = null;
  /** The line the last search step landed on. */
  private current = -1;
  private selection: { anchor: number; focus: number } | null = null;
  private widest = 0;
  private frame = 0;
  private lineHeight = 19;

  constructor(parent: HTMLElement) {
    this.toggles = {
      caseSensitive: this.toggle('Aa', t('largeText.matchCase')),
      wholeWord: this.toggle('W', t('largeText.wholeWord')),
      regex: this.toggle('.*', t('largeText.regex')),
      filter: this.toggle('☰', t('largeText.filter')),
    };
    const previous = h('button', { class: 'wm-button', text: '↑', attrs: { type: 'button', title: t('largeText.previous'), 'aria-label': t('largeText.previous') } });
    const next = h('button', { class: 'wm-button', text: '↓', attrs: { type: 'button', title: t('largeText.next'), 'aria-label': t('largeText.next') } });
    const close = h('button', { class: 'wm-button', text: '×', attrs: { type: 'button', title: t('largeText.close'), 'aria-label': t('largeText.close') } });
    this.bar.append(this.findInput, this.toggles.caseSensitive, this.toggles.wholeWord, this.toggles.regex, previous, next, this.toggles.filter, this.message, this.lineInput, close);
    this.spacer.append(this.rows);
    this.scroller.append(this.spacer);
    this.status.append(this.statusLines, this.statusPosition, this.statusProgress);
    this.el.append(this.bar, this.scroller, this.status);
    parent.append(this.el);

    this.scroller.addEventListener('scroll', () => this.schedule());
    new ResizeObserver(() => this.schedule()).observe(this.scroller);
    this.rows.addEventListener('pointerdown', (e) => this.select(e));
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
    for (const input of [this.findInput, this.lineInput]) input.addEventListener('keydown', (e) => e.stopPropagation());
    previous.addEventListener('click', () => this.step(true));
    next.addEventListener('click', () => this.step(false));
    close.addEventListener('click', () => this.closeBar());
    for (const [key, button] of Object.entries(this.toggles) as [keyof typeof this.toggles, HTMLButtonElement][]) {
      button.addEventListener('click', () => {
        button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
        if (key === 'filter') {
          this.filtering = button.getAttribute('aria-pressed') === 'true';
          this.refresh(true);
        } else this.searchSoon(0);
      });
    }
    this.scroller.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && this.selection) {
        e.preventDefault();
        void this.copy();
      }
    });
  }

  private toggle(text: string, title: string): HTMLButtonElement {
    return h('button', { class: 'wm-button wm-large-toggle', text, attrs: { type: 'button', title, 'aria-label': title, 'aria-pressed': 'false' } });
  }

  get active(): boolean {
    return !this.el.hidden;
  }

  /** The bytes of the open file (for downloading it as it was). */
  get bytes(): Uint8Array | null {
    return this.index?.bytes ?? null;
  }

  // --- Opening and closing ---

  open(name: string, bytes: Uint8Array): void {
    this.close();
    this.name = name;
    this.index = new LineIndex(bytes);
    this.abort = new AbortController();
    this.matches = null;
    this.filtering = false;
    this.toggles.filter.setAttribute('aria-pressed', 'false');
    this.findInput.value = '';
    this.message.textContent = '';
    this.selection = null;
    this.current = -1;
    this.widest = 0;
    this.el.hidden = false;
    this.scroller.scrollTop = 0;
    this.scroller.scrollLeft = 0;
    this.applySize();
    const index = this.index;
    void index.build(() => this.refresh(false), this.abort.signal).then(() => {
      if (this.index === index) this.refresh(false);
    });
    this.refresh(false);
    this.scroller.focus();
  }

  close(): void {
    this.abort?.abort();
    this.searchAbort?.abort();
    clearTimeout(this.searchTimer);
    this.index = null;
    this.matches = null;
    this.el.hidden = true;
    this.rows.replaceChildren();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  // --- What is shown ---

  /** How many rows the list has: every line, or just the matching ones when filtering. */
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

  private get totalHeight(): number {
    return this.rowCount * this.lineHeight;
  }

  /** Scroll pixels per row: 1 row per line height, less when the file is too tall for the browser to scroll. */
  private get ratio(): number {
    return Math.max(1, this.totalHeight / MAX_SCROLL_HEIGHT);
  }

  private get topRow(): number {
    return Math.floor((this.scroller.scrollTop * this.ratio) / this.lineHeight);
  }

  private schedule(): void {
    if (this.frame || !this.index) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /** The list, its height and the readouts, after the file or the search or the filter changed. */
  private refresh(keepPosition: boolean): void {
    if (!this.index) return;
    const line = this.lineOfRow(this.topRow);
    this.spacer.style.height = `${Math.min(this.totalHeight, MAX_SCROLL_HEIGHT)}px`;
    if (keepPosition) this.scroller.scrollTop = (this.rowOfLine(line) * this.lineHeight) / this.ratio;
    this.render();
  }

  private applySize(): void {
    this.lineHeight = Math.round(this.fontSize * 1.45);
    this.scroller.style.setProperty('--wm-large-size', `${this.fontSize}px`);
    this.scroller.style.setProperty('--wm-large-line', `${this.lineHeight}px`);
  }

  /** Text size, by a factor; 1 with `reset`. */
  zoomBy(factor: number, reset = false): void {
    const line = this.index ? this.lineOfRow(this.topRow) : 0;
    this.fontSize = reset ? BASE_SIZE : Math.min(Math.max(this.fontSize * factor, 8), 40);
    this.applySize();
    this.refresh(false);
    this.scroller.scrollTop = (this.rowOfLine(line) * this.lineHeight) / this.ratio;
    this.render();
  }

  private render(): void {
    const index = this.index;
    if (!index) return;
    const digits = String(Math.max(index.count, 1)).length;
    const total = this.rowCount;
    this.spacer.style.height = `${Math.min(this.totalHeight, MAX_SCROLL_HEIGHT)}px`;
    const visible = Math.ceil(this.scroller.clientHeight / this.lineHeight) + 2;
    const first = Math.max(this.topRow - OVERSCAN, 0);
    const last = Math.min(this.topRow + visible + OVERSCAN, total) - 1;
    // The rows sit where their first row belongs in the (possibly compressed) scroll range.
    this.rows.style.transform = `translateY(${(first * this.lineHeight) / this.ratio}px)`;
    const fragment = document.createDocumentFragment();
    const selected = this.selection ? [Math.min(this.selection.anchor, this.selection.focus), Math.max(this.selection.anchor, this.selection.focus)] : null;
    for (let row = first; row <= last; row++) {
      const line = this.lineOfRow(row);
      if (line >= index.available && !index.done) break;
      const { text, more } = lineText(index, line);
      const el = h('div', { class: `wm-large-row ${level(text)}${selected && line >= selected[0] && line <= selected[1] ? ' wm-large-selected' : ''}${line === this.current ? ' wm-large-current' : ''}` });
      el.dataset.line = String(line);
      const number = h('span', { class: 'wm-large-num', text: String(line + 1) });
      number.style.width = `${digits}ch`;
      const body = h('span', { class: 'wm-large-text' });
      this.fill(body, text);
      if (more) body.append(h('span', { class: 'wm-large-more', text: `… ${more.toLocaleString()} B` }));
      el.append(number, body);
      fragment.append(el);
      this.widest = Math.max(this.widest, text.length + digits + 4);
    }
    this.rows.replaceChildren(fragment);
    this.rows.style.minWidth = `${this.widest}ch`;
    this.spacer.style.minWidth = `${this.widest}ch`;
    this.statusLines.textContent = t('largeText.lines', { count: index.count.toLocaleString() }) + ` · ${sizeText(index.bytes.length)}`;
    this.statusPosition.textContent = total ? t('largeText.line', { line: (this.lineOfRow(Math.min(this.topRow, total - 1)) + 1).toLocaleString() }) : '';
    this.statusProgress.textContent = index.done ? '' : t('largeText.indexing', { percent: Math.floor((index.scanned / Math.max(index.bytes.length, 1)) * 100) });
  }

  /** A line's text, with the search's matches marked. */
  private fill(el: HTMLElement, text: string): void {
    const regex = this.highlight;
    if (!regex || !text) {
      el.textContent = text;
      return;
    }
    let last = 0;
    for (const m of text.matchAll(regex)) {
      if (!m[0]) continue;
      if (m.index > last) el.append(text.slice(last, m.index));
      el.append(h('mark', { text: m[0] }));
      last = m.index + m[0].length;
    }
    el.append(text.slice(last));
  }

  // --- Moving ---

  /** Scrolls so a line is at the top (a few rows down from it), and marks it. */
  private reveal(line: number, mark = true): void {
    if (!this.index) return;
    const row = this.rowOfLine(line);
    if (mark) this.current = this.lineOfRow(row);
    const target = Math.max(row - 3, 0);
    this.scroller.scrollTop = (target * this.lineHeight) / this.ratio;
    this.render();
  }

  goToLine(number: number): void {
    if (!this.index || !Number.isFinite(number)) return;
    this.reveal(Math.min(Math.max(Math.floor(number) - 1, 0), Math.max(this.index.count - 1, 0)));
    this.scroller.focus();
  }

  // --- Search ---

  /** Opens the find bar and puts the cursor in it (selected text is not taken: it may be in a line that is no longer shown). */
  find(): void {
    this.bar.hidden = false;
    this.findInput.focus();
    this.findInput.select();
  }

  /** Opens the bar with the cursor in the line number box. */
  goTo(): void {
    this.bar.hidden = false;
    this.lineInput.focus();
    this.lineInput.select();
  }

  private closeBar(): void {
    this.bar.hidden = true;
    this.scroller.focus();
  }

  private searchSoon(delay = 150): void {
    clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => void this.search(), delay);
  }

  private async search(): Promise<void> {
    const index = this.index;
    if (!index) return;
    this.searchAbort?.abort();
    const abort = (this.searchAbort = new AbortController());
    this.options = {
      text: this.findInput.value,
      caseSensitive: this.toggles.caseSensitive.getAttribute('aria-pressed') === 'true',
      wholeWord: this.toggles.wholeWord.getAttribute('aria-pressed') === 'true',
      regex: this.toggles.regex.getAttribute('aria-pressed') === 'true',
    };
    this.message.classList.remove('wm-large-error');
    if (!this.options.text) {
      this.matches = null;
      this.highlight = null;
      this.message.textContent = '';
      this.refresh(true);
      return;
    }
    if (!compileSearch(this.options)) {
      this.message.textContent = t('largeText.badRegex');
      this.message.classList.add('wm-large-error');
      return;
    }
    this.highlight = compileSearch(this.options, 'g');
    const from = this.lineOfRow(this.topRow);
    const result = await searchLines(index, this.options, {
      signal: abort.signal,
      onProgress: (fraction, count) => {
        if (abort.signal.aborted) return;
        this.message.textContent = t('largeText.searching', { percent: Math.floor(fraction * 100) }) + ` · ${count.toLocaleString()}`;
      },
    });
    if (abort.signal.aborted || this.index !== index) return;
    this.matches = result.lines;
    this.message.textContent = result.lines.length ? t(result.truncated ? 'largeText.matchesMore' : 'largeText.matches', { count: result.lines.length.toLocaleString() }) : t('largeText.noMatches');
    this.refresh(true);
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
    const from = this.current >= 0 ? this.current : this.lineOfRow(this.topRow);
    let line = nextMatch(this.matches, backward ? from - 1 : from + 1, backward);
    // Past the last match, round to the first (and back from the first, to the last).
    if (line < 0) line = backward ? this.matches[this.matches.length - 1] : this.matches[0];
    this.reveal(line);
  }

  // --- Selecting and copying ---

  private select(e: PointerEvent): void {
    const target = (e.target as HTMLElement).closest<HTMLElement>('.wm-large-num');
    const row = target?.parentElement;
    if (!row?.dataset.line) return;
    const line = Number(row.dataset.line);
    this.selection = e.shiftKey && this.selection ? { anchor: this.selection.anchor, focus: line } : { anchor: line, focus: line };
    this.render();
    e.preventDefault();
    this.scroller.focus();
  }

  /** The selected lines' text, or null when none are selected. */
  get selectedText(): string | null {
    if (!this.index || !this.selection) return null;
    const first = Math.min(this.selection.anchor, this.selection.focus);
    const last = Math.max(this.selection.anchor, this.selection.focus);
    return last - first + 1 > MAX_COPY_LINES ? null : linesText(this.index, first, last);
  }

  /** Copies the selected lines (all of them, however many are in view). */
  async copy(): Promise<string | null> {
    if (!this.selection) return null;
    const text = this.selectedText;
    if (text === null) {
      this.message.textContent = t('largeText.copyTooLarge', { max: MAX_COPY_LINES.toLocaleString() });
      return null;
    }
    await navigator.clipboard.writeText(text);
    return text;
  }

  /** Puts the keyboard focus in the list, so the arrow, page and home/end keys scroll it. */
  focus(): void {
    this.scroller.focus({ preventScroll: true });
  }

  get fileName(): string {
    return this.name;
  }
}
