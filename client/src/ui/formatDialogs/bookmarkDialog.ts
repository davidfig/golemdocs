// Insert › Bookmark: names for places in the document. Add one over the selection, go to one, delete one.

import { validBookmarkName } from '@golemdocs/docx';
import { t } from '../../i18n/index.ts';
import type { DocumentInfo } from '../actions.ts';
import { h, segmented } from '../dom.ts';
import { listBox } from '../listBox.ts';
import { dialogTitleBar } from '../popup.ts';
import './formatDialogs.css';

export interface BookmarkHost {
  add(name: string): void;
  remove(name: string): void;
  goTo(name: string): void;
}

export function showBookmarkDialog(bookmarks: DocumentInfo['bookmarks'], host: BookmarkHost): Promise<void> {
  return new Promise((resolve) => {
    const known = [...bookmarks];
    let byName = true;
    const shown = () => (byName ? [...known].sort((a, b) => a.name.localeCompare(b.name)) : known);
    const name = h('input', { class: 'wm-input', attrs: { type: 'text', maxlength: '40', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('format.bookmark.name') } });
    const message = h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });
    const add = h('button', { class: 'wm-button', text: t('format.bookmark.add'), attrs: { type: 'submit' } });
    const remove = h('button', { class: 'wm-button', text: t('format.bookmark.delete'), attrs: { type: 'button' } });
    const goTo = h('button', { class: 'wm-button', text: t('format.bookmark.goTo'), attrs: { type: 'button' } });
    const close = h('button', { class: 'wm-button', text: t('format.bookmark.close'), attrs: { type: 'button' } });
    const about = h('p', { class: 'wm-hint wm-fd-bookmark-text' });
    const list = listBox(t('format.bookmark.list'), {
      rows: 7,
      onPick: (value) => choose(value),
      onChoose: (value) => go(value),
    });
    const choose = (value: string) => {
      name.value = value;
      about.textContent = shown().find((b) => b.name === value)?.text ?? '';
      message.textContent = '';
    };
    const paint = (pick?: string) => {
      const rows = shown();
      list.set(rows.length ? rows.map((b) => b.name) : [{ note: t('format.bookmark.empty') }]);
      const at = pick ? rows.findIndex((b) => b.name === pick) : -1;
      if (at >= 0) list.pick(at);
      const has = rows.some((b) => b.name === (at >= 0 ? pick : list.value));
      remove.disabled = goTo.disabled = !has;
      about.textContent = has ? (rows.find((b) => b.name === list.value)?.text ?? '') : '';
    };
    const sort = segmented<'name' | 'location'>(
      t('format.bookmark.sort'),
      [
        { value: 'name', text: t('format.bookmark.sortName') },
        { value: 'location', text: t('format.bookmark.sortLocation') },
      ],
      (value) => {
        byName = value === 'name';
        sort.set(value);
        paint(list.value || undefined);
      },
    );
    sort.set('name');
    const go = (value: string) => {
      if (!known.some((b) => b.name === value)) return;
      host.goTo(value);
      dialog.close();
    };
    goTo.addEventListener('click', () => go(list.value));
    remove.addEventListener('click', () => {
      const value = list.value;
      const at = known.findIndex((b) => b.name === value);
      if (at < 0) return;
      known.splice(at, 1);
      host.remove(value);
      name.value = '';
      paint();
      name.focus();
    });
    close.addEventListener('click', () => dialog.close());
    const form = h(
      'form',
      { attrs: { method: 'dialog', novalidate: '' } },
      h(
        'div',
        { class: 'wm-dialog-body wm-find-body' },
        h('div', { class: 'wm-find-fields' }, h('label', { text: t('format.bookmark.name') }), name, list.el, about, h('div', { class: 'wm-fd-row' }, h('span', { text: t('format.bookmark.sort') }), sort.el), message),
        h('div', { class: 'wm-find-buttons' }, add, remove, goTo, close),
      ),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = name.value.trim();
      if (!validBookmarkName(value)) {
        message.textContent = t('format.bookmark.bad');
        return;
      }
      host.add(value);
      dialog.close();
    });
    const dialog = h('dialog', { class: 'wm-dialog wm-fd wm-fd-bookmark', attrs: { 'aria-label': t('format.bookmark.title') } }, dialogTitleBar(t('format.bookmark.title'), () => dialog.close()), form);
    // Keys stay in the dialog: the document's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve();
    });
    paint();
    document.body.append(dialog);
    dialog.showModal();
    name.focus();
  });
}
