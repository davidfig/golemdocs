// The pages panel: a column of thumbnails to the left of the document, one per page, shown beside
// the editor so the document can be edited while it is open. A click goes to the page, and the page
// in view is the one marked. On a PDF the pages can also be dragged into a new order and deleted
// (the buttons on each, or the Delete key), in Fill In and Edit PDF alike; anywhere else the panel
// is for looking and moving around.
//
// Only the pages scrolled into the panel (and a little either side) have an item: a book of tens of thousands of pages made one
// for every page, which took a gigabyte and stopped the tab for minutes. Where every item sits is worked out from the page sizes
// (thumbList.ts), a tall invisible sizer gives the list its full height, and items are placed over it as it scrolls, recycled when
// they leave. Each item says which page of how many it is (aria-posinset, aria-setsize), so a screen reader still hears the whole
// list. The focused item and the one being dragged are kept while they are scrolled away, so neither the focus nor a drag is lost.
// Thumbnails are drawn lazily, only for the items there are.

import { t } from '../i18n/index.ts';
import { CLOSE_ICON, h, iconButton, toggleClass } from './dom.ts';
import { dropSlot, moveTarget } from './pageOrder.ts';
import { makeResizable } from './sidebarResize.ts';
import { itemTops, itemsBetween } from './thumbList.ts';
import './pagesPanel.css';

/** What the panel needs to know about a page. The object itself identifies it: a page that is replaced is a new object. */
export interface PanelPage {
  readonly width: number;
  readonly height: number;
}

export interface PagesPanelHost {
  /** Scrolls the document to page `index`. */
  go(index: number): void;
  /** The page's thumbnail; null if it can't be drawn, undefined if it isn't ready yet (asked again in a moment). */
  draw(page: PanelPage, width: number, height: number): Uint8ClampedArray<ArrayBuffer> | null | undefined;
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
  /** Its place in the list. */
  index: number;
  /** What is on the canvas is out of date. */
  stale: boolean;
}

/** How much narrower than the list a thumbnail is: the frame's width is the item's less this (see .wm-pages-frame). */
const FRAME_INSET = 48;
/** An item's height besides its thumbnail (padding, the frame's border, the gap, the number), until one is measured. */
const CHROME = 36;
/** The list's padding at its top and bottom (see .wm-pages-list). */
const PADDING = 10;
/** How far past the top and bottom of the panel items are made, so they are drawn before they are scrolled to. */
const OVERSCAN = 300;
/** Items kept for reuse when they are scrolled away. */
const SPARE = 32;
/** How soon a thumbnail that wasn't ready is asked for again. */
const RETRY_MS = 50;
/** Thumbnails drawn at once, before giving the editor a turn. */
const BATCH = 2;
/** How long a document must stay unchanged before the thumbnails of pages that changed are redrawn: each redraw reads the GPU back, which stalls typing. */
const REDRAW_DELAY = 250;

export class PagesPanel {
  readonly el = h('aside', { class: 'wm-pages', attrs: { 'aria-label': t('panels.pages.label') } });
  private readonly list = h('ol', { class: 'wm-pages-list', attrs: { role: 'listbox', 'aria-label': t('panels.pages.label') } });
  /** Gives the list the height of all its items, most of which are not there. */
  private readonly sizer = h('li', { class: 'wm-pages-sizer', attrs: { role: 'presentation', 'aria-hidden': 'true' } });
  private pages: readonly PanelPage[] = [];
  /** Where each item starts (see itemTops), for `pages`. */
  private tops: Float64Array<ArrayBuffer> = new Float64Array(16);
  private thumbWidth = 0;
  private chrome = CHROME;
  private measured = false;
  /** The items there are, by their place in the list. */
  private readonly shown = new Map<number, Item>();
  private readonly spare: Item[] = [];
  /** The pages last given while the panel was hidden: nothing is built for them until it is shown. */
  private unshown: readonly PanelPage[] | null = null;
  private current = -1;
  private editable = false;
  private timer = 0;
  private frame = 0;
  private dragFrom = -1;
  private dropAt: { item: Item; after: boolean } | null = null;

