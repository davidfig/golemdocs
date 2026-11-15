// Tools › Afterward › Reverse Outline: what each paragraph does for the reader, as written (docs/afterward.md). A description,
// not a plan: it is shown beside the piece, never put in it. Each line goes to its paragraph.

import { t } from '../i18n/index.ts';
import { h } from '../ui/dom.ts';
import { showDialog } from '../ui/popup.ts';
import type { Outline } from './prompts.ts';
import type { Piece } from './text.ts';

/** Shows the outline; `go` puts the caret at the start of a paragraph (its index among the document's). */
export function showOutline(piece: Piece, outline: Outline, go: (index: number) => void): void {
  const does = new Map(outline.paragraphs.map((p) => [p.paragraph, p.does]));
  const list = h('ol', { class: 'wm-afterward-outline', attrs: { 'aria-label': t('afterward.outline.title') } });
  for (const block of piece.blocks) {
    if ('heading' in block) {
      list.append(h('li', { class: 'wm-afterward-outline-heading', text: block.heading }));
      continue;
    }
    const button = h('button', { class: 'wm-afterward-outline-line', attrs: { type: 'button', title: t('afterward.outline.go') } }, h('span', { class: 'wm-afterward-outline-n', text: `¶${block.n}` }), h('span', { text: does.get(block.n) ?? '' }));
    if (block.n === outline.point) button.append(h('span', { class: 'wm-comment-badge', text: t('afterward.outline.point') }));
    button.addEventListener('click', () => {
      button.closest('dialog')?.close();
      go(block.index);
    });
    list.append(h('li', {}, button));
  }
  const body = h('div', { class: 'wm-afterward-outline-body' }, list);
  if (!outline.point) body.append(h('p', { class: 'wm-hint', text: t('afterward.outline.noPoint') }));
  if (outline.observations.length) body.append(h('p', { class: 'wm-afterward-notices', text: t('afterward.outline.notices') }), h('ul', { class: 'wm-afterward-outline-notes' }, ...outline.observations.map((o) => h('li', { text: o }))));
  body.append(h('p', { class: 'wm-hint', text: t('afterward.outline.hint') }));
  showDialog(t('afterward.outline.title'), body);
}
