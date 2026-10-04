// The status bar (View › Status Bar): a strip under the document with facts about it. Which facts depend on
// the kind of document: a text document gets its page and word count, a PDF its page, a picture its size in
// pixels. `footerSegments` decides what to say (pure, so it is tested); `Footer` draws it. At its right end are
// the three views (Print Layout, Flow, Page Grid), the one in use pressed; a click switches to another. The page,
// the word count and the zoom are buttons too: Go To, Word Count and the list of zoom sizes.

import { getLocale, t, type MessageKey } from '../i18n/index.ts';
import type { WordStats } from '../layout/protocol.ts';
import { h, setAttr, stripMnemonic } from './dom.ts';
import type { DocumentKind, ViewMode } from './actions.ts';
import { PICTURE_KINDS, VECTOR_KINDS } from './formats.ts';

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
  view: ViewMode;
  /** Flow can be chosen (not for a PDF's own pages or a picture). */
  canFlow: boolean;
  /** A plain text file in the text editor: what to say about it (already in the language), and whether long lines wrap. */
  text: { summary: string; position: string; progress: string; wrap: boolean } | null;
}

// Drawn in the bar's text color, on a 16-unit grid.
const VIEW_ICONS: Record<ViewMode, string> = {
  print: '<rect x="3.5" y="1.5" width="9" height="13" rx="1"/><path d="M5.8 5h4.4M5.8 7.5h4.4M5.8 10h3"/>',
  flow: '<path d="M1.5 3.5h13M1.5 6.5h13M1.5 9.5h13M1.5 12.5h8"/>',
  grid: '<rect x="1.5" y="1.5" width="5.5" height="5.5" rx=".8"/><rect x="9" y="1.5" width="5.5" height="5.5" rx=".8"/><rect x="1.5" y="9" width="5.5" height="5.5" rx=".8"/><rect x="9" y="9" width="5.5" height="5.5" rx=".8"/>',
};
/** What the status bar's clickable parts do. */
export interface FooterActions {
  view(view: ViewMode): void;
  goTo(): void;
  wordCount(): void;
  zoom(anchor: HTMLElement): void;
  canvasSize(): void;
  /** Wrap long lines or not (a plain text file). */
  wrap(): void;
  /** The tooltip of a clickable segment. */
  label(action: FooterAction): string;
}

type FooterAction = 'goTo' | 'wordCount' | 'zoom' | 'canvasSize';

const SEGMENT_ACTIONS: Partial<Record<MessageKey, FooterAction>> = {
  'panels.footer.page': 'goTo',
  'panels.footer.words': 'wordCount',
  'panels.footer.selection': 'wordCount',
  'panels.footer.zoom': 'zoom',
};
/** A drawing's size opens Canvas Size; a picture's is only a fact. */
const DRAWING_SEGMENT_ACTIONS: Partial<Record<MessageKey, FooterAction>> = { 'panels.footer.pixels': 'canvasSize' };

const VIEW_LABELS = { print: 'chrome.view.print', flow: 'chrome.view.flow', grid: 'chrome.view.grid' } as const satisfies Record<ViewMode, MessageKey>;

export interface FooterSegment {
  key: MessageKey | null;
  /** Said as it is (the text editor's own wording). */
  text?: string;
  /** Numbers here are shown in the language's own digits and grouping. */
  params?: Record<string, number>;
}

