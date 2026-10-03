// File ▸ Page Setup: the margins, paper and orientation of the pages, and where the change applies.
// A modal dialog with two tabs like the others' style; the editor sets them (see @golemdocs/editor setPage).
// Sizes are shown in inches, or in centimetres in every language but English.

import { getLocale, t } from '../i18n/index.ts';
import { h } from './dom.ts';
import { dialogTitleBar } from './popup.ts';

/** Twips, and how the page is oriented, as the editor keeps them. */
export interface PageState {
  width: number;
  height: number;
  landscape: boolean;
  top: number;
  bottom: number;
  left: number;
  right: number;
  gutter: number;
  header: number;
  footer: number;
}

export interface PageChoice extends PageState {
  scope: 'document' | 'section' | 'forward';
}

/** Paper sizes by name, portrait, twips. */
const PAPER: [string, number, number][] = [
  ['Letter', 12240, 15840],
  ['Legal', 12240, 20160],
  ['Executive', 10440, 15120],
  ['A3', 16838, 23811],
  ['A4', 11906, 16838],
  ['A5', 8391, 11906],
];
const CUSTOM = 'custom';
/** Twips in the smallest page or text area, an inch. */
const MIN = 1440;

const metric = (): boolean => getLocale() !== 'en';
const perUnit = (): number => (metric() ? 1440 / 2.54 : 1440);
const show = (twips: number): string => String(Math.round((twips / perUnit()) * 100) / 100);

