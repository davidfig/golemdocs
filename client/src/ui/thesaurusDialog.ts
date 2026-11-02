// Tools ▸ Thesaurus (Shift+F7): the meanings of the selected word (or the word at the caret) and the
// words for each, as in Word 2003. Replace puts the chosen word in place of the selected one; a
// double click looks the chosen word up in turn, and Previous goes back. Not modal.

import { t, type MessageKey } from '../i18n/index.ts';
import { inCaseOf, meaningLabel, synonymsOf, type LookUp } from '../spelling/thesaurus.ts';
import { h, makeDraggable } from './dom.ts';
import { listBox, type ListBox } from './listBox.ts';
import { dialogTitleBar } from './popup.ts';

export interface ThesaurusHost {
  /** The word to look up: the selected text, or the word at the caret (selecting it). '' when there is none. */
  pickWord(): Promise<string>;
  /** The text selected in the document. */
  selectedText(): string;
  /** A word's meanings (null: not in the thesaurus); rejects when the thesaurus can't be loaded. */
  lookUp(word: string): Promise<LookUp | null>;
  /** Types `text` over the selection. */
  replace(text: string): void;
  focusEditor(): void;
}

/** The part-of-speech names, by the thesaurus's. */
const POS_KEYS = { noun: 'spelling.thesaurus.noun', verb: 'spelling.thesaurus.verb', adjective: 'spelling.thesaurus.adjective', adverb: 'spelling.thesaurus.adverb' } as const satisfies Record<string, MessageKey>;

export class ThesaurusDialog {
  readonly el: HTMLDialogElement;
  private readonly lookedUp: HTMLInputElement;
  private readonly meanings: ListBox;
  private readonly synonyms: ListBox;
  private readonly replacement: HTMLInputElement;
  private readonly message: HTMLElement;
  private readonly replaceButton: HTMLButtonElement;
  private readonly previousButton: HTMLButtonElement;
  /** The word in the document that Replace replaces (as it was written there). */
  private original = '';
  private result: LookUp | null = null;
  /** The words looked up before this one, for Previous. */
  private history: string[] = [];
  /** Counts lookups, so a slow one that was overtaken is dropped. */
  private request = 0;

