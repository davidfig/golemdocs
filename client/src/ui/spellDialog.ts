// Tools ▸ Spelling and Grammar: steps through what is wrong in the document, as in Word 2003. The
// sentence with the problem in it, the suggestions, and buttons to ignore it, add the word to the
// dictionary, or change it. Not modal: the problem is selected in the document behind it.

import { t, type MessageKey } from '../i18n/index.ts';
import type { SpellIssue, WireCommand } from '../layout/protocol.ts';
import { h, makeDraggable } from './dom.ts';
import { dialogTitleBar } from './popup.ts';

export interface SpellHost {
  send(command: WireCommand): void;
  /** The text selected in the document. */
  selectedText(): string;
  /** The words the user has added to the dictionary. */
  userWords(): string[];
  addUserWord(word: string): void;
  focusEditor(): void;
}

const GRAMMAR_KEY = 'word.spelling.grammar';

const SPELLING_KEY = 'word.spelling.asYouType';

const readFlag = (key: string): boolean => {
  try {
    return localStorage.getItem(key) !== 'off';
  } catch {
    return true;
  }
};

const writeFlag = (key: string, on: boolean): void => {
  try {
    localStorage.setItem(key, on ? 'on' : 'off');
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
};

export class SpellDialog {
  readonly el: HTMLDialogElement;
  private issue: SpellIssue | null = null;
  private readonly label: HTMLElement;
  private readonly sentence: HTMLElement;
  private readonly suggestions: HTMLSelectElement;
  private readonly suggestionsLabel: HTMLElement;
  private readonly grammar: HTMLInputElement;
  private readonly asYouType: HTMLInputElement;
  /** The choices, kept here for the session when storage is unavailable. */
  private live = { spelling: readFlag(SPELLING_KEY), grammar: readFlag(GRAMMAR_KEY) };
  private readonly message: HTMLElement;
  private readonly ignoreOnce: HTMLButtonElement;
  private readonly ignoreAll: HTMLButtonElement;
  private readonly add: HTMLButtonElement;
  private readonly change: HTMLButtonElement;
  private readonly changeAll: HTMLButtonElement;
  private readonly again: HTMLButtonElement;

  constructor(
    parent: HTMLElement,
    private readonly host: SpellHost,
  ) {
    const button = (text: string, run: () => void, title?: string) => {
      const el = h('button', { class: 'wm-button', text, title, attrs: { type: 'button' } });
      el.addEventListener('click', run);
      return el;
    };
    this.label = h('label', { text: t('spelling.notInDictionary') });
    this.sentence = h('div', { class: 'wm-spell-sentence', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.suggestionsLabel = h('label', { text: t('spelling.suggestionsField') });
    this.suggestions = h('select', { class: 'wm-input wm-spell-suggestions', attrs: { size: '5', 'aria-label': t('spelling.suggestionsLabel') } });
    this.grammar = h('input', { attrs: { type: 'checkbox' } });
    this.grammar.checked = this.live.grammar;
    this.asYouType = h('input', { attrs: { type: 'checkbox' } });
    this.asYouType.checked = this.live.spelling;
    this.message = h('div', { class: 'wm-find-message' });

    this.ignoreOnce = button(t('spelling.ignoreOnce'), () => this.next('selectionEnd'));
    this.ignoreAll = button(t('spelling.ignoreAll'), () => this.ignoreEvery());
    this.add = button(t('spelling.addToDictionary'), () => this.addToDictionary());
    this.change = button(t('spelling.change'), () => this.replace(false));
    this.changeAll = button(t('spelling.changeAll'), () => this.replace(true));
    this.again = button(t('spelling.checkAgain'), () => this.next('documentStart'), t('spelling.checkAgainTip'));
    this.again.hidden = true;

    this.el = h(
      'dialog',
      { class: 'wm-dialog wm-find wm-spell', attrs: { 'aria-label': t('spelling.title') } },
      dialogTitleBar(t('spelling.title'), () => this.hide()),
      h(
        'div',
        { class: 'wm-dialog-body wm-find-body' },
        h(
          'div',
          { class: 'wm-find-fields' },
          this.label,
          this.sentence,
          this.suggestionsLabel,
          this.suggestions,
          h('label', { class: 'wm-find-case' }, this.grammar, t('spelling.checkGrammar')),
          h('label', { class: 'wm-find-case' }, this.asYouType, t('spelling.asYouType')),
          this.message,
        ),
        h('div', { class: 'wm-find-buttons' }, this.ignoreOnce, this.ignoreAll, this.add, this.change, this.changeAll, this.again, button(t('spelling.close'), () => this.hide())),
      ),
    );
    parent.append(this.el);
    makeDraggable(this.el);

    // Keys stay in the dialog: the document's handlers listen on the window.
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hide();
      } else if (e.key === 'Enter' && e.target === this.suggestions && !this.change.disabled) {
        e.preventDefault();
        this.replace(false);
      }
    });
    this.suggestions.addEventListener('dblclick', () => {
      if (!this.change.disabled) this.replace(false);
    });
    this.grammar.addEventListener('change', () => {
      this.live.grammar = this.grammar.checked;
      writeFlag(GRAMMAR_KEY, this.grammar.checked);
      this.sendLive();
      this.next('selectionStart');
    });
    this.asYouType.addEventListener('change', () => {
      this.live.spelling = this.asYouType.checked;
      writeFlag(SPELLING_KEY, this.asYouType.checked);
      this.sendLive();
    });
    this.setProblem(false);
  }

  /** Tells the layout worker what to underline as the user types, and the user's dictionary (on each document opened). */
  sendLive(): void {
    this.host.send({ kind: 'spellCheck', spelling: this.live.spelling, grammar: this.live.grammar, words: this.host.userWords() });
  }

  /** What is underlined as the user types, or null when nothing is. */
  get liveChecks(): { spelling: boolean; grammar: boolean } | null {
    return this.checkingLive ? { ...this.live } : null;
  }

  /** Whether anything is underlined as the user types. */
  get checkingLive(): boolean {
    return this.live.spelling || this.live.grammar;
  }

  /** Opens the dialog and looks for the first problem, from the selection on. */
  open(): void {
    this.host.send({ kind: 'spellWords', words: this.host.userWords() });
    this.setProblem(true);
    if (!this.el.open) this.el.show();
    this.next('selectionStart');
  }

  hide(): void {
    this.el.close();
    this.host.focusEditor();
  }

  private next(from: 'documentStart' | 'selectionStart' | 'selectionEnd'): void {
    this.message.textContent = '';
    this.host.send({ kind: 'spellNext', from, grammar: this.grammar.checked });
  }

  /** What the worker found: a problem to show, or that there is no more. */
  report(result: { issue: SpellIssue | null }): void {
    if (!this.el.open) return;
    this.issue = result.issue;
    const { issue } = result;
    this.sentence.replaceChildren();
    this.suggestions.replaceChildren();
    if (!issue) {
      this.label.textContent = t('spelling.completeLabel');
      this.sentence.textContent = t('spelling.complete');
      this.sentence.className = 'wm-spell-sentence';
      this.setProblem(false);
      return;
    }
    const grammar = issue.kind === 'grammar';
    this.label.textContent = grammar ? t('spelling.grammarLabel', { message: t(issue.message as MessageKey) }) : t(issue.message as MessageKey);
    this.sentence.className = `wm-spell-sentence ${grammar ? 'grammar' : 'spelling'}`;
    // A whitespace-only problem (an extra space) is shown as a visible mark.
    this.sentence.append(issue.before, h('span', { class: 'wm-spell-problem', text: issue.text.trim() ? issue.text : '␣'.repeat(Math.min(issue.text.length, 4)) }), issue.after);
    for (const suggestion of issue.suggestions) {
      const option = h('option', { text: suggestion });
      option.value = suggestion;
      this.suggestions.append(option);
    }
    if (issue.suggestions.length) this.suggestions.selectedIndex = 0;
    else this.suggestions.append(h('option', { text: t('spelling.noSuggestions'), attrs: { disabled: '' } }));
    this.setProblem(true);
    this.ignoreAll.textContent = grammar ? t('spelling.ignoreRule') : t('spelling.ignoreAll');
    this.add.hidden = grammar;
    this.changeAll.hidden = grammar;
    const changes = issue.suggestions.length > 0;
    this.change.disabled = !changes;
    this.changeAll.disabled = !changes;
    (changes ? this.suggestions : this.ignoreOnce).focus();
  }

  /** Whether a problem is being shown: its buttons are, and Check Again isn't. */
  private setProblem(problem: boolean): void {
    for (const el of [this.ignoreOnce, this.ignoreAll, this.add, this.change, this.changeAll]) el.hidden = !problem;
    this.again.hidden = problem;
    this.suggestions.hidden = !problem;
    this.suggestionsLabel.hidden = !problem;
    if (!problem) {
      this.issue = null;
      if (this.el.open) this.again.focus();
    }
  }

  /** The selection is still the problem the dialog is showing (it may have been clicked away from). */
  private selected(): SpellIssue | null {
    const { issue } = this;
    if (!issue) return null;
    if (this.host.selectedText() !== issue.text) {
      this.message.textContent = t('spelling.selectionChanged');
      return null;
    }
    return issue;
  }

  private replace(all: boolean): void {
    const issue = this.selected();
    const choice = this.suggestions.value;
    if (!issue || !choice) return;
    if (all && issue.kind === 'spelling') this.host.send({ kind: 'replaceAll', text: issue.text, with: choice, matchCase: true, wholeWord: true });
    else this.host.send({ kind: 'insertText', text: choice });
    this.next('selectionEnd');
  }

  private ignoreEvery(): void {
    const { issue } = this;
    if (!issue) return;
    if (issue.kind === 'grammar' && issue.rule) this.host.send({ kind: 'spellWords', rules: [issue.rule] });
    else this.host.send({ kind: 'spellWords', words: [issue.text] });
    this.next('selectionEnd');
  }

  private addToDictionary(): void {
    const { issue } = this;
    if (!issue) return;
    this.host.addUserWord(issue.text);
    this.host.send({ kind: 'spellWords', words: [issue.text] });
    this.next('selectionEnd');
  }
}
