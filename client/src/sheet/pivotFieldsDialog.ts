// The field list (Insert › PivotTable, and a pivot's own menu): each of the source's fields in a row, with where it goes
// (not shown, a filter, rows, columns or values) and, for a value, how it is summed up, or for a filter, the item it shows.
// Fields in the same place go in the order of the list. A dialog: it needs room, as Excel's own pane does.

import type { MessageKey } from '../i18n/index.ts';
import { t } from '../i18n/index.ts';
import { h } from '../ui/dom.ts';
import { choiceButton } from '../ui/dropdown.ts';
import { dialogTitleBar } from '../ui/popup.ts';
import type { PivotChoice, PivotFunction } from './pivot.ts';

type Area = 'none' | 'filter' | 'rows' | 'columns' | 'values';
const AREAS: Area[] = ['none', 'filter', 'rows', 'columns', 'values'];
const FUNCTIONS: PivotFunction[] = ['sum', 'count', 'average', 'max', 'min', 'product', 'countNums', 'stdDev', 'stdDevp', 'var', 'varp'];
const ALL = '\u0000all';

/** Resolves with the fields' places, or null if the dialog was cancelled. */
export function askPivotFields(names: string[], values: string[][], current: PivotChoice | null): Promise<PivotChoice | null> {
  return new Promise((resolve) => {
    const title = t('sheet.pivot.fields');
    const rows = names.map((name, field) => {
      const area: Area = current?.rows.includes(field) ? 'rows' : current?.cols.includes(field) ? 'columns' : current?.values.some((v) => v.field === field) ? 'values' : current?.filters.some((f) => f.field === field) ? 'filter' : 'none';
      const fn = current?.values.find((v) => v.field === field)?.fn ?? 'sum';
      const item = current?.filters.find((f) => f.field === field)?.item ?? null;
      const detail = h('span', { class: 'wm-sheet-pivot-detail' });
      const fnChoice = choiceButton({ label: t('sheet.pivot.summary'), groups: () => [{ values: FUNCTIONS }], name: (v) => t(`sheet.pivot.fn.${v}` as MessageKey), width: 150 }, (v) => fnChoice.set(v));
      fnChoice.set(fn);
      const itemChoice = choiceButton({ label: t('sheet.pivot.item'), groups: () => [{ values: [ALL, ...values[field]] }], name: (v) => (v === ALL ? t('sheet.pivot.all') : v), width: 150 }, (v) => itemChoice.set(v));
      itemChoice.set(item ?? ALL);
      const show = (a: string) => detail.replaceChildren(...(a === 'values' ? [fnChoice.el] : a === 'filter' ? [itemChoice.el] : []));
      const areaChoice = choiceButton({ label: t('sheet.pivot.area'), groups: () => [{ values: AREAS }], name: (v) => t(`sheet.pivot.area.${v}` as MessageKey), width: 130 }, (v) => {
        areaChoice.set(v);
        show(v);
      });
      areaChoice.set(area);
      show(area);
      return { field, row: h('div', { class: 'wm-sheet-pivot-row' }, h('span', { class: 'wm-sheet-pivot-name', text: name }), areaChoice.el, detail), area: areaChoice, fn: fnChoice, item: itemChoice };
    });
    const message = h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });
    const ok = h('button', { class: 'wm-button wm-primary', text: t('sheet.pivot.ok'), attrs: { type: 'submit' } });
    const cancel = h('button', { class: 'wm-button', text: t('sheet.pivot.cancel'), attrs: { type: 'button' } });
    const heads = h('div', { class: 'wm-sheet-pivot-row' }, h('label', { text: t('sheet.pivot.field') }), h('label', { text: t('sheet.pivot.area') }), h('span'));
    const form = h(
      'form',
      { attrs: { method: 'dialog' } },
      h('div', { class: 'wm-dialog-body wm-link-body' }, heads, h('div', { class: 'wm-sheet-pivot-rows' }, ...rows.map((r) => r.row)), message),
      h('div', { class: 'wm-dialog-buttons' }, ok, cancel),
    );
    const dialog = h('dialog', { class: 'wm-dialog wm-sheet-pivot', attrs: { 'aria-label': title } }, dialogTitleBar(title, () => dialog.close()), form);
    let answer: PivotChoice | null = null;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const pick = (a: Area) => rows.filter((r) => r.area.value === a);
      const choice: PivotChoice = {
        rows: pick('rows').map((r) => r.field),
        cols: pick('columns').map((r) => r.field),
        values: pick('values').map((r) => ({ field: r.field, fn: r.fn.value as PivotFunction })),
        filters: pick('filter').map((r) => ({ field: r.field, item: r.item.value === ALL ? null : r.item.value })),
      };
      if (!choice.rows.length || !choice.values.length) {
        message.textContent = t('sheet.pivot.needs');
        return;
      }
      answer = choice;
      dialog.close();
    });
    cancel.addEventListener('click', () => dialog.close());
    // Keys stay in the dialog: the sheet's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(answer);
    });
    document.body.append(dialog);
    dialog.showModal();
    rows[0]?.area.el.focus();
  });
}
