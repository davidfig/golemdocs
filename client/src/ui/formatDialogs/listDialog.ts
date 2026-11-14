// Format › Bullets and Numbering: a gallery of bullets and of numbers for the selected paragraphs, and what can be changed about the one
// chosen (its character or number format, its label, where it starts, its indents).

import { t } from '../../i18n/index.ts';
import type { ListFormat } from '../actions.ts';
import { h } from '../dom.ts';
import { check, choice, field, gallery, numberInput, round, showForm, tabStrip, twipsPerUnit, unitName } from './parts.ts';

/** Bullets every core font page has (see scripts/fonts/charset.txt). */
const BULLETS = ['•', '◦', '▪', '■', '○', '◆', '→', '–'];
const FORMATS = ['decimal', 'decimalZero', 'lowerLetter', 'upperLetter', 'lowerRoman', 'upperRoman'] as const;
const SHOW: Record<(typeof FORMATS)[number], string> = { decimal: '1', decimalZero: '01', lowerLetter: 'a', upperLetter: 'A', lowerRoman: 'i', upperRoman: 'I' };

export interface ListAnswer {
  list: ListFormat | null;
  restart: boolean;
}

/** One tile of a gallery, showing three lines' labels. */
function tile(lines: readonly string[], label: string, pick: () => void): HTMLButtonElement {
  const button = h('button', { class: 'wm-fd-tile', attrs: { type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': label }, title: label }, ...lines.map((line) => h('span', { class: 'wm-fd-tile-line' }, h('span', { text: line }), h('span', { class: 'wm-fd-tile-bar' }))));
  button.addEventListener('click', pick);
  return button;
}

/** Asks for a list format: resolves with it (a null list is none), or `undefined` on Cancel. `current` is undefined when the paragraphs differ. */
export function showListDialog(current: ListFormat | null | undefined, inList: boolean): Promise<ListAnswer | undefined> {
  const level = current?.level ?? 0;
  const unit = unitName();
  const toUnit = (twips: number | undefined, fallback: number) => round((twips ?? fallback) / twipsPerUnit());

  let chosen: ListFormat | null = current ?? null;
  let multilevel = false;
  const glyph = h('input', { class: 'wm-input', attrs: { type: 'text', maxlength: '2', 'aria-label': t('format.list.character') } });
  const format = choice(t('format.list.format'), FORMATS.map((f) => [f, `${SHOW[f]}, ${t(`format.list.format.${f}`)}`] as const), current?.format ?? 'decimal', (value) => {
    if (chosen) chosen = { ...chosen, format: value };
    multilevel = false;
    paint();
  });
  const pattern = h('input', { class: 'wm-input', attrs: { type: 'text', 'aria-label': t('format.list.pattern') } });
  const start = numberInput(t('format.list.start'), String(current?.start ?? 1), '1', '0');
  const left = numberInput(t('format.list.left'), toUnit(current?.left, 720 * (level + 1)), '0.05', '0');
  const hanging = numberInput(t('format.list.hanging'), toUnit(current?.hanging, 360), '0.05', '0');
  const restart = check(t('format.list.restart'), false);
  glyph.value = current?.glyph ?? '•';
  pattern.value = current?.pattern ?? `%${level + 1}.`;

  const bulletTiles: [HTMLButtonElement, string | null][] = [];
  const numberTiles: [HTMLButtonElement, string][] = [];
  const none = (): HTMLButtonElement => {
    const button = h('button', { class: 'wm-fd-tile wm-fd-tile-none', text: t('format.list.none'), attrs: { type: 'button', role: 'radio', 'aria-checked': 'false' } });
    button.addEventListener('click', () => pick(null));
    return button;
  };
  const pick = (list: ListFormat | null) => {
    chosen = list;
    multilevel = !!list?.multilevel;
    if (list?.glyph) glyph.value = list.glyph;
    if (list?.format) format.set(list.format);
    if (list?.pattern) pattern.value = list.pattern;
    paint();
  };
  const paint = () => {
    for (const [button, value] of bulletTiles) button.setAttribute('aria-checked', String(value === null ? !chosen : chosen?.kind === 'bullet' && chosen.glyph === value));
    for (const [button, key] of numberTiles) {
      const on = !!chosen && chosen.kind === 'number' && (key === 'multilevel' ? multilevel : !multilevel && key === `${chosen.format}|${chosen.pattern}`);
      button.setAttribute('aria-checked', String(on));
    }
    custom.hidden = !chosen;
    bulletFields.hidden = chosen?.kind !== 'bullet';
    numberFields.hidden = chosen?.kind !== 'number';
  };

  const bullets = gallery(h('div', { class: 'wm-fd-gallery', attrs: { 'aria-label': t('format.list.bullets') } }));
  const noBullet = none();
  bulletTiles.push([noBullet, null]);
  bullets.append(noBullet);
  for (const b of BULLETS) {
    const button = tile([b, b, b], t('format.list.bulletNamed', { bullet: b }), () => pick({ kind: 'bullet', glyph: b }));
    bulletTiles.push([button, b]);
    bullets.append(button);
  }
  const numbers = gallery(h('div', { class: 'wm-fd-gallery', attrs: { 'aria-label': t('format.list.numbers') } }));
  const noNumber = none();
  bulletTiles.push([noNumber, null]);
  numbers.append(noNumber);
  const n = level + 1;
  const presets: [(typeof FORMATS)[number], string, string[]][] = [
    ['decimal', `%${n}.`, ['1.', '2.', '3.']],
    ['decimal', `%${n})`, ['1)', '2)', '3)']],
    ['lowerLetter', `%${n}.`, ['a.', 'b.', 'c.']],
    ['lowerLetter', `%${n})`, ['a)', 'b)', 'c)']],
    ['upperLetter', `%${n}.`, ['A.', 'B.', 'C.']],
    ['lowerRoman', `%${n}.`, ['i.', 'ii.', 'iii.']],
    ['upperRoman', `%${n}.`, ['I.', 'II.', 'III.']],
  ];
  for (const [f, text, lines] of presets) {
    const button = tile(lines, lines.join(' '), () => pick({ kind: 'number', format: f, pattern: text }));
    numberTiles.push([button, `${f}|${text}`]);
    numbers.append(button);
  }
  const outline = tile(['1.', '1.1.', '1.1.1.'], t('format.list.outline'), () => pick({ kind: 'number', format: 'decimal', pattern: '%1.', multilevel: true }));
  numberTiles.push([outline, 'multilevel']);
  numbers.append(outline);

  const bulletFields = h('div', { class: 'wm-page-tab' }, field(t('format.list.character'), glyph));
  const numberFields = h(
    'div',
    { class: 'wm-page-tab' },
    h('div', { class: 'wm-page-grid' }, field(t('format.list.format'), format.el), field(t('format.list.pattern'), pattern)),
    h('div', { class: 'wm-page-grid' }, field(t('format.list.start'), start), inList ? restart.el : h('span')),
  );
  const custom = h('div', { class: 'wm-page-tab' }, h('label', { text: t('format.list.customize') }), bulletFields, numberFields, h('div', { class: 'wm-page-grid' }, field(t('format.list.left'), left, unit), field(t('format.list.hanging'), hanging, unit)));
  const bulletsTab = h('div', { class: 'wm-page-tab', attrs: { role: 'tabpanel' } }, bullets);
  const numbersTab = h('div', { class: 'wm-page-tab', attrs: { role: 'tabpanel' } }, numbers);
  const top = tabStrip([
    [t('format.list.bullets'), bulletsTab],
    [t('format.list.numbers'), numbersTab],
  ]);
  if (current?.kind === 'number') (top.children[1] as HTMLElement).click();
  paint();
  // A label typed by hand is not one of the gallery's.
  pattern.addEventListener('input', () => {
    if (chosen) chosen = { ...chosen, pattern: pattern.value };
    multilevel = false;
    paint();
  });
  glyph.addEventListener('input', () => {
    if (chosen) chosen = { ...chosen, glyph: glyph.value };
    paint();
  });

  return showForm<ListAnswer>({
    title: t('format.list.title'),
    className: 'wm-fd-list',
    top,
    body: [bulletsTab, numbersTab, custom],
    first: () => (current?.kind === 'number' ? numbers : bullets).querySelector<HTMLElement>('[aria-checked="true"]') ?? noBullet,
    read(message) {
      if (!chosen) return { list: null, restart: false };
      const twips = (input: HTMLInputElement) => Math.round(Number(input.value) * twipsPerUnit());
      const bad = (input: HTMLInputElement) => input.value.trim() === '' || !(Number(input.value) >= 0);
      const wrongLabel = chosen.kind === 'number' && !chosen.multilevel && !pattern.value.includes(`%${n}`);
      if (bad(left) || bad(hanging) || (chosen.kind === 'number' && bad(start)) || (chosen.kind === 'bullet' && !glyph.value.trim()) || wrongLabel) {
        message.textContent = wrongLabel ? t('format.list.badPattern', { code: `%${n}` }) : t('format.bad');
        return null;
      }
      const { kind, multilevel: outlined } = chosen;
      const list: ListFormat =
        kind === 'bullet'
          ? { kind, glyph: glyph.value.trim(), left: twips(left), hanging: twips(hanging) }
          : { kind, format: format.value, pattern: pattern.value, start: Math.floor(Number(start.value)), left: twips(left), hanging: twips(hanging), ...(outlined && { multilevel: true }) };
      return { list, restart: restart.input.checked };
    },
  });
}
