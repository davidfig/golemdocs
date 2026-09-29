// Edit ▸ Find, Replace and Go To: one dialog with a tab for each, as in Word 2003. It isn't
// modal, so the document stays usable while it is open. Find selects each match in turn (the
// editor does the searching, see @word/editor); Go To scrolls to a page or selects a comment.

import { h } from './dom.ts';

export type FindTab = 'find' | 'replace' | 'goTo';

/** What Go To can go to. */
type Target = 'page' | 'comment';

export interface FindHost {
  find(text: string, matchCase: boolean, backward: boolean): void;
  /** Replace the selection with `replacement` when it is a match of `text`; then find the next. */
  replace(text: string, replacement: string, matchCase: boolean): void;
  replaceAll(text: string, replacement: string, matchCase: boolean): void;
  /** The selected text, to start a search from. */
  selectedText(): string;
  pageCount(): number;
  /** The page at the middle of the view, from 0. */
  pageIndex(): number;
  goToPage(index: number): void;
  commentCount(): number;
  /** Selects the text of the comment at `index` (from 0). */
  goToComment(index: number): void;
  focusEditor(): void;
}

const TABS: { tab: FindTab; label: string }[] = [
  { tab: 'find', label: '&Find' },
  { tab: 'replace', label: 'R&eplace' },
  { tab: 'goTo', label: '&Go To' },
];

const TARGETS: { target: Target; label: string; entry: string }[] = [
  { target: 'page', label: 'Page', entry: 'Enter page number:' },
  { target: 'comment', label: 'Comment', entry: 'Enter comment number:' },
];

/** "+3", "-2" (relative to where you are) or "5" (that one). */
function parseEntry(text: string): { relative: boolean; amount: number } | null {
  const match = /^\s*([+\-−])?\s*(\d+)\s*$/.exec(text);
  if (!match) return null;
  const amount = Number(match[2]);
  return match[1] ? { relative: true, amount: match[1] === '+' ? amount : -amount } : { relative: false, amount };
}

export class FindDialog {
  readonly el: HTMLDialogElement;
  private tab: FindTab = 'find';
  private readonly tabButtons = new Map<FindTab, HTMLButtonElement>();
  private readonly findPane: HTMLElement;
  private readonly goToPane: HTMLElement;
  private readonly query: HTMLInputElement;
  private readonly replacement: HTMLInputElement;
  private readonly matchCase: HTMLInputElement;
  private readonly replaceFields: HTMLElement[];
  private readonly replaceButtons: HTMLElement[];
  private readonly findMessage: HTMLElement;
  private readonly what: HTMLSelectElement;
  private readonly entry: HTMLInputElement;
  private readonly entryLabel: HTMLElement;
  private readonly goToMessage: HTMLElement;
  /** The comment last gone to, from 0 (-1: none yet), for Next and Previous. */
  private comment = -1;

