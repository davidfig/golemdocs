// The comments panel: the open document's comment threads down the right of the editor, each card
// beside the text it is on. A thread is a first comment and its replies; the one the caret is in
// (or that was clicked) opens to show every reply, a box to reply in, and its buttons. Writing a
// new comment, changing one and replying happen in the panel, not in dialogs. Hidden while the
// document has no comments and none is being written.

import type { SelectionUpdate } from '../layout/protocol.ts';
import { t } from '../i18n/index.ts';
import { relativeTime } from './dashboardFormat.ts';
import { h } from './dom.ts';
import './comments.css';

type CommentInfo = SelectionUpdate['comments'][number];

export interface CommentsHost {
  select(id: string): void;
  edit(id: string, text: string): void;
  remove(id: string): void;
  reply(id: string, text: string): void;
  resolve(id: string, resolved: boolean): void;
  /** Comments on the selection (or the word at the caret). */
  add(text: string): void;
  /** Where a point on a page is in the panel, in CSS px from its top; null when the page isn't shown. */
  place(page: number, y: number): number | null;
  /** The same for the caret, where a new comment goes. */
  placeCaret(): number | null;
  /** Gives the keyboard back to the document. */
  focusEditor(): void;
}

interface Thread {
  root: CommentInfo;
  replies: CommentInfo[];
}

/** One card on the panel: a thread, or the comment being written. */
interface Item {
  el: HTMLElement;
  /** Where its text is, in the panel (null: not on a page shown). */
  desired: number | null;
  height: number;
  active: boolean;
  top: number;
}

/** Space above the first card, for the bar. */
const BAR = 34;
const GAP = 8;

export class CommentsPanel {
  readonly el = h('aside', { class: 'wm-comments', attrs: { 'aria-label': t('panels.comments.label') } });
  private readonly bar = h('div', { class: 'wm-comments-bar' });
  private readonly list = h('div', { class: 'wm-comments-list' });
  private comments: readonly CommentInfo[] = [];
  private items: Item[] = [];
  private shown = '';
  /** The thread open in the panel (its first comment's id). */
  private active: string | null = null;
  /** What the document said was active last, to tell a change of caret from a click on a card. */
  private documentActive: string | null = null;
  private showResolved = false;
  private drafting = false;
  private editing: string | null = null;
  /** Text typed in a box and not yet sent, by thread id ('' for a new comment), kept while the panel redraws. */
  private readonly drafts = new Map<string, string>();
  /** The box to put the cursor in after the next redraw. */
  private focusBox: string | null = null;

