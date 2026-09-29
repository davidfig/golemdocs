// Format ▸ Columns: how many columns of text, how far apart, a line between them, and where it
// applies. A modal dialog like the others; the editor sets them (see @word/editor setColumns).

import { t } from '../i18n/index.ts';
import { h } from './dom.ts';

const MAX_COLUMNS = 12;
const MAX_SPACE_INCHES = 4;
/** The narrowest a column may be, twips (half an inch). */
const MIN_WIDTH = 720;

export interface ColumnsState {
  count: number;
  /** Twips between columns. */
  space: number;
  sep: boolean;
  /** Twips between the margins, for the width of each column. */
  width: number;
}

export interface ColumnsChoice {
  count: number;
  space: number;
  sep: boolean;
  scope: 'document' | 'section' | 'forward';
}

const inches = (twips: number): string => String(Math.round((twips / 1440) * 100) / 100);

/** Asks for columns: resolves with the choice, or `undefined` on Cancel. */
export function showColumnsDialog(current: ColumnsState): Promise<ColumnsChoice | undefined> {
  return new Promise((resolve) => {
    const count = h('input', { class: 'wm-input', attrs: { type: 'number', min: '1', max: String(MAX_COLUMNS), step: '1', 'aria-label': t('columns.numberLabel') } });
    count.value = String(current.count);
    const space = h('input', { class: 'wm-input', attrs: { type: 'number', min: '0', max: String(MAX_SPACE_INCHES), step: '0.05', 'aria-label': t('columns.spacingLabel') } });
    space.value = inches(current.space);
    const line = h('input', { attrs: { type: 'checkbox' } });
    line.checked = current.sep;
    const scope = h('select', { class: 'wm-input', attrs: { 'aria-label': t('columns.apply') } });
    for (const [value, label] of [
      ['section', t('columns.applySection')],
      ['document', t('columns.applyDocument')],
      ['forward', t('columns.applyForward')],
    ] as const) {
      const option = h('option', { text: label });
      option.value = value;
      scope.append(option);
    }
    const width = h('div', { class: 'wm-columns-width' });
    const message = h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });

    /** The width of each column, twips, for what is in the fields (NaN if they aren't numbers). */
    const columnWidth = (): number => {
      const n = Number(count.value);
      return (current.width - Number(space.value) * 1440 * (n - 1)) / n;
    };
    const showWidth = () => {
      const w = columnWidth();
      width.textContent = Number.isFinite(w) && w > 0 ? t('columns.width') + ' ' + t('columns.inches', { value: inches(w) }) : '';
    };
    count.addEventListener('input', showWidth);
    space.addEventListener('input', showWidth);
    showWidth();

    const preset = (label: string, n: number) => {
      const button = h('button', { class: 'wm-button', text: label, attrs: { type: 'button' } });
      button.addEventListener('click', () => {
        count.value = String(n);
        showWidth();
      });
      return button;
    };

    const ok = h('button', { class: 'wm-button', text: t('columns.ok'), attrs: { type: 'submit' } });
    const cancel = h('button', { class: 'wm-button', text: t('columns.cancel'), attrs: { type: 'button' } });
    const close = h('button', { class: 'wm-dialog-close', text: '×', attrs: { type: 'button', 'aria-label': t('columns.close') } });
    const form = h(
      'form',
      { attrs: { method: 'dialog' } },
      h(
        'div',
        { class: 'wm-dialog-body wm-link-body' },
        h('label', { text: t('columns.presets') }),
        h('div', { class: 'wm-columns-presets' }, preset(t('columns.one'), 1), preset(t('columns.two'), 2), preset(t('columns.three'), 3)),
        h('label', { text: t('columns.number') }),
        count,
        h('label', { text: t('columns.spacing') }),
        space,
        width,
        h('label', { class: 'wm-find-case' }, line, t('columns.line')),
        h('label', { text: t('columns.apply') }),
        scope,
        message,
      ),
      h('div', { class: 'wm-dialog-buttons' }, h('span', { class: 'wm-link-actions' }, ok, cancel)),
    );
    const dialog = h('dialog', { class: 'wm-dialog wm-link wm-columns', attrs: { 'aria-label': t('columns.title') } }, h('div', { class: 'wm-dialog-title' }, h('span', { text: t('columns.title') }), close), form);

    let result: ColumnsChoice | undefined;
    // Keys stay in the dialog: the document's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    close.addEventListener('click', () => dialog.close());
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const n = Number(count.value);
      const gap = Number(space.value);
      if (!Number.isInteger(n) || n < 1 || n > MAX_COLUMNS || !(gap >= 0 && gap <= MAX_SPACE_INCHES)) {
        message.textContent = t('columns.bad', { max: MAX_COLUMNS });
        return;
      }
      if (columnWidth() < MIN_WIDTH) {
        message.textContent = t('columns.tooNarrow');
        return;
      }
      result = { count: n, space: Math.round(gap * 1440), sep: line.checked, scope: scope.value as ColumnsChoice['scope'] };
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    count.select();
  });
}
