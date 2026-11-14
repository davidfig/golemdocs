// Format ▸ Paragraph: alignment, indents, spacing and the line and page break options of the
// selected paragraphs. A modal dialog with two tabs like Page Setup. A field is blank when the
// paragraphs differ, and a blank field is left as it is. Lengths are in inches (centimetres in
// every language but English); spacing before and after and exact line heights are in points.

import { getLocale, t } from '../i18n/index.ts';
import type { Alignment, ParagraphChoice } from './actions.ts';
import { h, tabList } from './dom.ts';
import { choiceButton } from './dropdown.ts';
import { dialogTitleBar } from './popup.ts';

type LineKind = '' | 'single' | 'oneHalf' | 'double' | 'atLeast' | 'exactly' | 'multiple';

const metric = (): boolean => getLocale() !== 'en';
const perUnit = (): number => (metric() ? 1440 / 2.54 : 1440);
const round = (n: number): string => String(Math.round(n * 100) / 100);

/** The line spacing kind, and the number in its "At" box, for a rule and value. */
function lineKind(state: ParagraphChoice): [LineKind, string] {
  const { line, lineRule } = state;
  if (line === undefined || lineRule === undefined) return ['', ''];
  if (lineRule === 'auto') {
    if (line === 240) return ['single', ''];
    if (line === 360) return ['oneHalf', ''];
    if (line === 480) return ['double', ''];
    return ['multiple', round(line / 240)];
  }
  return [lineRule === 'exact' ? 'exactly' : 'atLeast', round(line / 20)];
}