  constructor(parent: HTMLElement, private readonly host: PagesPanelHost) {
    this.el.hidden = true;
    const close = iconButton('wm-pages-close', CLOSE_ICON, t('panels.pages.close'));
    close.addEventListener('click', () => host.close());
    this.list.append(this.sizer);
    this.el.append(h('header', { class: 'wm-pages-bar' }, h('h2', { text: t('panels.pages.label') }), close), this.list);
    // Keys typed here stay here: the document's handlers listen on the window, and would take Delete and the arrows as edits.
    this.el.addEventListener('keydown', (e) => this.key(e));
    this.list.addEventListener('dragover', (e) => this.dragOver(e));
    this.list.addEventListener('drop', (e) => this.drop(e));
    this.list.addEventListener('dragleave', (e) => {
      if (!this.list.contains(e.relatedTarget as Node | null)) this.clearDrop();
    });
    this.list.addEventListener('scroll', () => this.placeSoon(), { passive: true });
    // A wider panel has wider thumbnails (so every item moves), a taller one shows more of them.
    new ResizeObserver(() => this.relayout()).observe(this.list);
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
    if (visible) {
      const waiting = this.unshown;
      this.unshown = null;
      if (waiting) this.update(waiting);
      else this.relayout();
      this.schedule(0);
    }
  }

  /** Whether the pages can be dragged and deleted. */
  setEditable(editable: boolean): void {
    if (editable === this.editable) return;
    this.editable = editable;
    this.list.classList.toggle('wm-pages-editable', editable);
    for (const item of this.shown.values()) item.el.draggable = editable;
  }

  /**
   * The pages, in order. Thumbnails of pages that are the same objects as before are kept. A hidden panel only remembers them: a
   * document being laid out sends this after every slice of pages, which for thousands of pages is too much to build for nobody to see.
   */
  setPages(pages: readonly PanelPage[]): void {
    if (this.el.hidden) {
      this.unshown = pages;
      return;
    }
    this.update(pages);
  }

  private update(pages: readonly PanelPage[]): void {
    this.pages = pages;
    // An item whose page changed (typing, a page moved) takes the page now in its place, keeping its old thumbnail until the new
    // one is drawn.
    for (const [index, item] of this.shown) {
      const page = pages[index];
      if (!page) this.recycle(item);
      else if (page !== item.page) {
        item.page = page;
        item.stale = true;
        this.shape(item);
      }
      if (page) item.el.setAttribute('aria-setsize', String(pages.length));
    }
    this.list.classList.toggle('wm-pages-single', pages.length < 2);
    if (this.current >= pages.length) this.current = -1;
    this.relayout();
    this.schedule(REDRAW_DELAY, true);
  }

  /** Every thumbnail is drawn again (a font or picture they use has arrived since they were drawn). */
  refresh(): void {
    for (const item of this.shown.values()) item.stale = true;
    this.forgetSpare();
    this.schedule(REDRAW_DELAY);
  }

  /** Every thumbnail is drawn again at once in the new colors (Dark Pages turned on or off); items made later are drawn new anyway. */
  recolor(): void {
    for (const item of this.shown.values()) item.stale = true;
    this.forgetSpare();
    this.drawSome(true);
  }

  /** Items kept for reuse would come back with pictures drawn before a change: they are let go. */
  private forgetSpare(): void {
    this.spare.length = 0;
  }

  /** The page in view. Scrolls the panel to it, unless the pointer is in the panel (where it is being scrolled by hand). */
  setCurrent(index: number): void {
    if (index === this.current) return;
    this.current = index;
    this.mark();
    if (!this.el.matches(':hover')) this.reveal(index);
  }

  // --- Placing items ---------------------------------------------------------------------

  /** Works out where every item goes (the thumbnails' width may have changed) and places the ones in view. */
  private relayout(): void {
    if (this.el.hidden) return;
    const width = this.list.clientWidth;
    if (!width) return;
    this.thumbWidth = Math.max(1, width - FRAME_INSET);
    this.tops = itemTops(this.pages, this.thumbWidth, this.chrome, PADDING, this.tops);
    this.sizer.style.height = `${Math.max(0, this.tops[this.pages.length] - PADDING)}px`;
    this.place();
  }

