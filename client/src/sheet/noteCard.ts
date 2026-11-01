// A cell's note, shown when the pointer rests on the cell: a card beside it in the look of the documents' comments
// (`.wm-comment`), with the note's author and text. It goes when the pointer leaves the cell.

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
