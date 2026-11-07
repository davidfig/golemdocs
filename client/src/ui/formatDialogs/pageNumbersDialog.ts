// Insert › Page Numbers: where on the page the number goes, how it reads and what it starts at.

import { t } from '../../i18n/index.ts';
import type { PageNumbersChoice } from '../actions.ts';
import { formatNumber } from '@golemdocs/docx';
import { h } from '../dom.ts';
import { check, choice, field, numberInput, showForm } from './parts.ts';

const FORMATS = ['decimal', 'lowerLetter', 'upperLetter', 'lowerRoman', 'upperRoman'] as const;

export function showPageNumbersDialog(current: PageNumbersChoice): Promise<PageNumbersChoice | undefined> {
  const position = choice(t('format.pageNumbers.position'), [['bottom', t('format.pageNumbers.bottom')], ['top', t('format.pageNumbers.top')]], current.position ?? 'bottom', () => paint());
  const align = choice(t('format.pageNumbers.alignment'), (['left', 'center', 'right'] as const).map((a) => [a, t(`format.tabs.align.${a}`)] as const), current.align, () => paint());
  const firstPage = check(t('format.pageNumbers.firstPage'), current.firstPage);
  const shown = (format: string) => [1, 2, 3].map((n) => formatNumber(n, format)).join(', ');
  const format = choice(t('format.pageNumbers.format'), FORMATS.map((f) => [f, shown(f)] as const), current.format, () => paint());
  const startAt = check(t('format.pageNumbers.startAt'), current.start !== null);
  const start = numberInput(t('format.pageNumbers.startAt'), String(current.start ?? 1), '1', '0');
  start.disabled = current.start === null;
  startAt.input.addEventListener('change', () => {
    start.disabled = !startAt.input.checked;
    paint();
  });
  start.addEventListener('input', () => paint());

  const number = h('span', { class: 'wm-fd-page-number' });
  const page = h('div', { class: 'wm-fd-page', attrs: { 'aria-hidden': 'true' } }, number);
  const paint = () => {
    number.textContent = formatNumber(startAt.input.checked ? Math.max(Number(start.value) || 1, 1) : 1, format.value);
    number.dataset.position = position.value;
    number.dataset.align = align.value;
  };
  paint();

  let remove: ((answer: PageNumbersChoice) => void) | undefined;
  const removeButton = h('button', { class: 'wm-button', text: t('format.pageNumbers.remove'), attrs: { type: 'button' } });
  removeButton.addEventListener('click', () => remove?.({ ...current, position: null, firstPage: true }));

  return showForm<PageNumbersChoice>(
    {
      title: t('format.pageNumbers.title'),
      className: 'wm-fd-pagenumbers',
      body: [
        h(
          'div',
          { class: 'wm-fd-columns' },
          h('div', { class: 'wm-page-tab' }, field(t('format.pageNumbers.position'), position.el), field(t('format.pageNumbers.alignment'), align.el), field(t('format.pageNumbers.format'), format.el), firstPage.el, h('div', { class: 'wm-page-field' }, startAt.el, start)),
          page,
        ),
      ],
      left: current.position ? [removeButton] : [],
      first: () => position.el,
      read(message) {
        const from = Number(start.value);
        if (startAt.input.checked && !(Number.isInteger(from) && from >= 0 && from <= 32767)) {
          message.textContent = t('format.bad');
          return null;
        }
        return { position: position.value as 'top' | 'bottom', align: align.value as PageNumbersChoice['align'], firstPage: firstPage.input.checked, format: format.value, start: startAt.input.checked ? from : null };
      },
    },
    (finish) => (remove = finish),
  );
}