  constructor(
    parent: HTMLElement,
    private readonly host: ThesaurusHost,
  ) {
    const button = (text: string, run: () => void) => {
      const el = h('button', { class: 'wm-button', text, attrs: { type: 'button' } });
      el.addEventListener('click', run);
      return el;
    };
    this.lookedUp = h('input', { class: 'wm-input', attrs: { type: 'text', spellcheck: 'false', 'aria-label': t('spelling.thesaurus.lookedUpLabel') } });
    this.replacement = h('input', { class: 'wm-input', attrs: { type: 'text', spellcheck: 'false', 'aria-label': t('spelling.thesaurus.replaceWithLabel') } });
    this.meanings = listBox(t('spelling.thesaurus.meaningsLabel'), { rows: 8, onPick: () => this.showSynonyms() });
    this.synonyms = listBox(t('spelling.thesaurus.synonymsLabel'), {
      rows: 8,
      onPick: (word) => (this.replacement.value = inCaseOf(this.original, word)),
      onChoose: (word) => this.lookUp(word, true),
    });
    this.message = h('div', { class: 'wm-find-message', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.replaceButton = button(t('spelling.thesaurus.replace'), () => this.replace());
    this.previousButton = button(t('spelling.thesaurus.previous'), () => this.previous());
    const field = (label: string, control: HTMLElement) => h('div', {}, h('label', { text: label }), control);

    this.el = h(
      'dialog',
      { class: 'wm-dialog wm-find wm-thesaurus', attrs: { 'aria-label': t('spelling.thesaurus.title') } },
      dialogTitleBar(t('spelling.thesaurus.title'), () => this.hide()),
      h(
        'div',
        { class: 'wm-dialog-body wm-find-body' },
        h(
          'div',
          { class: 'wm-find-fields' },
          h('div', { class: 'wm-thesaurus-lists' }, field(t('spelling.thesaurus.lookedUp'), this.lookedUp), field(t('spelling.thesaurus.replaceWith'), this.replacement)),
          h('div', { class: 'wm-thesaurus-lists' }, field(t('spelling.thesaurus.meanings'), this.meanings.el), field(t('spelling.thesaurus.synonyms'), this.synonyms.el)),
          this.message,
        ),
        h('div', { class: 'wm-find-buttons' }, this.replaceButton, button(t('spelling.thesaurus.lookUp'), () => this.lookUp(this.replacement.value || this.lookedUp.value, true)), this.previousButton, button(t('spelling.close'), () => this.hide())),
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
      } else if (e.key === 'Enter' && e.target === this.lookedUp) {
        e.preventDefault();
        this.lookUp(this.lookedUp.value, true);
      } else if (e.key === 'Enter' && e.target === this.replacement) {
        e.preventDefault();
        this.replace();
      }
    });
  }

  /** Opens the dialog on the selected word, or the word at the caret. */
  async open(): Promise<void> {
    if (!this.el.open) this.el.show();
    this.history = [];
    const word = (await this.host.pickWord()).trim();
    this.original = word;
    this.lookUp(word, false);
    this.lookedUp.focus();
    this.lookedUp.select();
  }

  hide(): void {
    this.el.close();
    this.host.focusEditor();
  }

  /** Looks a word up and shows its meanings; `remember` keeps the one shown now for Previous. */
  private lookUp(word: string, remember: boolean): void {
    word = word.trim();
    if (remember && this.lookedUp.value && this.lookedUp.value !== word) this.history.push(this.lookedUp.value);
    this.previousButton.disabled = this.history.length === 0;
    this.lookedUp.value = word;
    this.result = null;
    this.meanings.set([]);
    this.synonyms.set([]);
    this.replacement.value = '';
    this.replaceButton.disabled = true;
    if (!word) {
      this.message.textContent = t('spelling.thesaurus.typeWord');
      return;
    }
    const request = ++this.request;
    this.message.textContent = t('spelling.thesaurus.loading');
    this.host.lookUp(word).then(
      (result) => {
        if (request === this.request) this.show(word, result);
      },
      () => {
        if (request === this.request) this.message.textContent = t('spelling.thesaurus.failed');
      },
    );
  }

  private show(word: string, result: LookUp | null): void {
    this.result = result;
    if (!result) {
      this.message.textContent = t('spelling.thesaurus.notFound', { word });
      this.meanings.set([{ note: t('spelling.thesaurus.none') }]);
      return;
    }
    this.message.textContent = result.word.toLowerCase() === word.toLowerCase() ? '' : t('spelling.thesaurus.baseForm', { word: result.word });
    const rows = result.meanings.map((m) => t('spelling.thesaurus.meaning', { word: meaningLabel(m), pos: t(POS_KEYS[m.pos]) }));
    if (result.meanings.some((m) => m.opposite.length)) rows.push(t('spelling.thesaurus.antonyms'));
    this.meanings.set(rows);
    this.showSynonyms();
  }

  /** The words for the meaning picked (or the antonyms of all of them, for the last row). */
  private showSynonyms(): void {
    const result = this.result;
    if (!result) return;
    const index = this.meanings.index;
    const meaning = result.meanings[index];
    const words = meaning ? synonymsOf(meaning) : [...new Set(result.meanings.flatMap((m) => m.opposite))];
    this.synonyms.set(words);
    this.replacement.value = words.length ? inCaseOf(this.original, words[0]) : '';
    this.replaceButton.disabled = !this.original || words.length === 0;
  }

  private previous(): void {
    const word = this.history.pop();
    if (word !== undefined) this.lookUp(word, false);
  }

  private replace(): void {
    const text = this.replacement.value.trim();
    if (!text || !this.original) return;
    // The word may have been clicked away from: replace only what the dialog was opened on.
    if (this.host.selectedText().trim() !== this.original) {
      this.message.textContent = t('spelling.thesaurus.selectionChanged');
      return;
    }
    this.host.replace(text);
    this.hide();
  }
}
