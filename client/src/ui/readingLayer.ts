// Screen Reader Mode: the reading layer. The pages are drawn on a canvas, which screen readers cannot read, so the
// pages near the view are described here as real HTML (headings, paragraphs, lists, tables, links, pictures), laid
// invisibly over the lines they stand for. That gives the screen reader's own reading (its virtual cursor, jumping by
// heading or table) and lets touch exploration and magnifiers find each line where it is drawn. The structure comes
// from the layout worker (layout/a11y.ts) one page at a time; pages far from the view are left out, and a list of
// every heading and buttons to the pages before and after lead on. Activating a piece puts the caret there.

import { t } from '../i18n/index.ts';
import type { A11yHeading, A11yNode, A11yPage } from '../layout/a11y.ts';
import { h } from './dom.ts';

/** Pages either side of those in view that are described too, so reading on does not run out at the edge of the screen. */
const PAGES_AROUND = 2;
/** How long the pages in view have to settle before they are asked for (scrolling asks for nothing until it stops). */
const REQUEST_MS = 150;

export interface ReadingHost {
  /** Asks the layout worker for these pages' structure (and the headings): answered through `receive`. */
  request(pages: number[], headings: boolean): void;
  /** Puts the caret at a paragraph (index among the body's) and offset, and gives the document the keyboard. */
  goTo(paragraph: number, offset: number): void;
  /** Scrolls a page (by id) into view. */
  showPage(id: number): void;
}

/** Where a page is, in document points. */
export interface PagePlace {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The view: its top-left corner in document points, CSS pixels per point, and its size in CSS pixels. */
export interface ViewPlace {
  x: number;
  y: number;
  scale: number;
  width: number;
  height: number;
}

export class ReadingLayer {
  readonly root = h('div', { class: 'wm-reading', attrs: { role: 'document' } });
  private readonly headingList = h('ul', {});
  private readonly headingNav = h('nav', { class: 'wm-sr-only' }, this.headingList);
  private readonly before = h('button', { class: 'wm-sr-only', attrs: { type: 'button' } });
  private readonly after = h('button', { class: 'wm-sr-only', attrs: { type: 'button' } });
  private readonly pagesEl = h('div', {});
  private on = false;
  /** Structure of pages by id, as the worker sent it (a page keeps its id only while its content is unchanged). */
  private readonly cache = new Map<number, A11yPage>();
  /** The built element of each page shown. */
  private readonly shown = new Map<number, HTMLElement>();
  /** Ids of the pages to describe now, in order. */
  private wanted: number[] = [];
  private requested = '';
  private headingsStale = true;
  private requestTimer = 0;
  private beforeId: number | null = null;
  private afterId: number | null = null;

  constructor(private readonly host: ReadingHost) {
    this.root.hidden = true;
    this.root.append(this.headingNav, this.before, this.pagesEl, this.after);
    this.before.addEventListener('click', () => this.beforeId !== null && this.host.showPage(this.beforeId));
    this.after.addEventListener('click', () => this.afterId !== null && this.host.showPage(this.afterId));
    this.root.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const link = target?.closest('a');
      // A link to another site opens beside the app; one inside the document, like any other piece, puts the caret there.
      if (link && /^(https?|mailto|tel|ftp):/i.test(link.getAttribute('href') ?? '')) return;
      const piece = target?.closest<HTMLElement>('[data-paragraph]');
      if (!piece) return;
      e.preventDefault();
      const paragraph = Number(piece.dataset.paragraph);
      if (paragraph >= 0) this.host.goTo(paragraph, Number(piece.dataset.offset ?? 0));
    });
  }

  get active(): boolean {
    return this.on;
  }

  /** Turns the layer on or off (off: everything is let go of). */
  setOn(on: boolean, documentName: string): void {
    this.on = on;
    this.root.hidden = !on;
    this.clear();
    if (on) this.setName(documentName);
  }

  /** The name the layer is read with: the document's. */
  setName(documentName: string): void {
    this.root.setAttribute('aria-label', documentName);
    this.headingNav.setAttribute('aria-label', t('a11y.headings'));
  }

  /** Another document opened, or none is: nothing of the old one is kept. */
  clear(): void {
    this.cache.clear();
    for (const el of this.shown.values()) el.remove();
    this.shown.clear();
    this.wanted = [];
    this.requested = '';
    this.headingsStale = true;
    this.headingList.replaceChildren();
    this.before.hidden = this.after.hidden = true;
  }

  /** The document was laid out again (an edit): pages that changed have new ids, and the headings may have changed. */
  changed(dropped: readonly number[]): void {
    for (const id of dropped) this.cache.delete(id);
    this.headingsStale = true;
    this.requested = '';
  }

  /** Places the layer over the pages, and asks for pages that came into view. Called every frame. */
  position(view: ViewPlace, pages: readonly PagePlace[]): void {
    if (!this.on) return;
    const top = view.y;
    const bottom = view.y + view.height / view.scale;
    let first = -1;
    let last = -1;
    pages.forEach((page, i) => {
      if (page.y + page.height >= top && page.y <= bottom) {
        if (first < 0) first = i;
        last = i;
      }
    });
    const from = Math.max(0, first < 0 ? 0 : first - PAGES_AROUND);
    const to = Math.min(pages.length, (last < 0 ? 0 : last) + PAGES_AROUND + 1);
    const wanted = pages.slice(from, to).map((p) => p.id);
    this.beforeId = from > 0 ? pages[from - 1].id : null;
    this.afterId = to < pages.length ? pages[to].id : null;
    this.wanted = wanted;
    const key = wanted.join(',');
    if (key !== this.requested) {
      this.requested = key;
      clearTimeout(this.requestTimer);
      this.requestTimer = window.setTimeout(() => this.ask(), REQUEST_MS);
    }
    const byId = new Map(pages.map((p, i) => [p.id, { page: p, index: i }]));
    for (const [id, el] of this.shown) {
      const place = byId.get(id);
      if (!place) continue;
      el.style.transform = `translate(${(place.page.x - view.x) * view.scale}px, ${(place.page.y - view.y) * view.scale}px) scale(${view.scale})`;
      el.style.width = `${place.page.width}px`;
      el.style.height = `${place.page.height}px`;
    }
    this.before.hidden = this.beforeId === null || first < 0;
    this.after.hidden = this.afterId === null || first < 0;
    if (this.beforeId !== null) this.before.textContent = t('a11y.back', { number: from });
    if (this.afterId !== null) this.after.textContent = t('a11y.continue', { number: to + 1 });
  }

  /** Asks the worker for the pages wanted that it has not described yet. */
  private ask(): void {
    if (!this.on) return;
    const missing = this.wanted.filter((id) => !this.cache.has(id));
    if (missing.length || this.headingsStale) this.host.request(missing, this.headingsStale);
    else this.build();
  }

  /** The worker's answer to `request`. */
  receive(pages: A11yPage[], headings: A11yHeading[] | undefined): void {
    if (!this.on) return;
    for (const page of pages) this.cache.set(page.id, page);
    if (headings) {
      this.headingsStale = false;
      this.headingList.replaceChildren(
        ...headings.map((heading) => {
          const link = h('a', { text: heading.text, attrs: { href: '#', 'data-paragraph': String(heading.paragraph), 'data-offset': '0' } });
          return h('li', {}, link);
        }),
      );
    }
    this.build();
  }

  /** Shows the wanted pages that are described, in order, and lets go of the others. */
  private build(): void {
    const keep = new Set(this.wanted);
    for (const [id, el] of this.shown) {
      if (!keep.has(id) || !this.cache.has(id)) {
        el.remove();
        this.shown.delete(id);
      }
    }
    let previous: HTMLElement | null = null;
    for (const id of this.wanted) {
      const page = this.cache.get(id);
      if (!page) continue;
      let el = this.shown.get(id);
      if (!el) {
        el = pageElement(page);
        this.shown.set(id, el);
      }
      if (previous ? previous.nextSibling !== el : this.pagesEl.firstChild !== el) {
        if (previous) previous.after(el);
        else this.pagesEl.prepend(el);
      }
      previous = el;
    }
  }
}

