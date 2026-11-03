// File › Page Setup for a sheet: Excel's four tabs (Page: orientation, paper, scale or fit to pages; Margins, with
// centring; Header/Footer; Sheet: print area, title rows and columns, gridlines, headings, page order), built from the same
// parts and classes as the document's Page Setup (ui/pageSetupDialog.ts). Margins in inches, or centimetres in every
// language but English, as there.

import { getLocale, t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';
import { h, segmented } from '../ui/dom.ts';
import { choiceButton } from '../ui/dropdown.ts';
import { button, field, message, modal } from './dialogParts.ts';
import { columnName } from './model/column.ts';
import type { CellRange } from './model/worksheet.ts';
import { PAPER } from './print.ts';
import type { PageSetup } from './print.ts';
import { parseRange, rangeName } from './refs.ts';

export interface SheetPageChoice {
  setup: PageSetup;
  area: CellRange | null;
  titleRows: [number, number] | null;
  titleCols: [number, number] | null;
}

const PAPER_NAMES: Record<number, string> = { 1: 'Letter', 3: 'Tabloid', 5: 'Legal', 7: 'Executive', 8: 'A3', 9: 'A4', 11: 'A5', 12: 'B4 (JIS)', 13: 'B5 (JIS)', 20: 'Envelope #10', 27: 'Envelope DL' };
const metric = (): boolean => getLocale() !== 'en';

/** A header or footer's three parts as Excel's codes keep them (&L, &C, &R). */
function splitParts(code: string): [string, string, string] {
  const out: [string, string, string] = ['', '', ''];
  let part = 1;
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '&' && 'LCR'.includes(code[i + 1] ?? '')) {
      part = 'LCR'.indexOf(code[++i]);
      continue;
    }
    if (code[i] === '&' && code[i + 1] === '&') {
      out[part] += '&&';
      i++;
      continue;
    }
    out[part] += code[i];
  }
  return out;
}

const joinParts = (parts: string[]) => parts.map((p, i) => (p ? `&${'LCR'[i]}${p}` : '')).join('');

