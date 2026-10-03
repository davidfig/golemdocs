// The pages panel: a column of thumbnails to the left of the document, one per page, shown beside
// the editor so the document can be edited while it is open. A click goes to the page, and the page
// in view is the one marked. On a PDF in Edit PDF mode the pages can also be dragged into a new
// order and deleted (the buttons on each, or the Delete key); anywhere else the panel is for
// looking and moving around. Thumbnails are drawn lazily, only for the pages scrolled into view.

import { t } from '../i18n/index.ts';
import { h, toggleClass } from './dom.ts';
import { dropSlot, moveTarget } from './pageOrder.ts';
import { makeResizable } from './sidebarResize.ts';
import './pagesPanel.css';

/** What the panel needs to know about a page. The object itself identifies it: a page that is replaced is a new object. */
export interface PanelPage {
  readonly width: number;
  readonly height: number;
}

export interface PagesPanelHost {
  /** Scrolls the document to page `index`. */
  go(index: number): void;
  /** The page's pixels, top row first, at this size (null when it can't be drawn). */
  draw(page: PanelPage, width: number, height: number): Uint8ClampedArray<ArrayBuffer> | null;
  /** Page `index` is dragged to `to`, an index of the new order. */
  move(index: number, to: number): void;
  remove(index: number): void;
  close(): void;
  /** Gives the keyboard back to the document. */
  focusEditor(): void;
}

interface Item {
  el: HTMLLIElement;
  canvas: HTMLCanvasElement;
  label: HTMLElement;
  remove: HTMLButtonElement;
  page: PanelPage;
  /** What is on the canvas is out of date. */
  stale: boolean;
  onScreen: boolean;
}

/** What the panel's width has besides the thumbnail: the margins and the frame's border (see pagesPanel.css). */
const THUMB_MARGIN = 52;
/** Thumbnails drawn at once, before giving the editor a turn. */
const BATCH = 2;
/** How long to wait before redrawing thumbnails of pages that changed, so typing isn't slowed by it. */
const REDRAW_DELAY = 250;

export class PagesPanel {
  readonly el = h('aside', { class: 'wm-pages', attrs: { 'aria-label': t('panels.pages.label') } });
  private readonly list = h('ol', { class: 'wm-pages-list', attrs: { role: 'listbox', 'aria-label': t('panels.pages.label') } });
  private readonly hint = h('p', { class: 'wm-pages-hint' });
  private items: Item[] = [];
  private readonly byPage = new Map<PanelPage, Item>();
  private current = -1;
  private editable = false;
  private timer = 0;
  private dragFrom = -1;
  private dropAt: { item: Item; after: boolean } | null = null;
  private readonly observer = new IntersectionObserver(
    (records) => {
      for (const record of records) {
        const item = this.items.find((i) => i.el === record.target);
        if (item) item.onScreen = record.isIntersecting;
      }
      this.schedule(0);
    },
    { root: this.list, rootMargin: '300px 0px' },
  );