/** A page's element: a region named for its number, holding its pieces in reading order. */
export function pageElement(page: A11yPage): HTMLElement {
  const section = h('section', { class: 'wm-reading-page', attrs: { 'aria-label': t('a11y.page', { number: page.number }) } });
  const tables = new Map<number, { el: HTMLElement; rows: Map<number, HTMLElement> }>();
  let list: { el: HTMLElement; ordered: boolean } | null = null;
  for (const node of page.nodes) {
    const piece = nodeElement(node);
    if (node.cell) {
      list = null;
      let table = tables.get(node.cell.table);
      if (!table) {
        table = { el: h('div', { attrs: { role: 'table' } }), rows: new Map() };
        tables.set(node.cell.table, table);
        section.append(table.el);
      }
      let row = table.rows.get(node.cell.row);
      if (!row) {
        row = h('div', { attrs: { role: 'row' } });
        table.rows.set(node.cell.row, row);
        table.el.append(row);
      }
      let cell = row.querySelector<HTMLElement>(`:scope > [data-column="${node.cell.column}"]`);
      if (!cell) {
        cell = h('div', { attrs: { role: node.cell.header ? 'columnheader' : 'cell', 'data-column': String(node.cell.column) } });
        row.append(cell);
      }
      cell.append(piece);
      continue;
    }
    if (node.kind === 'item') {
      if (!list || list.ordered !== !!node.ordered) {
        list = { el: h(node.ordered ? 'ol' : 'ul', {}), ordered: !!node.ordered };
        section.append(list.el);
      }
      list.el.append(piece);
      continue;
    }
    list = null;
    section.append(piece);
  }
  return section;
}

/** One piece: a heading, list item, paragraph or picture, placed over where it is drawn. */
export function nodeElement(node: A11yNode): HTMLElement {
  const tag = node.kind === 'heading' ? `h${Math.min(Math.max(node.level ?? 1, 1), 6)}` : node.kind === 'item' ? 'li' : node.kind === 'picture' ? 'div' : 'p';
  const el = document.createElement(tag);
  el.className = 'wm-reading-piece';
  el.style.left = `${node.x}px`;
  el.style.top = `${node.y}px`;
  el.style.width = `${node.width}px`;
  el.style.height = `${node.height}px`;
  if (node.kind === 'picture') {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', node.parts.map((p) => p.text).join('') || t('a11y.picture'));
    return el;
  }
  el.dataset.paragraph = String(node.paragraph);
  el.dataset.offset = String(node.offset);
  if (node.kind === 'item' && node.level && node.level > 1) el.setAttribute('aria-level', String(node.level));
  for (const part of node.parts) {
    if (part.url) {
      const external = /^(https?|mailto|tel|ftp):/i.test(part.url);
      el.append(h('a', { text: part.text, attrs: { href: part.url, ...(external && { target: '_blank', rel: 'noopener' }) } }));
    } else el.append(part.text);
  }
  return el;
}
