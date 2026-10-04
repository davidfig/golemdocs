// Edit ▸ Find, Replace and Go To: one dialog with a tab for each, as in Word 2003. It isn't
// modal, so the document stays usable while it is open. Find selects each match in turn (the
// editor does the searching, see @golemdocs/editor); Go To scrolls to a page or selects a comment.

import { t } from '../i18n/index.ts';
import { h, makeDraggable } from './dom.ts';
import { dialogTitleBar } from './popup.ts';

export type FindTab = 'find' | 'replace' | 'goTo';

/** What Go To can go to. */
type Target = 'page' | 'comment';

/** What is searched for and how it is read. */
export interface FindQuery {
  text: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface FindHost {
  find(query: FindQuery, backward: boolean): void;
  /** Replace the selection with `replacement` when it is a match of the query; then find the next. */
  replace(query: FindQuery, replacement: string): void;
  replaceAll(query: FindQuery, replacement: string): void;
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

const tabList = (): { tab: FindTab; label: string }[] => [
  { tab: 'find', label: t('dialogs.find.tabFind') },
  { tab: 'replace', label: t('dialogs.find.tabReplace') },
  { tab: 'goTo', label: t('dialogs.find.tabGoTo') },
];

const targets = (): { target: Target; label: string; entry: string }[] => [
  { target: 'page', label: t('dialogs.find.targetPage'), entry: t('dialogs.find.enterPage') },
  { target: 'comment', label: t('dialogs.find.targetComment'), entry: t('dialogs.find.enterComment') },
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
  private readonly wholeWord: HTMLInputElement;
  private readonly regex: HTMLInputElement;
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
    const field = (label: string) => h('input', { class: 'wm-input', attrs: { type: 'text', 'aria-label': label, autocomplete: 'off', spellcheck: 'false' } });
    const button = (text: string, run: () => void, title?: string) => {
      const el = h('button', { class: 'wm-button', text, title, attrs: { type: 'button' } });
      el.addEventListener('click', run);
      return el;
    };

    // Find and Replace share a pane: Replace adds a field and two buttons.
    this.query = field(t('dialogs.find.findWhatLabel'));
    this.replacement = field(t('dialogs.find.replaceWithLabel'));
    this.matchCase = h('input', { attrs: { type: 'checkbox' } });
    this.wholeWord = h('input', { attrs: { type: 'checkbox' } });
    this.regex = h('input', { attrs: { type: 'checkbox' } });
    this.findMessage = h('div', { class: 'wm-find-message', attrs: { role: 'status' } });
    const replaceLabel = h('label', { text: t('dialogs.find.replaceWithField') });
    this.replaceFields = [replaceLabel, this.replacement];
    const replace = button(t('dialogs.find.replace'), () => this.replaceOne(), t('dialogs.find.replaceTip'));
    const replaceAll = button(t('dialogs.find.replaceAll'), () => this.replaceEvery());
    this.replaceButtons = [replace, replaceAll];
    this.findPane = h(
      'div',
      { class: 'wm-dialog-body wm-find-body', attrs: { role: 'tabpanel' } },
      h(
        'div',
        { class: 'wm-find-fields' },
        h('label', { text: t('dialogs.find.findWhatField') }),
        this.query,
        replaceLabel,
        this.replacement,
        h('label', { class: 'wm-find-case' }, this.matchCase, t('dialogs.find.matchCase')),
        h('label', { class: 'wm-find-case' }, this.wholeWord, t('dialogs.find.wholeWord')),
        h('label', { class: 'wm-find-case' }, this.regex, t('dialogs.find.regex')),
        this.findMessage,
      ),
      h(
        'div',
        { class: 'wm-find-buttons' },
        button(t('dialogs.find.findNext'), () => this.next(false), t('dialogs.find.findNextTip')),
        button(t('dialogs.find.findPrevious'), () => this.next(true), t('dialogs.find.findPreviousTip')),
        replace,
        replaceAll,
        button(t('dialogs.find.close'), () => this.hide()),
      ),
    );

    // Go To: what to go to, and where.
    this.what = h('select', { class: 'wm-input wm-goto-what', attrs: { size: '6', 'aria-label': t('dialogs.find.goToWhatLabel') } });
    const targetList = targets();
    for (const { target, label } of targetList) {
      const option = h('option', { text: label });
      option.value = target;
      this.what.append(option);
    }
    this.what.value = 'page';
    this.entryLabel = h('label', { text: targetList[0].entry });
    this.entry = field(t('dialogs.find.itemNumber'));
    this.goToMessage = h('div', { class: 'wm-find-message', attrs: { role: 'status' } });
    this.goToPane = h(
      'div',
      { class: 'wm-dialog-body wm-find-body', attrs: { role: 'tabpanel' } },
      h(
        'div',
        { class: 'wm-goto-fields' },
        h('div', { class: 'wm-goto-column' }, h('label', { text: t('dialogs.find.goToWhatField') }), this.what),
        h(
          'div',
          { class: 'wm-goto-column' },
          this.entryLabel,
          this.entry,
          h('p', { class: 'wm-hint', text: t('dialogs.find.goToHint') }),
          this.goToMessage,
        ),
      ),
      h(
        'div',
        { class: 'wm-find-buttons' },
        button(t('dialogs.find.goTo'), () => this.go(), t('dialogs.find.goToTip')),
        button(t('dialogs.find.previous'), () => this.step(-1)),
        button(t('dialogs.find.next'), () => this.step(1)),
        button(t('dialogs.find.close'), () => this.hide()),
      ),
    );

    const tabs = h('div', { class: 'wm-find-tabs', attrs: { role: 'tablist' } });
    for (const { tab, label } of tabList()) {
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
      { class: 'wm-dialog wm-find', attrs: { 'aria-label': t('dialogs.find.title') } },
      dialogTitleBar(t('dialogs.find.title'), () => this.hide()),
      tabs,
      this.findPane,
      this.goToPane,
    );
    parent.append(this.el);
    makeDraggable(this.el);

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
      if (this.query.value) this.host.find(this.queryNow(), false);
    });
    this.what.addEventListener('change', () => {
      this.entryLabel.textContent = targets().find((x) => x.target === this.what.value)?.entry ?? '';
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
    if (result.replaced !== undefined) this.findMessage.textContent = result.replaced ? t('dialogs.find.replaced', { count: result.replaced }) : t('dialogs.find.noMatches');
    else this.findMessage.textContent = result.found === false ? t('dialogs.find.noMatches') : '';
  }

  private queryNow(): FindQuery {
    return { text: this.query.value, matchCase: this.matchCase.checked, wholeWord: this.wholeWord.checked, regex: this.regex.checked };
  }

  private next(backward: boolean): void {
    if (this.query.value) this.host.find(this.queryNow(), backward);
  }

  private replaceOne(): void {
    if (this.query.value) this.host.replace(this.queryNow(), this.replacement.value);
  }

  private replaceEvery(): void {
    if (this.query.value) this.host.replaceAll(this.queryNow(), this.replacement.value);
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
      this.goToMessage.textContent = t('dialogs.find.badNumber');
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
    if (!count) {
      this.goToMessage.textContent = page ? t('dialogs.find.noPages') : t('dialogs.find.noComments');
      return;
    }
    const last = count - 1;
    if (index < 0 || index > last) {
      if (!clamp) {
        this.goToMessage.textContent = index < 0 && !page
            ? t('dialogs.find.firstComment')
            : t(page ? 'dialogs.find.noSuchPage' : 'dialogs.find.noSuchComment', { number: index + 1, total: count });
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