  private placeSoon(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.place();
    });
  }

  /** Makes the items for the pages in view (and a little either side), and lets the others go. */
  private place(): void {
    if (this.el.hidden) return;
    const top = this.list.scrollTop;
    const { first, last } = itemsBetween(this.tops, this.pages.length, top - OVERSCAN, top + this.list.clientHeight + OVERSCAN);
    // The focused item and the one being dragged stay, wherever they are scrolled to.
    const kept = (index: number) => index === this.dragFrom || this.shown.get(index)?.el.contains(document.activeElement) === true;
    for (const [index, item] of this.shown) if ((index < first || index >= last) && !kept(index)) this.recycle(item);
    let made = false;
    for (let index = first; index < last; index++) {
      if (this.shown.has(index)) continue;
      this.make(index);
      made = true;
    }
    for (const [index, item] of this.shown) item.el.style.top = `${this.tops[index]}px`;
    if (made) {
      if (!this.measured) this.measure();
      this.schedule(0);
    }
  }

  /** Measures what an item takes besides its thumbnail, once, and places the items again if the guess was off. */
  private measure(): void {
    const item = this.shown.values().next().value;
    if (!item) return;
    const whole = item.el.getBoundingClientRect().height;
    const thumb = item.canvas.getBoundingClientRect().height;
    if (!whole || !thumb) return;
    this.measured = true;
    const chrome = whole - thumb;
    if (Math.abs(chrome - this.chrome) < 0.5) return;
    this.chrome = chrome;
    this.relayout();
  }

  /** Scrolls the list just enough to show item `index` whole. */
  private reveal(index: number): void {
    if (index < 0 || index >= this.pages.length || this.el.hidden) return;
    const top = this.tops[index];
    const bottom = this.tops[index + 1];
    const view = this.list.clientHeight;
    if (top < this.list.scrollTop) this.list.scrollTop = top - PADDING;
    else if (bottom > this.list.scrollTop + view) this.list.scrollTop = bottom - view + PADDING;
    this.place();
  }

  // --- Items -----------------------------------------------------------------------------

  private make(index: number): Item {
    const item = this.spare.pop() ?? this.create();
    if (item.page !== this.pages[index]) {
      item.canvas.width = item.canvas.width; // clears another page's picture
      item.stale = true;
    }
    item.page = this.pages[index];
    item.el.draggable = this.editable;
    this.shape(item);
    this.number(item, index);
    toggleClass(item.el, 'wm-pages-current', index === this.current);
    item.el.setAttribute('aria-selected', String(index === this.current));
    // In the list in page order, so the items read (and are found) in order.
    let before: Item | null = null;
    for (const [other, shown] of this.shown) if (other > index && (!before || other < before.index)) before = shown;
    this.list.insertBefore(item.el, before ? before.el : null);
    this.shown.set(index, item);
    return item;
  }

  private recycle(item: Item): void {
    this.shown.delete(item.index);
    if (this.dropAt?.item === item) this.clearDrop();
    item.el.remove();
    item.el.classList.remove('wm-pages-dragging');
    if (this.spare.length < SPARE) this.spare.push(item);
  }

  private create(): Item {
    const canvas = h('canvas', { class: 'wm-pages-thumb' });
    const label = h('span', { class: 'wm-pages-number' });
    const remove = h('button', { class: 'wm-pages-delete', text: '×', attrs: { type: 'button', tabindex: '-1' } });
    const el = h('li', { class: 'wm-pages-item', attrs: { role: 'option', tabindex: '-1' } }, h('div', { class: 'wm-pages-frame' }, canvas, remove), label);
    const item: Item = { el, canvas, label, remove, page: { width: 0, height: 0 }, index: -1, stale: true };
    el.addEventListener('click', () => this.host.go(item.index));
    el.addEventListener('dragstart', (e) => {
      if (!this.editable) return e.preventDefault();
      this.dragFrom = item.index;
      e.dataTransfer?.setData('text/plain', String(this.dragFrom));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      el.classList.add('wm-pages-dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('wm-pages-dragging');
      this.dragFrom = -1;
      this.clearDrop();
      this.place(); // it may have been kept only for the drag
    });
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      this.host.remove(item.index);
    });
    return item;
  }

  /** Gives the thumbnail the page's shape. */
  private shape(item: Item): void {
    const { width, height } = item.page;
    item.canvas.style.aspectRatio = `${width} / ${height}`;
  }

  private number(item: Item, index: number): void {
    item.index = index;
    item.label.textContent = String(index + 1);
    item.el.setAttribute('aria-label', t('panels.pages.page', { number: index + 1 }));
    item.el.setAttribute('aria-posinset', String(index + 1));
    item.el.setAttribute('aria-setsize', String(this.pages.length));
    item.remove.setAttribute('aria-label', t('panels.pages.delete', { number: index + 1 }));
    item.remove.title = t('panels.pages.delete', { number: index + 1 });
  }

  private mark(): void {
    for (const [index, item] of this.shown) {
      toggleClass(item.el, 'wm-pages-current', index === this.current);
      item.el.setAttribute('aria-selected', String(index === this.current));
    }
  }

  // --- Drawing ----------------------------------------------------------------------------

  /** Draws after `delay`; with `restart`, a wait already under way starts over (so a run of edits draws once, after it). */
  private schedule(delay: number, restart = false): void {
    if (this.el.hidden) return;
    if (this.timer) {
      if (!restart) return;
      window.clearTimeout(this.timer);
    }
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.drawSome();
    }, delay);
  }

  /** Draws the stale thumbnails of the items there are, a few at a time unless `all`. */
  private drawSome(all = false): void {
    if (this.el.hidden) return;
    const dpr = window.devicePixelRatio || 1;
    let drawn = 0;
    let retry = false;
    for (const item of this.shown.values()) {
      if (!item.stale) continue;
      if (drawn === BATCH && !all) return this.schedule(16);
      drawn++;
      const { width, height } = item.page;
      const w = Math.max(1, Math.round(Math.max(40, this.thumbWidth) * dpr));
      const h = Math.max(1, Math.round((w * height) / Math.max(1, width)));
      const pixels = this.host.draw(item.page, w, h);
      if (pixels === undefined) {
        retry = true;
        continue;
      }
      item.stale = false;
      if (!pixels) continue;
      item.canvas.width = w;
      item.canvas.height = h;
      item.canvas.getContext('2d')?.putImageData(new ImageData(pixels, w, h), 0, 0);
    }
    if (retry) this.schedule(RETRY_MS);
  }

  // --- Keys ------------------------------------------------------------------------------------

  /** The place of the focused item, or -1. */
  private focused(): number {
    for (const [index, item] of this.shown) if (item.el === document.activeElement) return index;
    return -1;
  }

  /** Focuses item `index` (clamped to the list), scrolling it into view and making it if it isn't there. */
  private focus(index: number): void {
    if (!this.pages.length) return;
    const i = Math.max(0, Math.min(this.pages.length - 1, index));
    this.reveal(i);
    (this.shown.get(i) ?? this.make(i)).el.focus();
  }

  private key(e: KeyboardEvent): void {
    const index = this.focused();
    if (index < 0 && !(e.target instanceof HTMLElement && this.list.contains(e.target))) return;
    e.stopPropagation();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      if (e.altKey && this.editable && index >= 0) {
        const to = index + step;
        if (to >= 0 && to < this.pages.length) {
          this.host.move(index, to);
          // The panel is rebuilt when the document comes back with its pages; the focus follows the page.
          window.setTimeout(() => this.focus(to), 0);
        }
      } else this.focus(index + step);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      this.focus(e.key === 'Home' ? 0 : this.pages.length - 1);
    } else if (e.key === 'Enter' && index >= 0) {
      e.preventDefault();
      this.host.go(index);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.editable && index >= 0 && this.pages.length > 1) {
      e.preventDefault();
      this.host.remove(index);
      window.setTimeout(() => this.focus(index), 0);
    } else if (e.key === 'Escape') {
      this.host.focusEditor();
    }
  }

  // --- Dragging pages --------------------------------------------------------------------

  /** The items there are, in page order. */
  private inOrder(): Item[] {
    return [...this.shown.values()].sort((a, b) => a.index - b.index);
  }

  private dragOver(e: DragEvent): void {
    if (this.dragFrom < 0 || !this.editable) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    // Among the items there are: the list scrolls under a drag held near its edge, making the ones further on.
    const items = this.inOrder();
    const slot = dropSlot(
      items.map((i) => {
        const r = i.el.getBoundingClientRect();
        return r.top + r.height / 2;
      }),
      e.clientY,
    );
    this.clearDrop();
    const after = slot === items.length;
    const item = items[after ? slot - 1 : slot];
    if (!item) return;
    this.dropAt = { item, after };
    item.el.classList.add(after ? 'wm-pages-drop-after' : 'wm-pages-drop-before');
  }

  private drop(e: DragEvent): void {
    if (this.dragFrom < 0 || !this.dropAt) return;
    e.preventDefault();
    const slot = this.dropAt.item.index + (this.dropAt.after ? 1 : 0);
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