/** Asks for the page setup: resolves with the choice, or `undefined` on Cancel. */
export function showPageSetupDialog(current: PageState): Promise<PageChoice | undefined> {
  return new Promise((resolve) => {
    const unit = t(metric() ? 'pageSetup.unitCm' : 'pageSetup.unitIn');
    const numbers = new Map<string, HTMLInputElement>();
    const field = (id: string, label: string, twips: number): HTMLElement => {
      const input = h('input', { class: 'wm-input', attrs: { type: 'number', min: '0', step: '0.05', 'aria-label': label.replace(/[:：]$/, '') } });
      input.value = show(twips);
      numbers.set(id, input);
      return h('label', { class: 'wm-page-field' }, h('span', { text: label }), input, h('span', { class: 'wm-page-unit', text: unit }));
    };

    // Margins.
    const orientation = (value: 'portrait' | 'landscape', label: string) => {
      const input = h('input', { attrs: { type: 'radio', name: 'orientation', value } });
      input.checked = (value === 'landscape') === current.landscape;
      return { input, label: h('label', { class: 'wm-find-case' }, input, label) };
    };
    const portrait = orientation('portrait', t('pageSetup.portrait'));
    const landscape = orientation('landscape', t('pageSetup.landscape'));
    const marginsTab = h(
      'div',
      { class: 'wm-page-tab', attrs: { role: 'tabpanel' } },
      h(
        'div',
        { class: 'wm-page-grid' },
        field('top', t('pageSetup.top'), current.top),
        field('bottom', t('pageSetup.bottom'), current.bottom),
        field('left', t('pageSetup.left'), current.left),
        field('right', t('pageSetup.right'), current.right),
        field('gutter', t('pageSetup.gutter'), current.gutter),
      ),
      h('label', { text: t('pageSetup.orientation') }),
      h('div', { class: 'wm-page-orientation' }, portrait.label, landscape.label),
      h('label', { text: t('pageSetup.fromEdge') }),
      h('div', { class: 'wm-page-grid' }, field('header', t('pageSetup.header'), current.header), field('footer', t('pageSetup.footer'), current.footer)),
    );

    // Paper.
    const size = h('select', { class: 'wm-input', attrs: { 'aria-label': t('pageSetup.paperSize') } });
    for (const [name] of PAPER) size.append(Object.assign(h('option', { text: name }), { value: name }));
    size.append(Object.assign(h('option', { text: t('pageSetup.custom') }), { value: CUSTOM }));
    const paperTab = h(
      'div',
      { class: 'wm-page-tab', attrs: { role: 'tabpanel' } },
      h('label', { text: t('pageSetup.paperSize') }),
      size,
      h('div', { class: 'wm-page-grid' }, field('width', t('pageSetup.width'), current.width), field('height', t('pageSetup.height'), current.height)),
    );

    const scope = h('select', { class: 'wm-input', attrs: { 'aria-label': t('pageSetup.apply') } });
    for (const [value, label] of [
      ['section', t('pageSetup.applySection')],
      ['document', t('pageSetup.applyDocument')],
      ['forward', t('pageSetup.applyForward')],
    ] as const) scope.append(Object.assign(h('option', { text: label }), { value }));
    const message = h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });

    const twips = (id: string): number => Math.round(Number(numbers.get(id)!.value) * perUnit());
    /** The paper size that the width and height fields say (either way up), or custom. */
    const syncSize = () => {
      const [w, h2] = [twips('width'), twips('height')].sort((a, b) => a - b);
      size.value = PAPER.find(([, pw, ph]) => Math.abs(pw - w) <= 2 && Math.abs(ph - h2) <= 2)?.[0] ?? CUSTOM;
    };
    syncSize();
    numbers.get('width')!.addEventListener('input', syncSize);
    numbers.get('height')!.addEventListener('input', syncSize);
    size.addEventListener('change', () => {
      const paper = PAPER.find(([name]) => name === size.value);
      if (!paper) return;
      const tall = !landscape.input.checked;
      numbers.get('width')!.value = show(tall ? paper[1] : paper[2]);
      numbers.get('height')!.value = show(tall ? paper[2] : paper[1]);
    });
    // Turning the page on its side swaps its width and height.
    for (const { input } of [portrait, landscape]) {
      input.addEventListener('change', () => {
        const [w, h2] = [numbers.get('width')!, numbers.get('height')!];
        const wide = landscape.input.checked;
        if ((Number(w.value) > Number(h2.value)) !== wide) [w.value, h2.value] = [h2.value, w.value];
      });
    }

    // Tabs.
    const tabs = h('div', { class: 'wm-find-tabs', attrs: { role: 'tablist' } });
    const panes: [HTMLElement, HTMLElement][] = [];
    const select = (i: number) => panes.forEach(([button, pane], k) => {
      button.setAttribute('aria-selected', String(k === i));
      pane.hidden = k !== i;
    });
    [[t('pageSetup.tabMargins'), marginsTab], [t('pageSetup.tabPaper'), paperTab]].forEach(([label, pane], i) => {
      const button = h('button', { class: 'wm-find-tab', text: label as string, attrs: { type: 'button', role: 'tab' } });
      button.addEventListener('click', () => select(i));
      tabs.append(button);
      panes.push([button, pane as HTMLElement]);
    });
    select(0);

    const ok = h('button', { class: 'wm-button', text: t('pageSetup.ok'), attrs: { type: 'submit' } });
    const cancel = h('button', { class: 'wm-button', text: t('pageSetup.cancel'), attrs: { type: 'button' } });
    const form = h(
      'form',
      { attrs: { method: 'dialog' } },
      tabs,
      h('div', { class: 'wm-dialog-body wm-link-body' }, marginsTab, paperTab, h('label', { text: t('pageSetup.apply') }), scope, message),
      h('div', { class: 'wm-dialog-buttons' }, h('span', { class: 'wm-link-actions' }, ok, cancel)),
    );
    const dialog = h('dialog', { class: 'wm-dialog wm-link wm-pagesetup', attrs: { 'aria-label': t('pageSetup.title') } }, dialogTitleBar(t('pageSetup.title'), () => dialog.close()), form);

    let result: PageChoice | undefined;
    // Keys stay in the dialog: the document's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const page: PageState = {
        width: twips('width'),
        height: twips('height'),
        landscape: landscape.input.checked,
        top: twips('top'),
        bottom: twips('bottom'),
        left: twips('left'),
        right: twips('right'),
        gutter: twips('gutter'),
        header: twips('header'),
        footer: twips('footer'),
      };
      const sizes = [page.width, page.height];
      const margins = [page.top, page.bottom, page.left, page.right, page.gutter, page.header, page.footer];
      const valid =
        sizes.every((n) => Number.isFinite(n) && n >= MIN) &&
        margins.every((n) => Number.isFinite(n) && n >= 0) &&
        page.left + page.right + page.gutter <= page.width - MIN &&
        page.top + page.bottom <= page.height - MIN;
      if (!valid) {
        message.textContent = t('pageSetup.bad');
        return;
      }
      result = { ...page, scope: scope.value as PageChoice['scope'] };
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    numbers.get('top')!.select();
  });
}
