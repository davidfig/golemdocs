// Tools ▸ Word Count: the statistics of the document (or of the selected text), as in Word 2003.
// The counts come from the layout worker (see layout/wordCount.ts); this asks for them and shows them.

import { t, type MessageKey } from '../i18n/index.ts';
import type { WireCommand, WordStats } from '../layout/protocol.ts';
import { h } from './dom.ts';

const ROWS: { key: keyof Omit<WordStats, 'selection' | 'table'>; label: MessageKey }[] = [
  { key: 'pages', label: 'wordCount.pages' },
  { key: 'words', label: 'wordCount.words' },
  { key: 'charactersWithoutSpaces', label: 'wordCount.charactersWithoutSpaces' },
  { key: 'charactersWithSpaces', label: 'wordCount.charactersWithSpaces' },
  { key: 'paragraphs', label: 'wordCount.paragraphs' },
  { key: 'lines', label: 'wordCount.lines' },
];

export class WordCountDialog {
  private dialog: HTMLDialogElement | null = null;
  private values = new Map<string, HTMLElement>();
  private note: HTMLElement | null = null;

  constructor(
    private readonly host: { send(command: WireCommand): void; focusEditor(): void },
  ) {}

  /** Opens the dialog and asks for the counts. */
  open(): void {
    if (this.dialog) return;
    this.values.clear();
    const table = h('table', { class: 'wm-stats' });
    for (const { key, label } of ROWS) {
      const value = h('td', { class: 'wm-stat-value', text: '…' });
      this.values.set(key, value);
      table.append(h('tr', {}, h('th', { text: t(label), attrs: { scope: 'row' } }), value));
    }
    this.note = h('div', { class: 'wm-find-message', attrs: { role: 'status' } });
    const ok = h('button', { class: 'wm-button', text: t('wordCount.close'), attrs: { type: 'submit' } });
    const close = h('button', { class: 'wm-dialog-close', text: '×', attrs: { type: 'button', 'aria-label': t('wordCount.close') } });
    const dialog = h(
      'dialog',
      { class: 'wm-dialog wm-link wm-wordcount', attrs: { 'aria-label': t('wordCount.title') } },
      h('div', { class: 'wm-dialog-title' }, h('span', { text: t('wordCount.title') }), close),
      h('form', { attrs: { method: 'dialog' } }, h('div', { class: 'wm-dialog-body wm-link-body' }, h('label', { text: t('wordCount.statistics') }), table, this.note), h('div', { class: 'wm-dialog-buttons' }, ok)),
    );
    // Keys stay in the dialog: the document's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      this.dialog = null;
      this.host.focusEditor();
    });
    this.dialog = dialog;
    document.body.append(dialog);
    dialog.showModal();
    ok.focus();
    this.host.send({ kind: 'countWords' });
  }

  /** The counts (null: this document has none to give). */
  report(stats: WordStats | null): void {
    if (!this.dialog) return;
    for (const { key } of ROWS) this.values.get(key)!.textContent = stats ? stats[key].toLocaleString() : '—';
    if (this.note) this.note.textContent = stats?.selection ? t('wordCount.selection') : '';
  }
}