  constructor(
    parent: HTMLElement,
    private readonly host: CommentsHost,
  ) {
    this.el.hidden = true;
    this.el.append(this.bar, this.list);
    // Keys typed in a comment box stay there: the document's handlers listen on the window, and
    // would take Backspace, the arrows and the rest as edits to the document.
    this.el.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLTextAreaElement) e.stopPropagation();
    });
    parent.append(this.el);
  }

  /** Starts a new comment: a card with a box to write in, beside the caret. */
  startDraft(): void {
    this.drafting = true;
    this.focusBox = '';
    this.render();
  }

  /** Empties the panel for another document: a half-written comment or edit belongs to the old one. */
  reset(): void {
    this.drafting = false;
    this.editing = null;
    this.drafts.clear();
    this.focusBox = null;
    this.comments = [];
    this.active = this.documentActive = null;
    this.render();
  }

  update(comments: readonly CommentInfo[], active: string | null = null): void {
    let changed = false;
    if (active !== this.documentActive) {
      this.documentActive = active;
      this.active = active;
      changed = true;
    }
    if (renderKey(comments, this.active) === this.shown && !changed) return;
    // A comment the panel was waiting for (written here) opens.
    const known = new Set(this.comments.map((c) => c.id));
    this.comments = comments;
    if (this.drafting && comments.some((c) => !known.has(c.id))) {
      this.drafting = false;
      this.active = comments.find((c) => !known.has(c.id) && !c.parentId)?.id ?? this.active;
    }
    this.render();
  }

  // --- Building --------------------------------------------------------------------------

  private threads(): Thread[] {
    const roots = this.comments.filter((c) => !c.parentId || !this.comments.some((p) => p.id === c.parentId));
    const inOrder = [...roots].sort((a, b) => (a.page ?? Infinity) - (b.page ?? Infinity) || a.y - b.y);
    return inOrder.map((root) => ({ root, replies: this.comments.filter((c) => c.parentId === root.id) }));
  }

  private render(): void {
    this.shown = renderKey(this.comments, this.active);
    const threads = this.threads();
    this.el.hidden = threads.length === 0 && !this.drafting;
    this.el.ariaLabel = t('panels.comments.label');
    this.buildBar(threads);
    const visible = threads.filter((th) => this.showResolved || !th.root.resolved || th.root.id === this.active);
    this.items = visible.map((th) => this.threadItem(th));
    if (this.drafting) this.items.push(this.draftItem());
    this.list.replaceChildren(...this.items.map((i) => i.el));
    for (const item of this.items) item.height = item.el.offsetHeight;
    this.position();
    if (this.focusBox !== null) {
      const box = this.list.querySelector<HTMLTextAreaElement>(`textarea[data-box="${CSS.escape(this.focusBox)}"]`);
      this.focusBox = null;
      if (box) {
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
      }
    }
  }

  private buildBar(threads: Thread[]): void {
    const previous = h('button', { text: '‹', title: t('panels.comments.previous'), attrs: { type: 'button', 'aria-label': t('panels.comments.previous') } });
    const next = h('button', { text: '›', title: t('panels.comments.next'), attrs: { type: 'button', 'aria-label': t('panels.comments.next') } });
    const toggle = h('input', { attrs: { type: 'checkbox' } });
    toggle.checked = this.showResolved;
    const ids = threads.filter((th) => this.showResolved || !th.root.resolved).map((th) => th.root.id);
    const step = (by: number) => {
      if (!ids.length) return;
      const at = this.active ? ids.indexOf(this.active) : -1;
      const id = ids[at < 0 ? (by > 0 ? 0 : ids.length - 1) : (at + by + ids.length) % ids.length];
      this.open(id);
    };
    previous.addEventListener('click', () => step(-1));
    next.addEventListener('click', () => step(1));
    toggle.addEventListener('change', () => {
      this.showResolved = toggle.checked;
      this.render();
    });
    const total = this.comments.length;
    this.bar.replaceChildren(
      h('h2', { text: t('panels.comments.title', { count: total }) }),
      previous,
      next,
      h('label', {}, toggle, h('span', { text: t('panels.comments.showResolved') })),
    );
  }

  private threadItem({ root, replies }: Thread): Item {
    const open = this.active === root.id;
    const card = h('article', { class: `wm-comment${open ? ' wm-comment-active' : ''}${root.resolved ? ' wm-comment-resolved' : ''}`, attrs: { tabindex: '0', 'data-thread': root.id } });
    card.append(this.comment(root, open));
    if (open) for (const reply of replies) card.append(this.comment(reply, true));
    else if (replies.length) card.append(h('p', { class: 'wm-comment-count', text: t('panels.comments.replies', { count: replies.length }) }));
    if (open) card.append(this.threadFooter(root));
    card.addEventListener('click', (e) => {
      if (this.active === root.id || (e.target instanceof Element && e.target.closest('button'))) return;
      this.open(root.id);
    });
    card.addEventListener('keydown', (e) => {
      if (e.target === card && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        this.open(root.id);
      }
    });
    return { el: card, desired: root.page === null ? null : this.host.place(root.page, root.y), height: 0, active: open, top: NaN };
  }

  /** One comment in a thread: who and when, then its text (or a box to change it in). */
  private comment(c: CommentInfo, open: boolean): HTMLElement {
    const name = c.author || t('panels.comments.unknown');
    const avatar = h('span', { class: 'wm-comment-avatar', text: initialsOf(c.initials, name), attrs: { 'aria-hidden': 'true' } });
    avatar.style.background = colorOf(name);
    // A date the document got wrong isn't shown (rather than "Invalid Date").
    const when = c.date ? relativeTime(Date.parse(c.date)) : '';
    const head = h('header', {}, avatar, h('strong', { text: name }), c.resolved ? h('span', { class: 'wm-comment-badge', text: t('panels.comments.resolved') }) : null, when ? h('time', { text: when, attrs: { datetime: c.date! } }) : null);
    const out = h('div', { class: 'wm-comment-entry' }, head);
    if (this.editing === c.id) {
      const box = this.box(`edit:${c.id}`, c.text);
      const save = h('button', { text: t('panels.comments.save'), class: 'wm-comment-primary', attrs: { type: 'button' } });
      const cancel = h('button', { text: t('panels.comments.cancel'), attrs: { type: 'button' } });
      const done = () => {
        const text = box.value.trim();
        this.drafts.delete(`edit:${c.id}`);
        this.editing = null;
        if (text && text !== c.text) this.host.edit(c.id, text);
        this.render();
      };
      const stop = () => {
        this.drafts.delete(`edit:${c.id}`);
        this.editing = null;
        this.render();
        this.host.focusEditor();
      };
      save.addEventListener('click', done);
      cancel.addEventListener('click', stop);
      wireBox(box, done, stop);
      out.append(box, h('div', { class: 'wm-comment-buttons' }, save, cancel));
      return out;
    }
    out.append(h('p', { text: c.text }));
    if (open) {
      const edit = h('button', { text: t('panels.comments.edit'), attrs: { type: 'button' } });
      const remove = h('button', { text: t('panels.comments.delete'), attrs: { type: 'button' } });
      edit.addEventListener('click', () => {
        this.editing = c.id;
        this.focusBox = `edit:${c.id}`;
        this.render();
      });
      remove.addEventListener('click', () => {
        this.host.remove(c.id);
        this.host.focusEditor();
      });
      out.append(h('div', { class: 'wm-comment-buttons' }, edit, remove));
    }
    return out;
  }

  /** Under an open thread: a box to reply in, and Resolve or Reopen. */
  private threadFooter(root: CommentInfo): HTMLElement {
    const key = `reply:${root.id}`;
    const box = this.box(key, '', t('panels.comments.replyPlaceholder'));
    const send = h('button', { text: t('panels.comments.reply'), class: 'wm-comment-primary', attrs: { type: 'button' } });
    const resolve = h('button', { text: root.resolved ? t('panels.comments.reopen') : t('panels.comments.resolve'), attrs: { type: 'button' } });
    const submit = () => {
      const text = box.value.trim();
      if (!text) return;
      this.drafts.delete(key);
      this.host.reply(root.id, text);
      this.focusBox = key;
    };
    send.addEventListener('click', submit);
    resolve.addEventListener('click', () => {
      this.host.resolve(root.id, !root.resolved);
      this.host.focusEditor();
    });
    wireBox(box, submit, () => {
      box.value = '';
      this.drafts.delete(key);
      this.host.focusEditor();
    });
    return h('footer', {}, box, h('div', { class: 'wm-comment-buttons' }, send, resolve));
  }

  private draftItem(): Item {
    const card = h('article', { class: 'wm-comment wm-comment-active wm-comment-draft' });
    const box = this.box('', '', t('panels.comments.addPlaceholder'));
    const send = h('button', { text: t('panels.comments.reply'), class: 'wm-comment-primary', attrs: { type: 'button' } });
    const cancel = h('button', { text: t('panels.comments.cancel'), attrs: { type: 'button' } });
    const submit = () => {
      const text = box.value.trim();
      if (!text) return;
      this.drafts.delete('');
      this.host.add(text);
      // The panel opens the new comment once the document reports it (update).
      this.host.focusEditor();
    };
    const stop = () => {
      this.drafts.delete('');
      this.drafting = false;
      this.render();
      this.host.focusEditor();
    };
    send.addEventListener('click', submit);
    cancel.addEventListener('click', stop);
    wireBox(box, submit, stop);
    card.append(box, h('div', { class: 'wm-comment-buttons' }, send, cancel));
    return { el: card, desired: this.host.placeCaret(), height: 0, active: true, top: NaN };
  }

  /** A text box that keeps what's typed in it across redraws and grows with it. */
  private box(key: string, text: string, placeholder = ''): HTMLTextAreaElement {
    const box = h('textarea', { class: 'wm-comment-box', attrs: { rows: '1', 'data-box': key, placeholder, 'aria-label': placeholder || t('panels.comments.edit') } });
    box.value = this.drafts.get(key) ?? text;
    box.addEventListener('input', () => {
      this.drafts.set(key, box.value);
      fit(box);
      this.remeasure();
    });
    queueMicrotask(() => fit(box));
    return box;
  }

  /** Opens a thread: shows it whole and puts the caret on its text. */
  private open(id: string): void {
    this.active = id;
    this.documentActive = id;
    this.render();
    this.host.select(id);
  }

  // --- Placing ---------------------------------------------------------------------------

  private remeasure(): void {
    for (const item of this.items) item.height = item.el.offsetHeight;
    this.position();
  }

  /** Puts each card beside its text, pushing them apart so none overlaps, keeping the open one on its text. */
  position(): void {
    if (this.el.hidden || !this.items.length) return;
    const items = this.items;
    // Refresh where each card's text is (the view moved).
    const threads = this.threads();
    const byId = new Map(threads.map((th) => [th.root.id, th.root]));
    for (const item of items) {
      const id = item.el.dataset.thread;
      const root = id ? byId.get(id) : undefined;
      if (root) item.desired = root.page === null ? null : this.host.place(root.page, root.y);
      else if (item.el.classList.contains('wm-comment-draft')) item.desired = this.host.placeCaret();
    }
    // Cards in the order their text is on the page; the new-comment card goes where the caret is.
    const order = items.map((item, i) => ({ item, i })).sort((a, b) => (a.item.desired ?? Infinity) - (b.item.desired ?? Infinity) || a.i - b.i).map((x) => x.item);
    let bottom = BAR;
    for (const item of order) {
      item.top = Math.max(item.desired ?? bottom, bottom);
      bottom = item.top + item.height + GAP;
    }
    // The open card stays beside its text: the ones above it move up out of its way.
    const at = order.findIndex((item) => item.active && item.desired !== null);
    if (at >= 0 && order[at].top > Math.max(order[at].desired!, BAR)) {
      order[at].top = Math.max(order[at].desired!, BAR);
      for (let i = at - 1; i >= 0; i--) {
        const limit = order[i + 1].top - GAP - order[i].height;
        if (order[i].top <= limit) break;
        order[i].top = limit;
      }
      for (let i = at + 1; i < order.length; i++) order[i].top = Math.max(order[i].top, order[i - 1].top + order[i - 1].height + GAP);
    }
    const viewport = this.el.clientHeight || Infinity;
    for (const item of order) {
      const y = `translateY(${Math.round(item.top)}px)`;
      if (item.el.style.transform !== y) item.el.style.transform = y;
      const off = item.top + item.height < BAR || item.top > viewport;
      item.el.style.visibility = off ? 'hidden' : '';
    }
  }
}

/** What a redraw depends on: the comments and the open thread. */
function renderKey(comments: readonly CommentInfo[], active: string | null): string {
  return JSON.stringify([comments.map(({ id, author, initials, date, text, parentId, resolved }) => [id, author, initials, date, text, parentId, resolved]), active]);
}

/** Enter sends (Shift+Enter is a new line), Escape gives up. */
function wireBox(box: HTMLTextAreaElement, send: () => void, cancel: () => void): void {
  box.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
}

function fit(box: HTMLTextAreaElement): void {
  box.style.height = 'auto';
  box.style.height = `${box.scrollHeight}px`;
}

/** Up to two letters for the avatar: the initials the document gave, else the name's. */
function initialsOf(initials: string | undefined, name: string): string {
  if (initials) return initials.slice(0, 2);
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return letters.map((w) => [...w][0]).join('').toUpperCase().slice(0, 2) || '?';
}

/** A colour for a person's avatar, the same each time. */
function colorOf(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (Math.imul(hash, 31) + ch.codePointAt(0)!) | 0;
  return `hsl(${Math.abs(hash) % 360} 55% 42%)`;
}
