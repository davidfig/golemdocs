// Insert ▸ Table: how many columns and rows. A modal dialog like the others; the editor makes the
// table (see @golemdocs/editor).

import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import { dialogTitleBar } from './popup.ts';

/** The most a table may have (Word's own limit for columns; rows are only capped to keep the editor responsive). */
export const MAX_COLUMNS = 63;
export const MAX_ROWS = 500;

export interface TableSize {
  rows: number;
  columns: number;
}

/** Asks for a new table's size: resolves with it, or `undefined` on Cancel. */
export const showTableDialog = (initial: TableSize = { rows: 2, columns: 5 }): Promise<TableSize | undefined> => askSize(t('table.title'), initial);

/** Asks how many columns and rows to split the cell into. */
export const showSplitDialog = (): Promise<TableSize | undefined> => askSize(t('table.splitTitle'), { rows: 1, columns: 2 });

function askSize(title: string, initial: TableSize): Promise<TableSize | undefined> {
  return new Promise((resolve) => {
    const number = (label: string, value: number, max: number) => {
      const el = h('input', { class: 'wm-input', attrs: { type: 'number', min: '1', max: String(max), step: '1', 'aria-label': label } });
      el.value = String(value);
      return el;
    };
    const columns = number(t('table.columnsLabel'), initial.columns, MAX_COLUMNS);
    const rows = number(t('table.rowsLabel'), initial.rows, MAX_ROWS);
    const message = h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });
    const ok = h('button', { class: 'wm-button', text: t('table.ok'), attrs: { type: 'submit' } });
    const cancel = h('button', { class: 'wm-button', text: t('table.cancel'), attrs: { type: 'button' } });
    const form = h(
      'form',
      { attrs: { method: 'dialog' } },
      h('div', { class: 'wm-dialog-body wm-link-body' }, h('label', { text: t('table.columns') }), columns, h('label', { text: t('table.rows') }), rows, message),
      h('div', { class: 'wm-dialog-buttons' }, h('span', { class: 'wm-link-actions' }, ok, cancel)),
    );
    const dialog = h('dialog', { class: 'wm-dialog wm-link wm-table', attrs: { 'aria-label': title } }, dialogTitleBar(title, () => dialog.close()), form);

    let result: TableSize | undefined;
    // Keys stay in the dialog: the document's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const size = { rows: Number(rows.value), columns: Number(columns.value) };
      const whole = (n: number, max: number) => Number.isInteger(n) && n >= 1 && n <= max;
      if (!whole(size.rows, MAX_ROWS) || !whole(size.columns, MAX_COLUMNS)) {
        message.textContent = t('table.badSize', { maxRows: MAX_ROWS, maxColumns: MAX_COLUMNS });
        return;
      }
      result = size;
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    columns.select();
  });
}
