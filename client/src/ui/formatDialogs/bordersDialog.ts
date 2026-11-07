// Format › Borders and Shading: the lines around the selected paragraphs and the color behind them.

import { t } from '../../i18n/index.ts';
import type { BorderSide, BordersChoice } from '../actions.ts';
import { h, segmented } from '../dom.ts';
import { choice, colorField, field, numberInput, round, showForm, tabStrip } from './parts.ts';

const SIDES = ['top', 'left', 'right', 'bottom'] as const;
type Side = (typeof SIDES)[number];
/** Eighths of a point, as Word offers them. */
const WIDTHS = [2, 4, 6, 8, 12, 18, 24, 36, 48];

/** Asks for borders and shading: resolves with what was changed, or `undefined` on Cancel. `current` is undefined when the paragraphs differ. */
export function showBordersDialog(current: BordersChoice | undefined): Promise<BordersChoice | undefined> {
  const initial: BordersChoice = current ?? {};
  const sides = new Map<Side, BorderSide | null | undefined>(SIDES.map((side) => [side, initial[side]]));
  const sample = SIDES.map((side) => initial[side]).find(Boolean);
  const style = choice(t('format.borders.style'), [['single', t('format.borders.single')], ['double', t('format.borders.double')]], sample?.style ?? 'single', () => restyle());
  const width = choice(t('format.borders.width'), WIDTHS.map((w) => [String(w), t('format.borders.points', { points: w / 8 })]), String(sample?.width ?? 4), () => restyle());
  const color = colorField(t('format.borders.color'), t('format.automatic'), sample?.color ?? null, () => restyle());
  const space = numberInput(t('format.borders.space'), round(sample?.space ?? 1), '1', '0');
  const fill = colorField(t('format.borders.fill'), t('format.borders.noFill'), initial.shading, () => paint());
  const line = (side: Side): BorderSide => ({ style: style.value, width: Number(width.value), color: color.value, space: side === 'left' || side === 'right' ? Math.max(Number(space.value) || 0, 4) : Number(space.value) || 0 });

  const setting = segmented<'none' | 'box' | 'custom'>(
    t('format.borders.setting'),
    [
      { value: 'none', text: t('format.borders.none') },
      { value: 'box', text: t('format.borders.box') },
      { value: 'custom', text: t('format.borders.custom') },
    ],
    (value) => {
      if (value !== 'custom') for (const side of SIDES) sides.set(side, value === 'box' ? line(side) : null);
      touched = true;
      paint();
    },
  );
  let touched = false;
  const buttons = new Map(
    SIDES.map((side) => {
      const button = h('button', { class: 'wm-button wm-fd-side', text: t(`format.borders.${side}`), attrs: { type: 'button', 'aria-pressed': 'false' } });
      button.addEventListener('click', () => {
        sides.set(side, sides.get(side) ? null : line(side));
        touched = true;
        paint();
      });
      return [side, button] as const;
    }),
  );
  const box = h('div', { class: 'wm-fd-borders-text', text: t('format.font.sample') });
  /** A change of line goes on the sides that have one. */
  const restyle = () => {
    for (const side of SIDES) if (sides.get(side)) sides.set(side, line(side));
    paint();
  };
  space.addEventListener('input', restyle);
  const paint = () => {
    const on = SIDES.filter((side) => sides.get(side));
    setting.set(on.length === 0 ? 'none' : on.length === 4 ? 'box' : 'custom');
    for (const side of SIDES) {
      const border = sides.get(side);
      const css = border ? `${border.style === 'double' ? Math.max(border.width / 8, 1) * 3 : Math.max(border.width / 8, 0.5)}px ${border.style === 'double' ? 'double' : 'solid'} ${border.color ?? 'currentColor'}` : 'none';
      box.style.setProperty(`border-${side}`, css);
      buttons.get(side)!.setAttribute('aria-pressed', String(!!border));
    }
    box.style.background = fill.value ?? 'transparent';
  };
  paint();

  const bordersTab = h(
    'div',
    { class: 'wm-page-tab', attrs: { role: 'tabpanel' } },
    h('label', { text: t('format.borders.setting') }),
    setting.el,
    h('div', { class: 'wm-page-grid' }, field(t('format.borders.style'), style.el), field(t('format.borders.width'), width.el)),
    h('div', { class: 'wm-page-grid' }, field(t('format.borders.color'), color.el), field(t('format.borders.space'), space, t('paragraph.pt'))),
  );
  const shadingTab = h('div', { class: 'wm-page-tab', attrs: { role: 'tabpanel' } }, field(t('format.borders.fill'), fill.el));
  const top = tabStrip([
    [t('format.borders.tabBorders'), bordersTab],
    [t('format.borders.tabShading'), shadingTab],
  ]);
  const preview = h(
    'div',
    { class: 'wm-fd-borders' },
    buttons.get('top')!,
    h('div', { class: 'wm-fd-borders-middle' }, buttons.get('left')!, box, buttons.get('right')!),
    buttons.get('bottom')!,
  );
  return showForm<BordersChoice>({
    title: t('format.borders.title'),
    className: 'wm-fd-bordersdialog',
    top,
    body: [bordersTab, shadingTab, h('label', { text: t('format.preview') }), preview],
    first: () => style.el,
    read(message) {
      if (!(Number(space.value) >= 0 && Number(space.value) <= 31)) {
        message.textContent = t('format.bad');
        return null;
      }
      const out: BordersChoice = {};
      if (touched) for (const side of SIDES) if (sides.get(side) !== undefined && JSON.stringify(sides.get(side)) !== JSON.stringify(initial[side])) out[side] = sides.get(side);
      if (fill.value !== (initial.shading ?? null)) out.shading = fill.value;
      return out;
    },
  });
}