/** Resolves with the page setup chosen, or null if cancelled. */
export function askSheetPageSetup(current: SheetPageChoice): Promise<SheetPageChoice | null> {
  return new Promise((resolve) => {
    const s = current.setup;
    const unit = t(metric() ? 'pageSetup.unitCm' : 'pageSetup.unitIn');
    const perInch = metric() ? 2.54 : 1;
    const number = (label: string, value: number, step = '0.05') => {
      const input = h('input', { class: 'wm-input', attrs: { type: 'number', min: '0', step, 'aria-label': label } });
      input.value = String(value);
      return input;
    };
    const labelled = (label: string, input: HTMLElement, after = '') => h('label', { class: 'wm-page-field' }, h('span', { text: label }), input, h('span', { class: 'wm-page-unit', text: after }));

    // Page.
    let orientation = s.orientation;
    const turn = segmented<PageSetup['orientation']>(t('pageSetup.orientation'), [{ value: 'portrait', text: t('pageSetup.portrait') }, { value: 'landscape', text: t('pageSetup.landscape') }], (v) => {
      orientation = v;
      turn.set(v);
    });
    turn.set(orientation);
    const paper = choiceButton({ label: t('pageSetup.paperSize'), groups: () => [{ values: Object.keys(PAPER) }], name: (v) => PAPER_NAMES[+v] ?? v }, (v) => paper.set(v));
    paper.set(String(PAPER[s.paperSize] ? s.paperSize : 1));
    let fit = s.fitToPage;
    const scale = number(t('sheet.page.adjust'), s.scale, '1');
    const wide = number(t('sheet.page.wide'), s.fitWidth, '1');
    const tall = number(t('sheet.page.tall'), s.fitHeight, '1');
    const scaling = segmented<'adjust' | 'fit'>(t('sheet.page.scaling'), [{ value: 'adjust', text: t('sheet.page.adjust') }, { value: 'fit', text: t('sheet.page.fit') }], (v) => {
      fit = v === 'fit';
      scaling.set(v);
      scale.disabled = fit;
      wide.disabled = tall.disabled = !fit;
    });
    scaling.set(fit ? 'fit' : 'adjust');
    scale.disabled = fit;
    wide.disabled = tall.disabled = !fit;
    const pageTab = h(
      'div',
      { class: 'wm-page-tab', attrs: { role: 'tabpanel' } },
      h('label', { text: t('pageSetup.orientation') }),
      turn.el,
      h('label', { text: t('sheet.page.scaling') }),
      scaling.el,
      h('div', { class: 'wm-page-grid' }, labelled(t('sheet.page.adjust'), scale, '%'), labelled(t('sheet.page.wide'), wide), labelled(t('sheet.page.tall'), tall)),
      h('label', { text: t('pageSetup.paperSize') }),
      paper.el,
    );

    // Margins.
    const margins = Object.fromEntries((['top', 'bottom', 'left', 'right', 'header', 'footer'] as const).map((k) => [k, number(t(`pageSetup.${k}` as MessageKey), Math.round(s.margins[k] * perInch * 100) / 100)])) as Record<keyof PageSetup['margins'], HTMLInputElement>;
    const check = (label: string, on: boolean) => {
      const box = h('input', { attrs: { type: 'checkbox' } });
      box.checked = on;
      return { box, el: h('label', { class: 'wm-sheet-check' }, box, h('span', { text: label })) };
    };
    const centerH = check(t('sheet.page.centerH'), s.centerHorizontally);
    const centerV = check(t('sheet.page.centerV'), s.centerVertically);
    const marginsTab = h(
      'div',
      { class: 'wm-page-tab', attrs: { role: 'tabpanel' } },
      h('div', { class: 'wm-page-grid' }, ...(['top', 'bottom', 'left', 'right', 'header', 'footer'] as const).map((k) => labelled(t(`pageSetup.${k}` as MessageKey), margins[k], unit))),
      h('label', { text: t('sheet.page.center') }),
      h('div', { class: 'wm-page-orientation' }, centerH.el, centerV.el),
    );

    // Header and footer: each in three parts.
    const parts = (code: string, which: string) => splitParts(code).map((p, i) => field(t(`sheet.page.${which}${'LCR'[i]}` as MessageKey), p));
    const header = parts(s.header, 'header');
    const footer = parts(s.footer, 'footer');
    const hfTab = h(
      'div',
      { class: 'wm-page-tab', attrs: { role: 'tabpanel' } },
      h('label', { text: t('pageSetup.header') }),
      h('div', { class: 'wm-sheet-page-parts' }, ...header),
      h('label', { text: t('pageSetup.footer') }),
      h('div', { class: 'wm-sheet-page-parts' }, ...footer),
      h('div', { class: 'wm-sheet-page-hint', text: t('sheet.page.codes') }),
    );

    // Sheet.
    const area = field(t('sheet.page.area'), current.area ? rangeName(current.area) : '');
    const rowsField = field(t('sheet.page.titleRows'), current.titleRows ? `${current.titleRows[0] + 1}:${current.titleRows[1] + 1}` : '');
    const colsField = field(t('sheet.page.titleCols'), current.titleCols ? `${columnName(current.titleCols[0])}:${columnName(current.titleCols[1])}` : '');
    const gridLines = check(t('sheet.page.gridLines'), s.gridLines);
    const headings = check(t('sheet.page.headings'), s.headings);
    let overThenDown = s.overThenDown;
    const order = segmented<'down' | 'over'>(t('sheet.page.order'), [{ value: 'down', text: t('sheet.page.down') }, { value: 'over', text: t('sheet.page.over') }], (v) => {
      overThenDown = v === 'over';
      order.set(v);
    });
    order.set(overThenDown ? 'over' : 'down');
    const sheetTab = h(
      'div',
      { class: 'wm-page-tab', attrs: { role: 'tabpanel' } },
      h('label', { text: t('sheet.page.area') }),
      area,
      h('label', { text: t('sheet.page.titleRows') }),
      rowsField,
      h('label', { text: t('sheet.page.titleCols') }),
      colsField,
      h('div', { class: 'wm-page-orientation' }, gridLines.el, headings.el),
      h('label', { text: t('sheet.page.order') }),
      order.el,
    );

    // Tabs, as the document's dialog has them.
    const tabs = h('div', { class: 'wm-find-tabs', attrs: { role: 'tablist' } });
    const panes: [HTMLElement, HTMLElement][] = [];
    const select = (i: number) =>
      panes.forEach(([b, pane], k) => {
        b.setAttribute('aria-selected', String(k === i));
        pane.hidden = k !== i;
      });
    (
      [
        [t('sheet.page.tabPage'), pageTab],
        [t('pageSetup.tabMargins'), marginsTab],
        [t('sheet.page.tabHeaderFooter'), hfTab],
        [t('sheet.page.tabSheet'), sheetTab],
      ] as const
    ).forEach(([label, pane], i) => {
      const b = h('button', { class: 'wm-find-tab', text: label, attrs: { type: 'button', role: 'tab' } });
      b.addEventListener('click', () => select(i));
      tabs.append(b);
      panes.push([b, pane]);
    });
    select(0);

    const problem = message();
    const ok = button(t('pageSetup.ok'), true);
    const cancel = button(t('pageSetup.cancel'));
    let answer: SheetPageChoice | null = null;
    const dialog = modal(t('pageSetup.title'), [tabs, pageTab, marginsTab, hfTab, sheetTab, problem], [ok, cancel], () => resolve(answer));
    dialog.classList.add('wm-pagesetup');
    cancel.addEventListener('click', () => dialog.close());
    ok.addEventListener('click', () => {
      const inches = Object.fromEntries(Object.entries(margins).map(([k, input]) => [k, Number(input.value) / perInch])) as PageSetup['margins'];
      const percent = Math.round(Number(scale.value));
      const pagesWide = Math.round(Number(wide.value));
      const pagesTall = Math.round(Number(tall.value));
      const range = area.value.trim() ? parseRange(area.value.trim().replace(/\$/g, '')) : null;
      const titleRows = rowsField.value.trim() ? /^\$?(\d+):\$?(\d+)$/.exec(rowsField.value.trim()) : null;
      const titleCols = colsField.value.trim() ? /^\$?([A-Za-z]+):\$?([A-Za-z]+)$/.exec(colsField.value.trim()) : null;
      const colRange = titleCols && parseRange(`${titleCols[1]}1:${titleCols[2]}1`);
      const bad =
        Object.values(inches).some((v) => !Number.isFinite(v) || v < 0) ||
        !(percent >= 10 && percent <= 400) ||
        !(pagesWide >= 0 && pagesTall >= 0) ||
        (area.value.trim() && !range) ||
        (rowsField.value.trim() && !titleRows) ||
        (colsField.value.trim() && !colRange);
      if (bad) {
        problem.textContent = t('sheet.page.bad');
        return;
      }
      answer = {
        setup: {
          ...s,
          orientation,
          paperSize: +paper.value,
          scale: percent,
          fitToPage: fit,
          fitWidth: pagesWide,
          fitHeight: pagesTall,
          margins: inches,
          centerHorizontally: centerH.box.checked,
          centerVertically: centerV.box.checked,
          header: joinParts(header.map((f) => f.value)),
          footer: joinParts(footer.map((f) => f.value)),
          gridLines: gridLines.box.checked,
          headings: headings.box.checked,
          overThenDown,
        },
        area: range,
        titleRows: titleRows ? [Math.min(+titleRows[1], +titleRows[2]) - 1, Math.max(+titleRows[1], +titleRows[2]) - 1] : null,
        titleCols: colRange ? [colRange.c0, colRange.c1] : null,
      };
      dialog.close();
    });
  });
}
