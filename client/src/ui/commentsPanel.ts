// The comments panel: the open document's comment threads down the right of the editor, each card
// beside the text it is on. A thread is a first comment and its replies; the one the caret is in
// (or that was clicked) opens to show every reply, a box to reply in, and its buttons. Writing a
// new comment, changing one and replying happen in the panel, not in dialogs. Hidden while the
// document has no comments and none is being written.
//
// A feature that takes part in the comments (Afterward's readers, docs/afterward.md) plugs in through `CommentAgents`: it
// says which authors are its own, puts a note under a thread while it is working on it (or what went wrong), adds buttons to
// a thread, suggests names after "@" in a reply, and can show marks down the side of the panel beside the text.

import type { SelectionUpdate } from '../layout/protocol.ts';
import { t } from '../i18n/index.ts';
import { relativeTime } from './dashboardFormat.ts';
import { h } from './dom.ts';
import { listBox, type ListBox } from './listBox.ts';
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
  /** Where the right edge of the pages is, in CSS px from the panel's parent's left; null when there are none. */
  pagesRight?(): number | null;
  /** Gives the keyboard back to the document. */
  focusEditor(): void;
}

/** A button under a thread, or under a thread's note. */
export interface CommentAction {
  label: string;
  run(): void;
}

/** What a feature taking part in the comments adds to them (see the top of this file). */
export interface CommentAgents {
  /** One of the feature's own authors (shown with its icon and colour), or null for a person. */
  agent(author: string): { name: string; color: string; title?: string } | null;
  /** A note under a thread (its first comment's id): what is being worked on, or what went wrong, with its buttons. */
  note(thread: string): { text: string; error?: boolean; actions?: CommentAction[] } | null;
  /** More buttons under an open thread. */
  actions(root: CommentInfo, replies: readonly CommentInfo[]): CommentAction[];
  /** Names to suggest after "@" in a reply or a new comment. */
  mentions(): string[];
  /** Changes whenever what the hooks say changes (the panel redraws then). */
  key(): string;
  /** Cards of the feature's own, beside the text they are about (an editor's notes), placed with the comments. */
  cards?(): AgentCard[];
  /** A line under the panel's title (what the feature makes of the document), or ''. */
  subtitle?(): string;
  /** The panel's title while there are no comments, only the feature's cards, or ''. */
  title?(): string;
  /** After the panel has drawn the feature's cards (to put the keyboard in one). */
  drawn?(): void;
}

/** A feature's card in the panel: its element (the feature builds it), where on a page it belongs, and whether it is open. */
export interface AgentCard {
  id: string;
  el: HTMLElement;
  at: { page: number; y: number } | null;
  active?: boolean;
}

/** A mark beside the text: where it is (page id and y) and its dots, each with what it says there. */
/** What the marks mean: what each colour says. */
export interface MarksKey {
  levels: { level: string; label: string }[];
}

export interface SideMark {
  page: number;
  y: number;
  /** `kind` sets a dot apart (a chapter's, larger). */
  dots: { level: string; title: string; kind?: string }[];
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
  /** A feature's card: the place on a page it belongs beside. */
  at?: { page: number; y: number } | null;
  height: number;
  active: boolean;
  top: number;
}

/** Space between the pages and the panel, when it sits beside them. */
const BESIDE = 16;