/** What the status bar says about a document, left to right. */
export function footerSegments(info: FooterInfo): FooterSegment[] {
  const out: FooterSegment[] = [];
  if (info.text) {
    for (const text of [info.text.summary, info.text.position, info.text.progress]) if (text) out.push({ key: null, text });
  } else if (PICTURE_KINDS.includes(info.kind) || VECTOR_KINDS.includes(info.kind)) {
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
  private readonly items = h('div', { class: 'wm-footer-items', attrs: { role: 'status' } });
  private readonly views = new Map<ViewMode, HTMLButtonElement>();
  private readonly group: HTMLElement;
  private readonly wrap: HTMLButtonElement;
  private readonly actions: FooterActions;
  private shown = '';

  constructor(el: HTMLElement, actions: FooterActions) {
    this.el = el;
    this.actions = actions;
    const group = h('div', { class: 'wm-footer-views', attrs: { role: 'group', 'aria-label': t('panels.footer.views') } });
    for (const view of ['print', 'flow', 'grid'] as const) {
      const label = stripMnemonic(t(VIEW_LABELS[view]));
      const button = h('button', { class: 'wm-footer-view', attrs: { type: 'button', title: label, 'aria-label': label, 'aria-pressed': 'false', 'data-view': view } });
      button.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${VIEW_ICONS[view]}</svg>`;
      // The editor keeps the focus (and its caret).
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', () => actions.view(view));
      this.views.set(view, button);
      group.append(button);
    }
    this.group = group;
    const wrapLabel = `${t('textEditor.wrap')} (Alt+Z)`;
    this.wrap = h('button', { class: 'wm-footer-view', attrs: { type: 'button', title: wrapLabel, 'aria-label': t('textEditor.wrap'), 'aria-pressed': 'false' } });
    this.wrap.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 3.5h13M1.5 7.5h10a2.5 2.5 0 0 1 0 5H8M9.7 10.5 7.7 12.5l2 2M1.5 11.5h3"/></svg>';
    this.wrap.addEventListener('mousedown', (e) => e.preventDefault());
    this.wrap.addEventListener('click', () => actions.wrap());
    el.replaceChildren(this.items, group, this.wrap);
    // What floats over the bottom of the window (Clip, the assistant) is lifted by the bar's height: 0 while it is hidden.
    new ResizeObserver(() => document.documentElement.style.setProperty('--wm-footer-height', `${el.offsetHeight}px`)).observe(el);
  }

  setVisible(visible: boolean): void {
    this.el.hidden = !visible;
  }

  /** Shows the segments (nothing is touched when they have not changed). */
  update(info: FooterInfo): void {
    const numbers = new Intl.NumberFormat(getLocale());
    const segments = footerSegments(info).map(({ key, params, text: literal }) => {
      if (key === null) return { text: literal ?? '', action: undefined };
      const shown: Record<string, string | number> = {};
      for (const [name, value] of Object.entries(params ?? {})) shown[name] = numbers.format(value);
      // The plural category comes from the number itself, the text from its formatted copy.
      if (params && 'count' in params) shown.count = params.count;
      return { text: t(key, { ...shown, n: numbers.format(params?.count ?? 0) }), action: (VECTOR_KINDS.includes(info.kind) ? DRAWING_SEGMENT_ACTIONS[key] : undefined) ?? SEGMENT_ACTIONS[key] };
    });
    this.group.hidden = info.text !== null;
    this.wrap.hidden = info.text === null;
    if (info.text) setAttr(this.wrap, 'aria-pressed', String(info.text.wrap));
    for (const [view, button] of this.views) {
      setAttr(button, 'aria-pressed', String(view === info.view));
      const disabled = view === 'flow' && !info.canFlow;
      if (button.disabled !== disabled) button.disabled = disabled;
    }
    const text = segments.map((s) => `${s.action ?? ''}:${s.text}`).join('\n');
    if (text === this.shown) return;
    this.shown = text;
    this.items.replaceChildren(...segments.map((s) => this.segment(s.text, s.action)));
  }

  private segment(text: string, action: FooterAction | undefined): HTMLElement {
    if (!action) return h('span', { class: 'wm-footer-item', text });
    const button = h('button', { class: 'wm-footer-item wm-footer-link', text, attrs: { type: 'button', title: this.actions.label(action) } });
    if (action === 'zoom') {
      // The editor keeps the focus while the list is open (it gets it back once a size is chosen).
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', () => this.actions.zoom(button));
    } else {
      button.addEventListener('click', () => this.actions[action]());
    }
    return button;
  }
}