/** Asks for paragraph formatting: resolves with what to change, or `undefined` on Cancel. */
export function showParagraphDialog(current: ParagraphChoice): Promise<ParagraphChoice | undefined> {
  return new Promise((resolve) => {
    const unit = t(metric() ? 'pageSetup.unitCm' : 'pageSetup.unitIn');
    const number = (value: number | undefined, label: string, step: string, min?: string): HTMLInputElement => {
      const input = h('input', { class: 'wm-input', attrs: { type: 'number', step, 'aria-label': label.replace(/[:：]$/, '') } });
      if (min !== undefined) input.min = min;
      if (value !== undefined) input.value = round(value);
      return input;
    };
    const field = (label: string, input: HTMLInputElement, suffix: string): HTMLElement =>
      h('label', { class: 'wm-page-field' }, h('span', { text: label }), input, h('span', { class: 'wm-page-unit', text: suffix }));
    const select = (label: string, options: readonly (readonly [string, string])[], value: string | undefined, onPick?: () => void) => {
      // A blank choice stands for "the paragraphs differ" (a no-break space, so that its row has a height).
      const values = [...(value === undefined || value === '' ? [''] : []), ...options.map(([v]) => v)];
      const names = new Map(options);
      const box = choiceButton({ label: label.replace(/[:：]$/, ''), fill: true, groups: () => [{ values }], name: (v) => names.get(v) ?? '\u00a0' }, (v) => {
        box.set(v);
        onPick?.();
      });
      box.set(value ?? '');
      return box;
    };

    const align = select(
      t('paragraph.alignment'),
      [
        ['left', t('chrome.format.align.left').replace(/&/g, '')],
        ['center', t('chrome.format.align.center').replace(/&/g, '')],
        ['right', t('chrome.format.align.right').replace(/&/g, '')],
        ['justify', t('chrome.format.align.justify').replace(/&/g, '')],
      ],
      current.align,
    );
    const inches = (twips: number | undefined) => (twips === undefined ? undefined : twips / perUnit());
    const left = number(inches(current.left), t('paragraph.left'), '0.05');
    const right = number(inches(current.right), t('paragraph.right'), '0.05');
    const special = select(
      t('paragraph.special'),
      [
        ['none', t('paragraph.specialNone')],
        ['firstLine', t('paragraph.specialFirstLine')],
        ['hanging', t('paragraph.specialHanging')],
      ],
      current.special,
      () => {
        by.value = '';
        syncBy();
      },
    );
    const by = number(current.special === 'none' ? undefined : inches(current.by), t('paragraph.by'), '0.05', '0');
    const before = number(current.before === undefined ? undefined : current.before / 20, t('paragraph.before'), '1', '0');
    const after = number(current.after === undefined ? undefined : current.after / 20, t('paragraph.after'), '1', '0');
    const [kind, at0] = lineKind(current);
    const spacing = select(
      t('paragraph.lineSpacing'),
      [
        ['single', t('paragraph.lineSingle')],
        ['oneHalf', t('paragraph.lineOneHalf')],
        ['double', t('paragraph.lineDouble')],
        ['atLeast', t('paragraph.lineAtLeast')],
        ['exactly', t('paragraph.lineExactly')],
        ['multiple', t('paragraph.lineMultiple')],
      ],
      kind,
      () => {
        at.value = '';
        syncAt();
      },
    );
    const at = number(undefined, t('paragraph.at'), '0.1', '0');
    at.value = at0;
    const syncAt = () => {
      at.disabled = !['atLeast', 'exactly', 'multiple'].includes(spacing.value);
      if (at.disabled) at.value = '';
      else if (at.value === '') at.value = spacing.value === 'multiple' ? '1.1' : '12';
    };
    syncAt();
    const syncBy = () => {
      by.disabled = special.value === 'none';
      if (by.disabled) by.value = '';
      else if (by.value === '') by.value = round(720 / perUnit());
    };
    syncBy();

    const indentsTab = h(
      'div',
      { class: 'wm-page-tab', attrs: { role: 'tabpanel' } },
      h('label', { text: t('paragraph.alignment') }),
      align.el,
      h('label', { text: t('paragraph.indentation') }),
      h('div', { class: 'wm-page-grid' }, field(t('paragraph.left'), left, unit), field(t('paragraph.right'), right, unit)),
      h('div', { class: 'wm-page-grid' }, h('label', { class: 'wm-page-field' }, h('span', { text: t('paragraph.special') }), special.el), field(t('paragraph.by'), by, unit)),
      h('label', { text: t('paragraph.spacing') }),
      h('div', { class: 'wm-page-grid' }, field(t('paragraph.before'), before, t('paragraph.pt')), field(t('paragraph.after'), after, t('paragraph.pt'))),
      h('div', { class: 'wm-page-grid' }, h('label', { class: 'wm-page-field' }, h('span', { text: t('paragraph.lineSpacing') }), spacing.el), h('label', { class: 'wm-page-field' }, h('span', { text: t('paragraph.at') }), at)),
    );

    const flag = (label: string, value: boolean | undefined): { input: HTMLInputElement; label: HTMLElement } => {
      const input = h('input', { attrs: { type: 'checkbox' } });
      if (value === undefined) input.indeterminate = true;
      else input.checked = value;
      return { input, label: h('label', { class: 'wm-find-case' }, input, label) };
    };
    const widow = flag(t('paragraph.widow'), current.widowControl);
    const keepNext = flag(t('paragraph.keepNext'), current.keepNext);
    const keepLines = flag(t('paragraph.keepLines'), current.keepLines);
    const pageBreak = flag(t('paragraph.pageBreakBefore'), current.pageBreakBefore);
    const breaksTab = h('div', { class: 'wm-page-tab', attrs: { role: 'tabpanel' } }, h('label', { text: t('paragraph.pagination') }), widow.label, keepNext.label, keepLines.label, pageBreak.label);

    const tabs = h('div', { class: 'wm-find-tabs', attrs: { role: 'tablist' } });
    const panes: [HTMLElement, HTMLElement][] = [];
    const show = (i: number) =>
      panes.forEach(([button, pane], k) => {
        button.setAttribute('aria-selected', String(k === i));
        pane.hidden = k !== i;
      });
    [
      [t('paragraph.tabIndents'), indentsTab],
      [t('paragraph.tabBreaks'), breaksTab],
    ].forEach(([label, pane], i) => {
      const button = h('button', { class: 'wm-find-tab', text: label as string, attrs: { type: 'button', role: 'tab' } });
      button.addEventListener('click', () => show(i));
      tabs.append(button);
      panes.push([button, pane as HTMLElement]);
    });
    show(0);
    tabList(tabs, panes.map(([, pane]) => pane));

    const message = h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });
    const ok = h('button', { class: 'wm-button', text: t('paragraph.ok'), attrs: { type: 'submit' } });
    const cancel = h('button', { class: 'wm-button', text: t('paragraph.cancel'), attrs: { type: 'button' } });
    const form = h(
      'form',
      // A number box's step is how far its arrows go, not a limit on what can be typed (A4 is 8.27 in, line spacing can be 1.08): the submit handler below checks the values.
      { attrs: { method: 'dialog', novalidate: '' } },
      tabs,
      h('div', { class: 'wm-dialog-body wm-link-body' }, indentsTab, breaksTab, message),
      h('div', { class: 'wm-dialog-buttons' }, h('span', { class: 'wm-link-actions' }, ok, cancel)),
    );
    const dialog = h('dialog', { class: 'wm-dialog wm-link wm-pagesetup', attrs: { 'aria-label': t('paragraph.title') } }, dialogTitleBar(t('paragraph.title'), () => dialog.close()), form);

    let result: ParagraphChoice | undefined;
    // Keys stay in the dialog: the document's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const choice: ParagraphChoice = {};
      let bad = false;
      /** A blank field stays as it is; anything else must be a number in range. */
      const read = (input: HTMLInputElement, scale: number, min = -Infinity): number | undefined => {
        if (input.value.trim() === '') return undefined;
        const n = Number(input.value) * scale;
        if (!Number.isFinite(n) || n < min || Math.abs(n) > 1e6) bad = true;
        return Math.round(n);
      };
      if (align.value) choice.align = align.value as Alignment;
      choice.left = read(left, perUnit());
      choice.right = read(right, perUnit());
      if (special.value) {
        choice.special = special.value as ParagraphChoice['special'];
        if (choice.special !== 'none') choice.by = read(by, perUnit(), 0) ?? 0;
      }
      choice.before = read(before, 20, 0);
      choice.after = read(after, 20, 0);
      switch (spacing.value) {
        case 'single':
          [choice.line, choice.lineRule] = [240, 'auto'];
          break;
        case 'oneHalf':
          [choice.line, choice.lineRule] = [360, 'auto'];
          break;
        case 'double':
          [choice.line, choice.lineRule] = [480, 'auto'];
          break;
        case 'multiple': {
          const lines = read(at, 240, 12);
          [choice.line, choice.lineRule] = [lines, 'auto'];
          break;
        }
        case 'atLeast':
        case 'exactly': {
          const points = read(at, 20, 20);
          [choice.line, choice.lineRule] = [points, spacing.value === 'exactly' ? 'exact' : 'atLeast'];
          break;
        }
      }
      if (!widow.input.indeterminate) choice.widowControl = widow.input.checked;
      if (!keepNext.input.indeterminate) choice.keepNext = keepNext.input.checked;
      if (!keepLines.input.indeterminate) choice.keepLines = keepLines.input.checked;
      if (!pageBreak.input.indeterminate) choice.pageBreakBefore = pageBreak.input.checked;
      if (bad || (choice.line === undefined && ['multiple', 'atLeast', 'exactly'].includes(spacing.value))) {
        message.textContent = t('paragraph.bad');
        return;
      }
      // Leave out what wasn't filled in.
      result = Object.fromEntries(Object.entries(choice).filter(([, v]) => v !== undefined)) as ParagraphChoice;
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    align.el.focus();
  });
}