  constructor(parent: HTMLElement, private readonly host: PagesPanelHost) {
    this.el.hidden = true;
    const close = h('button', { class: 'wm-pages-close', text: '×', attrs: { type: 'button', 'aria-label': t('panels.pages.close') }, title: t('panels.pages.close') });
    close.addEventListener('click', () => host.close());
    this.el.append(h('header', { class: 'wm-pages-bar' }, h('h2', { text: t('panels.pages.label') }), close), this.list, this.hint);
    // Keys typed here stay here: the document's handlers listen on the window, and would take Delete and the arrows as edits.
    this.el.addEventListener('keydown', (e) => this.key(e));
    this.list.addEventListener('dragover', (e) => this.dragOver(e));
    this.list.addEventListener('drop', (e) => this.drop(e));
    this.list.addEventListener('dragleave', (e) => {
      if (!this.list.contains(e.relatedTarget as Node | null)) this.clearDrop();
    });
    parent.append(this.el);
    // A wider panel has bigger thumbnails: they are drawn again at the new size once the dragging pauses.
    makeResizable(this.el, { key: 'word.pagesWidth', min: 120, max: 480, initial: 168, changed: () => this.refresh() });
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  setVisible(visible: boolean): void {
    if (this.el.hidden === !visible) return;
    this.el.hidden = !visible;
    if (visible) this.schedule(0);
  }

  /** Whether the pages can be dragged and deleted, and what to say when they can't (null: nothing). */
  setEditable(editable: boolean, hint: string | null = null): void {
    if (this.hint.textContent !== (hint ?? '')) this.hint.textContent = hint ?? '';
    this.hint.hidden = !hint;
    if (editable === this.editable) return;
    this.editable = editable;
    this.list.classList.toggle('wm-pages-editable', editable);
    for (const item of this.items) item.el.draggable = editable;
  }

  /** The pages, in order. Thumbnails of pages that are the same objects as before are kept. */
  setPages(pages: readonly PanelPage[]): void {
    const keep = new Set(pages);
    // A page that changed (typing, a page moved) takes over the item of one that went away at the
    // same place, so its old thumbnail stays up until the new one is drawn.
    const spare = this.items.filter((i) => !keep.has(i.page));
    const next: Item[] = [];
    const taken = new Set<Item>();
    for (const page of pages) {
      let item = this.byPage.get(page);
      if (!item) {
        item = spare.find((s) => !taken.has(s));
        if (item) {
          taken.add(item);
          this.byPage.delete(item.page);
          item.page = page;
          item.stale = true;
          this.shape(item);
        } else {
          item = this.create(page);
        }
        this.byPage.set(page, item);
      }
      next.push(item);
    }
    for (const item of this.items) {
      if (next.includes(item)) continue;
      this.observer.unobserve(item.el);
      this.byPage.delete(item.page);
    }
    this.items = next;
    next.forEach((item, i) => this.number(item, i));
    this.list.replaceChildren(...next.map((i) => i.el));
    this.list.classList.toggle('wm-pages-single', next.length < 2);
    if (this.current >= next.length) this.current = -1;
    this.mark();
    this.schedule(REDRAW_DELAY);
  }

  /** Every thumbnail is drawn again (a font or picture they use has arrived since they were drawn). */
  refresh(): void {
    for (const item of this.items) item.stale = true;
    this.schedule(REDRAW_DELAY);
  }

  /**
   * Every thumbnail is drawn again at once in the new colors (Dark Pages turned on or off): the ones
   * in view right away, the rest are cleared to the sheet's color so none shows the old colors when scrolled to.
   */
  recolor(): void {
    for (const item of this.items) {
      item.stale = true;
      if (!item.onScreen) item.canvas.width = item.canvas.width; // clears it
    }
    this.drawSome(true);
  }

  /** The page in view. Scrolls the panel to it, unless the pointer is in the panel (where it is being scrolled by hand). */
  setCurrent(index: number): void {
    if (index === this.current) return;
    this.current = index;
    this.mark();
    if (!this.el.matches(':hover')) this.items[index]?.el.scrollIntoView({ block: 'nearest' });
  }

  // --- Items -----------------------------------------------------------------------------

  private create(page: PanelPage): Item {
    const canvas = h('canvas', { class: 'wm-pages-thumb' });
    const label = h('span', { class: 'wm-pages-number' });
    const remove = h('button', { class: 'wm-pages-delete', text: '×', attrs: { type: 'button', tabindex: '-1' } });
    const el = h('li', { class: 'wm-pages-item', attrs: { role: 'option', tabindex: '-1' } }, h('div', { class: 'wm-pages-frame' }, canvas, remove), label);
    const item: Item = { el, canvas, label, remove, page, stale: true, onScreen: false };
    el.draggable = this.editable;
    el.addEventListener('click', () => this.host.go(this.items.indexOf(item)));
    el.addEventListener('dragstart', (e) => {
      if (!this.editable) return e.preventDefault();
      this.dragFrom = this.items.indexOf(item);
      e.dataTransfer?.setData('text/plain', String(this.dragFrom));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      el.classList.add('wm-pages-dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('wm-pages-dragging');
      this.dragFrom = -1;
      this.clearDrop();
    });
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      this.host.remove(this.items.indexOf(item));
    });
    this.shape(item);
    this.observer.observe(el);
    return item;
  }