/** Space above the first card, for the bar. */
const BAR_HEIGHT = 34;
/** Room under the bar, which a key of the marks makes taller. */
const UNDER_BAR = 4;
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
  private agents: CommentAgents | null = null;
  private readonly marksEl = h('div', { class: 'wm-comments-marks', attrs: { 'aria-hidden': 'true' } });
  private marks: { mark: SideMark; el: HTMLElement }[] = [];
  private legend: MarksKey | null = null;

  constructor(
    parent: HTMLElement,
    private readonly host: CommentsHost,
  ) {
    this.el.hidden = true;
    this.el.append(this.marksEl, this.bar, this.list);
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
    this.wanted = null;
    this.render();
  }

  /** Lets a feature take part in the comments (see `CommentAgents`). */
  setAgents(agents: CommentAgents | null): void {
    this.agents = agents;
    this.render();
  }

  /** Measures the cards again and places them (a card grew: text streaming into it), without drawing them again. */
  reflow(): void {
    this.remeasure();
  }

  /** Draws the panel again when what the agents say has changed. */
  refresh(): void {
    if (renderKey(this.comments, this.active) + (this.agents?.key() ?? '') !== this.shown) this.render();
  }

  /** Opens a thread, as a click on its card does; one just added opens as soon as the document reports it. */
  openThread(id: string): void {
    if (this.comments.some((c) => c.id === id)) this.open(id);
    else this.wanted = id;
  }

  /** A thread to open once the document has it (`openThread`). */
  private wanted: string | null = null;

  /** Shows marks down the side of the panel, beside the text they are on (none: takes them away). */
  setMarks(marks: readonly SideMark[], legend: MarksKey | null = null): void {
    this.legend = marks.length ? legend : null;
    this.marks = marks.map((mark) => {
      const el = h('div', { class: 'wm-comments-mark' });
      for (const dot of mark.dots) el.append(h('span', { class: `wm-comments-dot wm-dot-${dot.level}${dot.kind ? ` wm-comments-dot-${dot.kind}` : ''}`, title: dot.title }));
      return { mark, el };
    });
    this.marksEl.replaceChildren(...this.marks.map((m) => m.el));
    this.el.classList.toggle('wm-comments-with-marks', this.marks.length > 0);
    this.render();
  }

  update(comments: readonly CommentInfo[], active: string | null = null): void {
    let changed = false;
    if (active !== this.documentActive) {
      this.documentActive = active;
      this.active = active;
      changed = true;
    }
    if (renderKey(comments, this.active) + (this.agents?.key() ?? '') === this.shown && !changed) return;
    // A comment the panel was waiting for (written here) opens.
    const known = new Set(this.comments.map((c) => c.id));
    this.comments = comments;
    if (this.wanted && comments.some((c) => c.id === this.wanted)) {
      const id = this.wanted;
      this.wanted = null;
      return this.open(id);
    }
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
    this.shown = renderKey(this.comments, this.active) + (this.agents?.key() ?? '');
    const threads = this.threads();
    const cards = this.agents?.cards?.() ?? [];
    const subtitle = this.agents?.subtitle?.() ?? '';
    this.el.hidden = threads.length === 0 && !this.drafting && this.marks.length === 0 && cards.length === 0 && !subtitle;
    this.el.ariaLabel = t('panels.comments.label');
    this.buildBar(threads);
    const visible = threads.filter((th) => this.showResolved || !th.root.resolved || th.root.id === this.active);
    this.items = visible.map((th) => this.threadItem(th));
    if (this.drafting) this.items.push(this.draftItem());
    for (const card of cards) {
      card.el.classList.add('wm-agent-card');
      this.items.push({ el: card.el, at: card.at, desired: card.at ? this.host.place(card.at.page, card.at.y) : null, height: 0, active: !!card.active, top: NaN });
    }
    this.list.replaceChildren(...this.items.map((i) => i.el));
    for (const item of this.items) item.height = item.el.offsetHeight;
    this.position();
    if (cards.length) this.agents?.drawn?.();
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
      h('h2', { text: total === 0 && this.agents?.title?.() ? this.agents.title() : t('panels.comments.title', { count: total }) }),
      previous,
      next,
      h('label', {}, toggle, h('span', { text: t('panels.comments.showResolved') })),
    );
    const subtitle = this.agents?.subtitle?.() ?? '';
    if (subtitle) this.bar.append(h('p', { class: 'wm-comments-subtitle', text: subtitle }));
    // The marks' key: what each colour says.
    if (this.legend) {
      const levels = this.legend.levels.map((l) => h('span', { class: 'wm-comments-key-level' }, h('span', { class: `wm-comments-dot wm-dot-${l.level}` }), l.label));
      this.bar.append(h('div', { class: 'wm-comments-key' }, h('p', {}, ...levels)));
    }
  }

  private threadItem({ root, replies }: Thread): Item {
    const open = this.active === root.id;
    const card = h('article', { class: `wm-comment${open ? ' wm-comment-active' : ''}${root.resolved ? ' wm-comment-resolved' : ''}`, attrs: { tabindex: '0', 'data-thread': root.id } });
    card.append(this.comment(root, open));
    if (open) for (const reply of replies) card.append(this.comment(reply, true));
    else if (replies.length) card.append(h('p', { class: 'wm-comment-count', text: t('panels.comments.replies', { count: replies.length }) }));
    const note = this.agents?.note(root.id);
    if (note) {
      const buttons = (note.actions ?? []).map((a) => {
        const button = h('button', { text: a.label, attrs: { type: 'button' } });
        button.addEventListener('click', () => a.run());
        return button;
      });
      card.append(h('div', { class: `wm-comment-note${note.error ? ' wm-comment-note-error' : ''}`, attrs: { role: note.error ? 'alert' : 'status' } }, h('p', { text: note.text }), buttons.length ? h('div', { class: 'wm-comment-buttons' }, ...buttons) : null));
    }
    if (open) card.append(this.threadFooter(root, replies));
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
    const agent = c.author ? this.agents?.agent(c.author) : null;
    const name = agent?.name ?? (c.author || t('panels.comments.unknown'));
    const avatar = h('span', { class: `wm-comment-avatar${agent ? ' wm-comment-agent' : ''}`, text: agent ? '' : initialsOf(c.initials, name), attrs: { 'aria-hidden': 'true' } });
    if (agent) avatar.append(readerIcon());
    avatar.style.background = agent?.color ?? colorOf(name);
    // A date the document got wrong isn't shown (rather than "Invalid Date").
    const when = c.date ? relativeTime(Date.parse(c.date)) : '';
    const head = h('header', {}, avatar, h('strong', { text: name, ...(agent?.title ? { title: agent.title } : {}) }), c.resolved ? h('span', { class: 'wm-comment-badge', text: t('panels.comments.resolved') }) : null, when ? h('time', { text: when, attrs: { datetime: c.date! } }) : null);
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
  private threadFooter(root: CommentInfo, replies: readonly CommentInfo[]): HTMLElement {
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
    const more = (this.agents?.actions(root, replies) ?? []).map((a) => {
      const button = h('button', { text: a.label, attrs: { type: 'button' } });
      button.addEventListener('click', () => a.run());
      return button;
    });
    return h('footer', {}, box, this.mentionList(box), h('div', { class: 'wm-comment-buttons wm-comment-buttons-wrap' }, send, resolve, ...more));
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
    card.append(box, this.mentionList(box), h('div', { class: 'wm-comment-buttons' }, send, cancel));
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

  /**
   * The names to pick from while a "@name" is being typed at the end of what's before the cursor: Up and Down move through
   * them, Enter or Tab puts the picked one in. Hidden when there is nothing to suggest.
   */
  private mentionList(box: HTMLTextAreaElement): HTMLElement {
    const names = this.agents?.mentions() ?? [];
    let list: ListBox | null = null;
    const holder = h('div', { class: 'wm-comment-mentions' });
    holder.hidden = true;
    if (!names.length) return holder;
    const typed = (): { at: number; word: string } | null => {
      const before = box.value.slice(0, box.selectionStart);
      const match = /(?:^|\s)@([\p{L}\p{N}-]*)$/u.exec(before);
      return match ? { at: before.length - match[1].length, word: match[1].toLowerCase() } : null;
    };
    const choose = (name: string) => {
      const at = typed();
      if (!at) return;
      const rest = box.value.slice(box.selectionStart);
      box.value = `${box.value.slice(0, at.at)}${name} ${rest.replace(/^\s+/, '')}`;
      const caret = at.at + name.length + 1;
      box.setSelectionRange(caret, caret);
      box.dispatchEvent(new Event('input'));
      holder.hidden = true;
      box.focus();
    };
    const show = () => {
      const at = typed();
      const found = at ? names.filter((n) => n.toLowerCase().includes(at.word) || n.toLowerCase().replace(/^(the|a|an)\s+/, '').startsWith(at.word)) : [];
      holder.hidden = found.length === 0;
      if (!found.length) return;
      if (!list) {
        list = listBox(t('panels.comments.mention'), { rows: Math.min(4, names.length), onChoose: choose });
        list.el.addEventListener('mousedown', (e) => e.preventDefault());
        list.el.addEventListener('click', () => list && list.value && choose(list.value));
        holder.append(list.el);
      }
      list.set(found);
      this.remeasure();
    };
    box.addEventListener('input', show);
    box.addEventListener('blur', () => setTimeout(() => (holder.hidden = true), 150));
    // Before the box's own keys (Enter sends): while names are shown, the keys pick among them.
    box.addEventListener(
      'keydown',
      (e) => {
        if (holder.hidden || !list || e.isComposing) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopImmediatePropagation();
          list.pick(Math.max(0, list.index + (e.key === 'ArrowDown' ? 1 : -1)));
        } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (list.value) choose(list.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
          holder.hidden = true;
        }
      },
      { capture: true },
    );
    return holder;
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
    if (this.el.hidden || (!this.items.length && !this.marks.length)) return;
    const BAR = this.legend || this.agents?.subtitle?.() ? this.bar.offsetTop + this.bar.offsetHeight + UNDER_BAR : BAR_HEIGHT;
    // Beside the pages, as a margin of their own, when the window has room; else against the window's right edge.
    const right = this.host.pagesRight?.() ?? null;
    const room = this.el.parentElement?.clientWidth ?? 0;
    const beside = right !== null && right + BESIDE + this.el.offsetWidth + 8 <= room;
    const left = beside ? `${Math.round(right + BESIDE)}px` : '';
    if (this.el.style.left !== left) {
      this.el.style.left = left;
      this.el.style.right = beside ? 'auto' : '';
    }
    const items = this.items;
    // Refresh where each card's text is (the view moved).
    const threads = this.threads();
    const byId = new Map(threads.map((th) => [th.root.id, th.root]));
    for (const item of items) {
      const id = item.el.dataset.thread;
      const root = id ? byId.get(id) : undefined;
      if (root) item.desired = root.page === null ? null : this.host.place(root.page, root.y);
      else if (item.at !== undefined) item.desired = item.at ? this.host.place(item.at.page, item.at.y) : null;
      else if (item.el.classList.contains('wm-comment-draft')) item.desired = this.host.placeCaret();
    }
    // Cards in the order their text is on the page; the new-comment card goes where the caret is. A card scrolls with its
    // text, off the top too: cards are only pushed down so they don't cover one another, never held under the bar (which
    // stacked every card whose text had scrolled away there and pushed the rest away from their text). A card whose text
    // isn't on a page shown has nowhere to be, and isn't shown.
    const placed = items.filter((item) => item.desired !== null || item.el.classList.contains('wm-comment-draft'));
    for (const item of items) if (!placed.includes(item)) item.top = NaN;
    const order = placed.map((item, i) => ({ item, i })).sort((a, b) => (a.item.desired ?? BAR) - (b.item.desired ?? BAR) || a.i - b.i).map((x) => x.item);
    let bottom = -Infinity;
    for (const item of order) {
      item.top = Math.max(item.desired ?? BAR, bottom);
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
    for (const { mark, el } of this.marks) {
      const top = this.host.place(mark.page, mark.y);
      el.hidden = top === null || top < BAR || top > viewport;
      if (top !== null) el.style.transform = `translateY(${Math.round(top)}px)`;
    }
    for (const item of items) {
      if (Number.isNaN(item.top)) {
        item.el.style.visibility = 'hidden';
        continue;
      }
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

/** The avatar of a reader rather than a person: an open book, drawn (not a character, see AGENTS.md). */
export function readerIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M8 4.5C6.5 3.3 4.4 3 2 3.2v8.6c2.4-.2 4.5.1 6 1.3 1.5-1.2 3.6-1.5 6-1.3V3.2C11.6 3 9.5 3.3 8 4.5zM8 4.5v8.6');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

/** A colour for a person's avatar, the same each time. */
function colorOf(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (Math.imul(hash, 31) + ch.codePointAt(0)!) | 0;
  return `hsl(${Math.abs(hash) % 360} 55% 42%)`;
}
