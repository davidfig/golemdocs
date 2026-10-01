// The status bar (View › Status Bar): a strip under the document with facts about it. Which facts depend on
// the kind of document: a text document gets its page and word count, a PDF its page, a picture its size in
// pixels. `footerSegments` decides what to say (pure, so it is tested); `Footer` draws it.

import { getLocale, t, type MessageKey } from '../i18n/index.ts';
import type { WordStats } from '../layout/protocol.ts';
import { h } from './dom.ts';
import type { DocumentKind } from './actions.ts';
import { PICTURE_KINDS } from './formats.ts';

export interface FooterInfo {
  kind: DocumentKind;
  /** The page in view (from 1) and how many there are; null when the document is not shown as pages. */
  page: { current: number; count: number } | null;
  /** 1 = 100%. */
  zoom: number;
  /** The counts of the whole document, and of the selection (null with no selection); null when the document has none. */
  words: WordStats | null;
  selection: WordStats | null;
  /** The pixel size of an open picture, once known. */
  picture: { width: number; height: number } | null;
}

export interface FooterSegment {
  key: MessageKey;
  /** Numbers here are shown in the language's own digits and grouping. */
  params?: Record<string, number>;
}

/** What the status bar says about a document, left to right. */
export function footerSegments(info: FooterInfo): FooterSegment[] {
  const out: FooterSegment[] = [];
  if (PICTURE_KINDS.includes(info.kind)) {
    if (info.picture) out.push({ key: 'panels.footer.pixels', params: info.picture });
  } else {
    const table = info.words?.table;
    if (table) out.push({ key: 'panels.footer.table', params: { rows: table.rows, columns: table.columns } });
    if (info.page) out.push({ key: 'panels.footer.page', params: info.page });
    // A PDF shown as pages has no text counts; neither does a document before the first count arrives.
    // A spreadsheet's size says more than its word count.
    const total = table ? null : info.words;
    if (total) {
      const chosen = info.selection;
      if (chosen && chosen.words > 0) out.push({ key: 'panels.footer.selection', params: { count: total.words, selected: chosen.words } });
      else out.push({ key: 'panels.footer.words', params: { count: total.words } });
    }
  }
  out.push({ key: 'panels.footer.zoom', params: { percent: Math.round(info.zoom * 100) } });
  return out;
}

export class Footer {
  readonly el: HTMLElement;
  private shown = '';

  constructor(el: HTMLElement) {
    this.el = el;
    el.setAttribute('role', 'status');
  }

  setVisible(visible: boolean): void {
    this.el.hidden = !visible;
  }

  /** Shows the segments (nothing is touched when they have not changed). */
  update(info: FooterInfo): void {
    const numbers = new Intl.NumberFormat(getLocale());
    const texts = footerSegments(info).map(({ key, params }) => {
      const shown: Record<string, string | number> = {};
      for (const [name, value] of Object.entries(params ?? {})) shown[name] = numbers.format(value);
      // The plural category comes from the number itself, the text from its formatted copy.
      if (params && 'count' in params) shown.count = params.count;
      return t(key, { ...shown, n: numbers.format(params?.count ?? 0) });
    });
    const text = texts.join('\n');
    if (text === this.shown) return;
    this.shown = text;
    this.el.replaceChildren(...texts.map((s) => h('span', { class: 'wm-footer-item', text: s })));
  }
}