  /** Gives the thumbnail the page's shape. */
  private shape(item: Item): void {
    const { width, height } = item.page;
    item.canvas.style.aspectRatio = `${width} / ${height}`;
  }

  private number(item: Item, index: number): void {
    item.label.textContent = String(index + 1);
    item.el.setAttribute('aria-label', t('panels.pages.page', { number: index + 1 }));
    item.remove.setAttribute('aria-label', t('panels.pages.delete', { number: index + 1 }));
    item.remove.title = t('panels.pages.delete', { number: index + 1 });
  }

  private mark(): void {
    this.items.forEach((item, i) => {
      toggleClass(item.el, 'wm-pages-current', i === this.current);
      item.el.setAttribute('aria-selected', String(i === this.current));
    });
  }

  // --- Drawing ----------------------------------------------------------------------------

  private schedule(delay: number): void {
    if (this.timer || this.el.hidden) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.drawSome();
    }, delay);
  }

  /** Draws the stale thumbnails in view, a few at a time unless `all`. */
  private drawSome(all = false): void {
    if (this.el.hidden) return;
    const dpr = window.devicePixelRatio || 1;
    let drawn = 0;
    for (const item of this.items) {
      if (!item.stale || !item.onScreen) continue;
      if (drawn === BATCH && !all) return this.schedule(16);
      drawn++;
      const { width, height } = item.page;
      const w = Math.max(1, Math.round(Math.max(40, this.el.clientWidth - THUMB_MARGIN) * dpr));
      const h = Math.max(1, Math.round((w * height) / Math.max(1, width)));
      const pixels = this.host.draw(item.page, w, h);
      item.stale = false;
      if (!pixels) continue;
      item.canvas.width = w;
      item.canvas.height = h;
      item.canvas.getContext('2d')?.putImageData(new ImageData(pixels, w, h), 0, 0);
    }
  }

  // --- Keys ------------------------------------------------------------------------------------

  private key(e: KeyboardEvent): void {
    const index = this.items.findIndex((i) => i.el === document.activeElement);
    if (index < 0 && !(e.target instanceof HTMLElement && this.list.contains(e.target))) return;
    e.stopPropagation();
    const focus = (i: number): void => this.items[Math.max(0, Math.min(this.items.length - 1, i))]?.el.focus();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      if (e.altKey && this.editable && index >= 0) {
        const to = index + step;
        if (to >= 0 && to < this.items.length) {
          this.host.move(index, to);
          // The panel is rebuilt when the document comes back with its pages; the focus follows the page.
          window.setTimeout(() => focus(to), 0);
        }
      } else focus(index + step);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focus(e.key === 'Home' ? 0 : this.items.length - 1);
    } else if (e.key === 'Enter' && index >= 0) {
      e.preventDefault();
      this.host.go(index);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.editable && index >= 0 && this.items.length > 1) {
      e.preventDefault();
      this.host.remove(index);
      window.setTimeout(() => focus(index), 0);
    } else if (e.key === 'Escape') {
      this.host.focusEditor();
    }
  }

  // --- Dragging pages --------------------------------------------------------------------

  private dragOver(e: DragEvent): void {
    if (this.dragFrom < 0 || !this.editable) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const slot = dropSlot(
      this.items.map((i) => {
        const r = i.el.getBoundingClientRect();
        return r.top + r.height / 2;
      }),
      e.clientY,
    );
    this.clearDrop();
    const after = slot === this.items.length;
    const item = this.items[after ? slot - 1 : slot];
    if (!item) return;
    this.dropAt = { item, after };
    item.el.classList.add(after ? 'wm-pages-drop-after' : 'wm-pages-drop-before');
  }

  private drop(e: DragEvent): void {
    if (this.dragFrom < 0 || !this.dropAt) return;
    e.preventDefault();
    const slot = this.items.indexOf(this.dropAt.item) + (this.dropAt.after ? 1 : 0);
    const from = this.dragFrom;
    this.clearDrop();
    this.dragFrom = -1;
    const to = moveTarget(from, slot);
    if (to !== from) this.host.move(from, to);
  }

  private clearDrop(): void {
    this.dropAt?.item.el.classList.remove('wm-pages-drop-before', 'wm-pages-drop-after');
    this.dropAt = null;
  }
}
