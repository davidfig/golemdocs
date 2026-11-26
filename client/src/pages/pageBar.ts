// The bar over an HTML page (docs/html-pages.md §2): the file's name, a slot for what more the view says (where a page came from, its
// buttons), and the Page / Source switch. One bar for both views, so they look and work the same: page view (view.ts, in the lazy
// chunk) puts it over the frame, and HTML Source puts it over the text editor (`TextView.setHeader`).

import { t } from '../i18n/index.ts';
import { h, segmented } from '../ui/dom.ts';
import './pageBar.css';

export type PageBarView = 'page' | 'source';

export interface PageBar {
  el: HTMLElement;
  title: HTMLElement;
  /** What the view adds after the name (where the page came from), and before the switch (its buttons). */
  extras: HTMLElement;
  actions: HTMLElement;
  /** The Page / Source switch (hidden where there is nothing to switch to: a page shared with someone). */
  switch: HTMLElement;
  setName(name: string): void;
  setView(view: PageBarView): void;
}

export function pageBar(onView: (view: PageBarView) => void): PageBar {
  const title = h('span', { class: 'wm-page-title' });
  const extras = h('span', { class: 'wm-page-extras' });
  const actions = h('span', { class: 'wm-page-extras' });
  const views = segmented<PageBarView>(
    t('pages.view.label'),
    [
      { value: 'page', text: t('pages.view.page') },
      { value: 'source', text: t('pages.view.source') },
    ],
    onView,
  );
  const el = h('div', { class: 'wm-page-bar', attrs: { role: 'toolbar', 'aria-label': t('pages.bar') } }, title, extras, h('span', { class: 'wm-page-spacer' }), actions, views.el);
  return {
    el,
    title,
    extras,
    actions,
    switch: views.el,
    setName: (name) => void (title.textContent = name),
    setView: (view) => views.set(view),
  };
}
