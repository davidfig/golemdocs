// Edit ▸ Find and Replace: a dialog like the others, but not modal, so the document stays usable
// while it is open. It looks for text and selects each match in turn; the editor does the
// searching (see @word/editor).

import { h } from './dom.ts';

export interface FindHost {
  find(text: string, matchCase: boolean, backward: boolean): void;
  /** Replace the selection with `replacement` when it is a match of `text`; then find the next. */
  replace(text: string, replacement: string, matchCase: boolean): void;
  replaceAll(text: string, replacement: string, matchCase: boolean): void;
  /** The selected text, to start a search from. */
  selectedText(): string;
  focusEditor(): void;
}

export class FindBar {
  readonly el: HTMLDialogElement;
  private readonly tabs: { find: HTMLButtonElement; replace: HTMLButtonElement };
  private readonly query: HTMLInputElement;
  private readonly replacement: HTMLInputElement;
  private readonly matchCase: HTMLInputElement;
  private readonly replaceFields: HTMLElement[];
  private readonly replaceButtons: HTMLElement[];
  private readonly message: HTMLElement;

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

    this.query = field('Find what');
    this.replacement = field('Replace with');
    this.matchCase = h('input', { attrs: { type: 'checkbox' } });
    this.message = h('div', { class: 'wm-find-message', attrs: { role: 'status' } });

    const findLabel = h('label', { text: 'Find what:' });
    const replaceLabel = h('label', { text: 'Replace with:' });
    const caseLabel = h('label', { class: 'wm-find-case' }, this.matchCase, 'Match case');
    this.replaceFields = [replaceLabel, this.replacement];
    const replace = button('Replace', () => this.replaceOne(), 'Replace this match and find the next');
    const replaceAll = button('Replace All', () => this.replaceEvery());
    this.replaceButtons = [replace, replaceAll];

    const close = h('button', { class: 'wm-dialog-close', text: '×', attrs: { type: 'button', 'aria-label': 'Close' } });
    close.addEventListener('click', () => this.hide());
    const tab = (text: string, replace: boolean) => {
      const el = h('button', { class: 'wm-find-tab', text, attrs: { type: 'button', role: 'tab' } });
      el.addEventListener('click', () => {
        this.setMode(replace);
        this.query.focus();
      });
      return el;
    };
    this.tabs = { find: tab('Find', false), replace: tab('Replace', true) };

    this.el = h(
      'dialog',
      { class: 'wm-dialog wm-find', attrs: { 'aria-label': 'Find and Replace' } },
      h('div', { class: 'wm-dialog-title' }, h('span', { text: 'Find and Replace' }), close),
      h('div', { class: 'wm-find-tabs', attrs: { role: 'tablist' } }, this.tabs.find, this.tabs.replace),
      h(
        'div',
        { class: 'wm-dialog-body wm-find-body' },
        h('div', { class: 'wm-find-fields' }, findLabel, this.query, replaceLabel, this.replacement, caseLabel, this.message),
        h(
          'div',
          { class: 'wm-find-buttons' },
          button('Find Next', () => this.next(false), 'Enter'),
          button('Find Previous', () => this.next(true), 'Shift+Enter'),
          replace,
          replaceAll,
          button('Close', () => this.hide()),
        ),
      ),
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
        if (e.target === this.replacement) this.replaceOne();
        else this.next(e.shiftKey);
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'h')) {
        e.preventDefault();
        this.setMode(e.key === 'h');
        this.query.select();
        this.query.focus();
      }
    });
    // Editing what is searched for starts again from the selection.
    this.query.addEventListener('input', () => {
      this.say('');
      if (this.query.value) this.host.find(this.query.value, this.matchCase.checked, false);
    });
  }

  /** Opens the dialog (with the replace fields for Replace), searching for the selected text if it is one line. */
  show(replace: boolean): void {
    const selected = this.host.selectedText();
    if (selected && !selected.includes('\n')) this.query.value = selected;
    this.setMode(replace);
    this.say('');
    if (!this.el.open) this.el.show();
    this.query.focus();
    this.query.select();
  }

  /** Find, or Find with the replace fields: the tabs at the top switch between them. */
  private setMode(replace: boolean): void {
    for (const el of [...this.replaceFields, ...this.replaceButtons]) el.hidden = !replace;
    this.tabs.find.setAttribute('aria-selected', String(!replace));
    this.tabs.replace.setAttribute('aria-selected', String(replace));
  }

  hide(): void {
    this.el.close();
    this.host.focusEditor();
  }

  /** What the editor said about the last search or replacement. */
  report(result: { found?: boolean; replaced?: number }): void {
    if (!this.el.open) return;
    if (result.replaced !== undefined) this.say(result.replaced ? `Replaced ${result.replaced}` : 'No matches');
    else if (result.found === false) this.say('No matches');
    else this.say('');
  }

  private say(text: string): void {
    this.message.textContent = text;
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
}
