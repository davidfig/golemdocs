// Select Data: a chart's series (each a name, typed or `=` a reference to its cell, and the values' reference) and its
// categories, in a dialog (it needs room, as Excel's does). Series can be added and taken away; OK gives the list back.

import { t } from '../i18n/index.ts';
import { CLOSE_ICON, h, iconButton } from '../ui/dom.ts';
import { dialogTitleBar } from '../ui/popup.ts';
import type { ChartData } from './protocol.ts';

/** Resolves with the data as edited, or null if the dialog was cancelled. */
export function askChartData(data: ChartData): Promise<ChartData | null> {
  return new Promise((resolve) => {
    const title = t('sheet.chart.data');
    const field = (label: string, value: string) => h('input', { class: 'wm-input', attrs: { type: 'text', 'aria-label': label, autocomplete: 'off', spellcheck: 'false', value } });
    const rows = h('div', { class: 'wm-sheet-data-rows' });
    const addRow = (s: { name: string; values: string }) => {
      const name = field(t('sheet.chart.seriesName'), s.name);
      const values = field(t('sheet.chart.seriesValues'), s.values);
      const remove = iconButton('wm-dialog-close', CLOSE_ICON, t('sheet.chart.removeSeries'));
      const row = h('div', { class: 'wm-sheet-data-row' }, name, values, remove);
      remove.addEventListener('click', () => {
        if (rows.children.length > 1) row.remove();
      });
      rows.append(row);
      return name;
    };
    for (const s of data.series) addRow(s);
    const categories = field(t('sheet.chart.categories'), data.categories);
    const add = h('button', { class: 'wm-button', text: t('sheet.chart.addSeries'), attrs: { type: 'button' } });
    const ok = h('button', { class: 'wm-button wm-primary', text: t('sheet.chart.ok'), attrs: { type: 'submit' } });
    const cancel = h('button', { class: 'wm-button', text: t('sheet.chart.cancel'), attrs: { type: 'button' } });
    const heads = h('div', { class: 'wm-sheet-data-row' }, h('label', { text: t('sheet.chart.seriesName') }), h('label', { text: t('sheet.chart.seriesValues') }), h('span'));
    const form = h(
      'form',
      { attrs: { method: 'dialog' } },
      h('div', { class: 'wm-dialog-body wm-link-body' }, heads, rows, h('div', {}, add), h('label', { text: t('sheet.chart.categories') }), categories),
      h('div', { class: 'wm-dialog-buttons' }, ok, cancel),
    );
    const dialog = h('dialog', { class: 'wm-dialog wm-sheet-data', attrs: { 'aria-label': title } }, dialogTitleBar(title, () => dialog.close()), form);
    let answer: ChartData | null = null;
    add.addEventListener('click', () => addRow({ name: '', values: '' }).focus());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const series = [...rows.children].map((row) => {
        const [name, values] = row.querySelectorAll('input');
        return { name: name.value, values: values.value };
      });
      answer = { series: series.filter((s) => s.values.trim()), categories: categories.value };
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
    rows.querySelector('input')?.focus();
  });
}
