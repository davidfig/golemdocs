// Edit › Search All Documents (Ctrl/Cmd+Shift+F): finds words and #tags in every document the person
// has, this browser's copies, the account's and what others shared. Results come from the indexes
// kept for each document (../search/searchLibrary.ts), so typing is answered at once; documents not
// indexed yet are done in the background and the results fill in as they are.

import { t } from '../i18n/index.ts';
import type { IndexProgress, SearchHit, SearchResult, SearchableDocument } from '../search/searchLibrary.ts';
import { h } from './dom.ts';
import { highlightPieces } from '../search/highlight.ts';
import { fileIcon } from './fileIcons.ts';
import { dialogTitleBar } from './popup.ts';
import './searchPanel.css';

export interface SearchPanelHost {
  /** What is searched now (asked each time the panel opens: documents come and go). */
  documents(): Promise<SearchableDocument[]>;
  search(text: string, docs: readonly SearchableDocument[]): Promise<SearchResult>;
  tags(docs: readonly SearchableDocument[]): Promise<{ tag: string; documents: number }[]>;
  /** Makes sure the indexes are up to date; the listener hears how far it has got (null: done). */
  sync(docs: readonly SearchableDocument[]): Promise<void>;
  onProgress(listener: (progress: IndexProgress | null) => void): () => void;
  /** Opens the document of a result at the paragraph that matched, finding `find` there. */
  open(hit: SearchHit, find: string): void;
  focusEditor(): void;
}

/** How long after typing a search is made. */
const TYPING_DELAY_MS = 120;
const MAX_SHOWN = 60;
const MAX_TAGS = 60;

export class SearchPanel {
  private dialog: HTMLDialogElement | null = null;
  private runQuery: ((text: string) => void) | null = null;

  constructor(private readonly host: SearchPanelHost) {}

