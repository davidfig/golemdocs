// A cell's note, shown when the pointer rests on the cell: a card beside it in the look of the documents' comments
// (`.wm-comment`), with the note's author and text. It goes when the pointer leaves the cell. NoteEditor is the card for
// typing one.

import { t } from '../i18n/index.ts';
import { h } from '../ui/dom.ts';

export class NoteCard {
  private readonly root = h('div', { class: 'wm-comment wm-sheet-note', attrs: { role: 'note' } });
  private readonly author = h('strong');
  private readonly text = h('div', { class: 'wm-sheet-note-text' });

  constructor() {
    this.root.append(h('header', {}, this.author), this.text);
    this.root.hidden = true;
    document.body.append(this.root);
  }

  /** Beside a window point (the cell's top right corner), kept on the screen. */
  show(author: string, text: string, clientX: number, clientY: number): void {
    this.author.textContent = author;
    this.author.hidden = !author;
    this.text.textContent = text;
    this.root.hidden = false;
    const box = this.root.getBoundingClientRect();
    this.root.style.left = `${Math.max(4, Math.min(clientX + 8, window.innerWidth - box.width - 4))}px`;
    this.root.style.top = `${Math.max(4, Math.min(clientY, window.innerHeight - box.height - 4))}px`;
  }

  hide(): void {
    this.root.hidden = true;
  }
}

/**
 * Sheet › New Note: the same card with a text box, drawn beside the cell (not a modal dialog). Enter or Save keeps the
 * text (Shift+Enter starts a new line); a press elsewhere keeps it too, as in Excel; Escape and Cancel drop it.
 */
export class NoteEditor {
  private readonly root = h('div', { class: 'wm-comment wm-comment-active wm-sheet-note wm-sheet-note-edit', attrs: { role: 'dialog', 'aria-label': t('sheet.op.newNote') } });
  private readonly author = h('strong');
  private readonly box = h('textarea', { class: 'wm-comment-box', attrs: { rows: '3', 'aria-label': t('sheet.note.label') } });
  private done: ((text: string | undefined) => void) | null = null;

  constructor() {
    const save = h('button', { class: 'wm-comment-primary', text: t('sheet.note.save'), attrs: { type: 'button' } });
    const cancel = h('button', { text: t('sheet.note.cancel'), attrs: { type: 'button' } });
    this.root.append(h('header', {}, this.author), this.box, h('div', { class: 'wm-comment-buttons' }, save, cancel));
    this.root.hidden = true;
    save.addEventListener('click', () => this.end(this.box.value));
    cancel.addEventListener('click', () => this.end(undefined));
    // Keys stay in the card: the sheet's handlers listen on the window.
    this.root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.end(this.box.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.end(undefined);
      }
    });
    document.addEventListener('pointerdown', (e) => !this.root.hidden && !this.root.contains(e.target as Node) && this.end(this.box.value), true);
    document.body.append(this.root);
  }

  /** Opens beside a window point (the cell's top right corner) with the focus in the text; resolves with the text, or
   * `undefined` if it was cancelled. */
  edit(author: string, text: string, clientX: number, clientY: number): Promise<string | undefined> {
    this.end(undefined);
    this.author.textContent = author;
    this.author.hidden = !author;
    this.box.value = text;
    this.root.hidden = false;
    const card = this.root.getBoundingClientRect();
    this.root.style.left = `${Math.max(4, Math.min(clientX + 8, window.innerWidth - card.width - 4))}px`;
    this.root.style.top = `${Math.max(4, Math.min(clientY, window.innerHeight - card.height - 4))}px`;
    this.box.focus();
    this.box.setSelectionRange(text.length, text.length);
    return new Promise((resolve) => (this.done = resolve));
  }

  get shown(): boolean {
    return !this.root.hidden;
  }

  private end(text: string | undefined): void {
    const done = this.done;
    this.done = null;
    this.root.hidden = true;
    done?.(text);
  }
}