  constructor(
    parent: HTMLElement,
    private readonly host: FindHost,
  ) {
    const field = (label: string) => h('input', { class: 'wm-field', attrs: { type: 'text', 'aria-label': label, autocomplete: 'off', spellcheck: 'false' } });
    const button = (text: string, run: () => void, title?: string) => {
      const el = h('button', { class: 'wm-button', text, title, attrs: { type: 'button' } });
      el.addEventListener('click', run);
      return el;
    };

    // Find and Replace share a pane: Replace adds a field and two buttons.
    this.query = field('Find what');
    this.replacement = field('Replace with');
    this.matchCase = h('input', { attrs: { type: 'checkbox' } });
    this.findMessage = h('div', { class: 'wm-find-message', attrs: { role: 'status' } });
    const replaceLabel = h('label', { text: 'Replace with:' });
    this.replaceFields = [replaceLabel, this.replacement];
    const replace = button('Replace', () => this.replaceOne(), 'Replace this match and find the next');
    const replaceAll = button('Replace All', () => this.replaceEvery());
    this.replaceButtons = [replace, replaceAll];
    this.findPane = h(
      'div',
      { class: 'wm-dialog-body wm-find-body', attrs: { role: 'tabpanel' } },
      h(
        'div',
        { class: 'wm-find-fields' },
        h('label', { text: 'Find what:' }),
        this.query,
        replaceLabel,
        this.replacement,
        h('label', { class: 'wm-find-case' }, this.matchCase, 'Match case'),
        this.findMessage,
      ),
      h(
        'div',
        { class: 'wm-find-buttons' },
        button('Find Next', () => this.next(false), 'Enter'),
        button('Find Previous', () => this.next(true), 'Shift+Enter'),
        replace,
        replaceAll,
        button('Close', () => this.hide()),
      ),
    );

    // Go To: what to go to, and where.
    this.what = h('select', { class: 'wm-field wm-goto-what', attrs: { size: '6', 'aria-label': 'Go to what' } });
    for (const { target, label } of TARGETS) {
      const option = h('option', { text: label });
      option.value = target;
      this.what.append(option);
    }
    this.what.value = 'page';
    this.entryLabel = h('label', { text: TARGETS[0].entry });
    this.entry = field('Item number');
    this.goToMessage = h('div', { class: 'wm-find-message', attrs: { role: 'status' } });
    this.goToPane = h(
      'div',
      { class: 'wm-dialog-body wm-find-body', attrs: { role: 'tabpanel' } },
      h(
        'div',
        { class: 'wm-goto-fields' },
        h('div', { class: 'wm-goto-column' }, h('label', { text: 'Go to what:' }), this.what),
        h(
          'div',
          { class: 'wm-goto-column' },
          this.entryLabel,
          this.entry,
          h('p', { class: 'wm-hint', text: 'Type + or − to move relative to the current location. For example, +4 moves forward four.' }),
          this.goToMessage,
        ),
      ),
      h(
        'div',
        { class: 'wm-find-buttons' },
        button('Go To', () => this.go(), 'Enter'),
        button('Previous', () => this.step(-1)),
        button('Next', () => this.step(1)),
        button('Close', () => this.hide()),
      ),
    );

    const close = h('button', { class: 'wm-dialog-close', text: '×', attrs: { type: 'button', 'aria-label': 'Close' } });
    close.addEventListener('click', () => this.hide());
    const tabs = h('div', { class: 'wm-find-tabs', attrs: { role: 'tablist' } });
    for (const { tab, label } of TABS) {
      const el = h('button', { class: 'wm-find-tab', text: label.replace('&', ''), attrs: { type: 'button', role: 'tab' } });
      el.addEventListener('click', () => {
        this.setTab(tab);
        this.focusFirst();
      });
      this.tabButtons.set(tab, el);
      tabs.append(el);
    }

    this.el = h(
      'dialog',
      { class: 'wm-dialog wm-find', attrs: { 'aria-label': 'Find and Replace' } },
      h('div', { class: 'wm-dialog-title' }, h('span', { text: 'Find and Replace' }), close),
      tabs,
      this.findPane,
      this.goToPane,
    );
    parent.append(this.el);

    // Keys stay in the dialog: the document's handlers listen on the window.
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hide();
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        if (this.tab === 'goTo') this.go();
        else if (e.target === this.replacement) this.replaceOne();
        else this.next(e.shiftKey);
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'h' || e.key === 'g')) {
        e.preventDefault();
        this.setTab(e.key === 'f' ? 'find' : e.key === 'h' ? 'replace' : 'goTo');
        this.focusFirst();
      }
    });
    // Editing what is searched for starts again from the selection.
    this.query.addEventListener('input', () => {
      this.findMessage.textContent = '';
      if (this.query.value) this.host.find(this.query.value, this.matchCase.checked, false);
    });
    this.what.addEventListener('change', () => {
      this.entryLabel.textContent = TARGETS.find((t) => t.target === this.what.value)?.entry ?? '';
      this.goToMessage.textContent = '';
    });
  }

  /** Opens the dialog on a tab, searching for the selected text if it is one line. */
  show(tab: FindTab): void {
    const selected = this.host.selectedText();
    if (selected && !selected.includes('\n')) this.query.value = selected;
    this.setTab(tab);
    if (!this.el.open) this.el.show();
    this.focusFirst();
  }

  hide(): void {
    this.el.close();
    this.host.focusEditor();
  }

  private setTab(tab: FindTab): void {
    this.tab = tab;
    this.findPane.hidden = tab === 'goTo';
    this.goToPane.hidden = tab !== 'goTo';
    for (const el of [...this.replaceFields, ...this.replaceButtons]) el.hidden = tab !== 'replace';
    for (const [name, el] of this.tabButtons) el.setAttribute('aria-selected', String(name === tab));
    this.findMessage.textContent = '';
    this.goToMessage.textContent = '';
  }

  private focusFirst(): void {
    const field = this.tab === 'goTo' ? this.entry : this.query;
    field.focus();
    field.select();
  }

  /** What the editor said about the last search or replacement. */
  report(result: { found?: boolean; replaced?: number }): void {
    if (!this.el.open) return;
    if (result.replaced !== undefined) this.findMessage.textContent = result.replaced ? `Replaced ${result.replaced}` : 'No matches';
    else this.findMessage.textContent = result.found === false ? 'No matches' : '';
  }

  private next(backward: boolean): void {
    if (this.query.value) this.host.find(this.query.value, this.matchCase.checked, backward);
  }

  private replaceOne(): void {
    if (this.query.value) this.host.replace(this.query.value, this.replacement.value, this.matchCase.checked);
  }

  private replaceEvery(): void {
    if (this.query.value) this.host.replaceAll(this.query.value, this.replacement.value, this.matchCase.checked);
  }

  // --- Go To -------------------------------------------------------------------------------

  private get target(): Target {
    return this.what.value as Target;
  }

  /** Go To: the entered number, or (for comments) the next one when nothing is entered. */
  private go(): void {
    const text = this.entry.value.trim();
    if (!text && this.target === 'comment') return this.step(1);
    const parsed = parseEntry(text);
    if (!parsed) {
      this.goToMessage.textContent = `Enter a number, like 3 or +2.`;
      return;
    }
    this.goTo(parsed.relative ? this.current() + parsed.amount : parsed.amount - 1, parsed.relative);
  }

  private step(by: number): void {
    this.goTo(this.current() + by, false);
  }

  /** Where the document is now, from 0: the page in view, or the comment last gone to. */
  private current(): number {
    return this.target === 'page' ? this.host.pageIndex() : this.comment;
  }

  /** Goes to item `index` (from 0). Past the ends it stops at the last item when `clamp`, else says so. */
  private goTo(index: number, clamp: boolean): void {
    const page = this.target === 'page';
    const count = page ? this.host.pageCount() : this.host.commentCount();
    const name = page ? 'page' : 'comment';
    if (!count) {
      this.goToMessage.textContent = page ? 'The document has no pages.' : 'The document has no comments.';
      return;
    }
    const last = count - 1;
    if (index < 0 || index > last) {
      if (!clamp) {
        this.goToMessage.textContent = index < 0 && !page ? 'This is the first comment.' : `There is no ${name} ${index + 1}. The document has ${count}.`;
        return;
      }
      index = Math.min(Math.max(index, 0), last);
    }
    this.goToMessage.textContent = '';
    if (page) this.host.goToPage(index);
    else {
      this.comment = index;
      this.host.goToComment(index);
    }
  }
}