  /** Opens the panel (or, if open, puts `query` in it). */
  show(query = ''): void {
    if (this.dialog?.open) {
      this.runQuery?.(query);
      return;
    }
    const { host } = this;
    const input = h('input', { class: 'wm-search-input', attrs: { type: 'text', placeholder: t('panels.search.placeholder'), 'aria-label': t('panels.search.placeholder'), autocomplete: 'off', spellcheck: 'false' } });
    const status = h('div', { class: 'wm-search-status', attrs: { role: 'status', 'aria-live': 'polite' } });
    const list = h('div', { class: 'wm-search-list', attrs: { role: 'listbox' } });
    const dialog = h('dialog', { class: 'wm-dialog wm-search' });
    dialog.append(dialogTitleBar(t('panels.search.title'), () => dialog.close()), h('div', { class: 'wm-search-body' }, input, status, list));
    this.dialog = dialog;

    let docs: SearchableDocument[] = [];
    let ready = false;
    let progress: IndexProgress | null = null;
    let result: SearchResult | null = null;
    let rows: { el: HTMLElement; hit: SearchHit }[] = [];
    let active = -1;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const setActive = (index: number) => {
      active = rows.length ? (index + rows.length) % rows.length : -1;
      rows.forEach((row, i) => row.el.classList.toggle('active', i === active));
      rows[active]?.el.scrollIntoView({ block: 'nearest' });
    };
    const useTag = (tag: string) => {
      input.value = `#${tag}`;
      input.focus();
      void run();
    };
    const open = (hit: SearchHit) => {
      const query = result?.query;
      // What to find in the document: the first tag, else the first match as the document spells it (accents and case as written).
      const spelled = highlightPieces(hit.text ?? '', query?.words ?? []).find((p) => p.kind === 'match')?.text;
      const find = query?.tags[0] ? `#${query.tags[0]}` : (spelled ?? query?.words[0] ?? '');
      dialog.close();
      host.open(hit, find);
    };
    const snippet = (hit: SearchHit): HTMLElement => {
      const el = h('div', { class: 'wm-search-snippet' });
      for (const piece of highlightPieces(hit.text ?? '', result?.query.words ?? [])) {
        if (piece.kind === 'match') el.append(h('mark', { text: piece.text }));
        else if (piece.kind === 'tag') {
          const tag = h('span', { class: 'wm-search-tag', text: piece.text, attrs: { role: 'button', tabindex: '-1' } });
          tag.addEventListener('click', (e) => {
            e.stopPropagation();
            useTag(piece.text.slice(1));
          });
          el.append(tag);
        } else el.append(piece.text);
      }
      return el;
    };
    const row = (hit: SearchHit): HTMLElement => {
      const meta = hit.place ? t('panels.dashboard.from', { name: hit.place }) : '';
      const el = h(
        'div',
        { class: 'wm-option wm-search-row', attrs: { role: 'option', 'aria-label': t('panels.dashboard.open', { name: hit.name }) } },
        h('div', { class: 'wm-search-name' }, fileIcon(hit.name), h('span', { class: 'wm-search-title', text: hit.name }), meta ? h('span', { class: 'wm-search-meta', text: meta }) : null),
        hit.text ? snippet(hit) : null,
      );
      el.addEventListener('mousemove', () => setActive(rows.findIndex((r) => r.el === el)));
      el.addEventListener('click', () => open(hit));
      return el;
    };
    const render = async () => {
      const mine = ++generation;
      const text = input.value.trim();
      list.replaceChildren();
      rows = [];
      if (!ready) {
        status.textContent = t('panels.search.preparing');
        return;
      }
      if (!text) {
        result = null;
        const tags = (await host.tags(docs)).slice(0, MAX_TAGS);
        if (mine !== generation) return;
        status.textContent = progress ? t('panels.search.indexing', { done: progress.done, total: progress.total }) : '';
        if (!tags.length) {
          list.append(h('div', { class: 'wm-search-empty', text: t('panels.search.hint') }));
          return;
        }
        const chips = h('div', { class: 'wm-search-tags' });
        for (const { tag, documents } of tags) {
          const chip = h('button', { class: 'wm-search-chip', attrs: { type: 'button', title: t('panels.search.tagDocuments', { count: documents }) } }, h('span', { text: `#${tag}` }), h('span', { class: 'wm-search-count', text: String(documents) }));
          chip.addEventListener('click', () => useTag(tag));
          chips.append(chip);
        }
        list.append(h('div', { class: 'wm-list-heading', text: t('panels.search.tags') }), chips);
        return;
      }
      const found = await host.search(text, docs);
      if (mine !== generation) return;
      result = found;
      const shown = found.hits.slice(0, MAX_SHOWN);
      for (const hit of shown) {
        const el = row(hit);
        rows.push({ el, hit });
        list.append(el);
      }
      if (!shown.length) list.append(h('div', { class: 'wm-search-empty', text: t('panels.search.none') }));
      status.textContent = progress
        ? t('panels.search.indexing', { done: progress.done, total: progress.total })
        : found.pending
          ? t('panels.search.pending', { count: found.pending })
          : found.hits.length
            ? t('panels.search.found', { count: found.hits.length })
            : '';
      setActive(rows.length ? 0 : -1);
    };
    const run = async () => {
      window.clearTimeout(timer);
      await render();
    };
    this.runQuery = (text) => {
      if (text) input.value = text;
      input.focus();
      input.select();
      void run();
    };

    input.addEventListener('input', () => {
      window.clearTimeout(timer);
      timer = setTimeout(() => void render(), TYPING_DELAY_MS);
    });
    // Keys stay in the panel: the document's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowDown') setActive(active + 1);
      else if (e.key === 'ArrowUp') setActive(active - 1);
      else if (e.key === 'Enter' && rows[active]) open(rows[active].hit);
      else return;
      e.preventDefault();
    });
    // Updates while indexing: each document done may add a result (kept calm: one render per animation frame at most).
    let queued = false;
    const stop = host.onProgress((p) => {
      progress = p;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (dialog.open) void render();
      });
    });
    dialog.addEventListener('close', () => {
      stop();
      window.clearTimeout(timer);
      generation++;
      dialog.remove();
      this.dialog = null;
      this.runQuery = null;
      host.focusEditor();
    });

    document.body.append(dialog);
    dialog.showModal();
    input.value = query;
    input.focus();
    input.select();
    void (async () => {
      await render();
      docs = await host.documents();
      ready = true;
      await render();
      // Documents with no index yet are done now, and the results fill in as they are.
      await host.sync(docs);
      if (dialog.open) await render();
    })();
  }
}
