// The comments panel: the open document's comments down the right of the editor, each with its
// author, date and text. Clicking one selects the text it's on; its buttons change or remove it.
// Hidden while the document has no comments.

import type { SelectionUpdate } from '../layout/protocol.ts';
import { relativeTime } from './dashboardFormat.ts';
import { h } from './dom.ts';
import './comments.css';

type CommentInfo = SelectionUpdate['comments'][number];

export interface CommentsHost {
  select(id: string): void;
  edit(id: string, text: string): void;
  remove(id: string): void;
}

export class CommentsPanel {
  readonly el = h('aside', { class: 'wm-comments', attrs: { 'aria-label': 'Comments' } });
  private shown = '';

  constructor(
    parent: HTMLElement,
    private readonly host: CommentsHost,
  ) {
    this.el.hidden = true;
    parent.append(this.el);
  }

  update(comments: readonly CommentInfo[]): void {
    const key = JSON.stringify(comments.map(({ id, author, date, text }) => [id, author, date, text]));
    if (key === this.shown) return;
    this.shown = key;
    this.el.hidden = comments.length === 0;
    this.el.replaceChildren(h('h2', { text: `Comments (${comments.length})` }), ...comments.map((c) => this.card(c)));
  }

  private card(c: CommentInfo): HTMLElement {
    const edit = h('button', { text: 'Edit', attrs: { type: 'button' } });
    const remove = h('button', { text: 'Delete', attrs: { type: 'button' } });
    const card = h(
      'article',
      { class: 'wm-comment', attrs: { tabindex: '0' } },
      h('header', {}, h('strong', { text: c.author || 'Unknown' }), c.date ? h('time', { text: relativeTime(Date.parse(c.date)), attrs: { datetime: c.date } }) : null),
      h('p', { text: c.text }),
      h('footer', {}, edit, remove),
    );
    card.addEventListener('click', (e) => {
      if (e.target instanceof HTMLButtonElement) return;
      this.host.select(c.id);
    });
    edit.addEventListener('click', () => {
      const text = window.prompt('Comment', c.text);
      if (text !== null && text !== c.text) this.host.edit(c.id, text);
    });
    remove.addEventListener('click', () => this.host.remove(c.id));
    return card;
  }
}
