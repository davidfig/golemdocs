// Format › Font: how the selected text looks, and the spacing between its characters. What the selection mixes starts blank and stays
// as it is unless it is set. Also what a style's look is edited with (Format › Styles › Modify).

import { t } from '../../i18n/index.ts';
import type { FontChoice } from '../actions.ts';
import { h } from '../dom.ts';
import { check, choice, colorField, field, numberInput, paintFont, round, showForm, tabStrip } from './parts.ts';

/** The underline styles the pages can draw. A document's other styles stay on offer while it has them. */
const UNDERLINES = ['none', 'single', 'double'] as const;

/** Asks for how text should look: resolves with what was changed, or `undefined` on Cancel. */
export function showFontDialog(current: FontChoice, fonts: readonly string[]): Promise<FontChoice | undefined> {
  const families = [...new Set([...(current.family ? [current.family] : []), ...fonts])].sort((a, b) => a.localeCompare(b));
  const family = choice(t('format.font.family'), families.map((f) => [f, f]), current.family, () => preview());
  const styleOf = (bold: boolean | undefined, italic: boolean | undefined): string => (bold === undefined || italic === undefined ? '' : bold ? (italic ? 'boldItalic' : 'bold') : italic ? 'italic' : 'regular');
  const style = choice(
    t('format.font.style'),
    [
      ['regular', t('format.font.regular')],
      ['italic', t('format.font.italic')],
      ['bold', t('format.font.bold')],
      ['boldItalic', t('format.font.boldItalic')],
    ],
    styleOf(current.bold, current.italic),
    () => preview(),
  );
  const size = numberInput(t('format.font.size'), current.size === undefined ? '' : round(current.size), '0.5', '1');
  const color = colorField(t('format.font.color'), t('format.automatic'), current.color, () => preview());
  const lines = UNDERLINES.map((u) => [u, t(`format.font.underline.${u}`)] as const);
  const underline = choice(t('format.font.underline'), lines, current.underline, () => preview());
  const underlineColor = colorField(t('format.font.underlineColor'), t('format.automatic'), current.underlineColor, () => preview());
  const strike = check(t('format.font.strike'), current.strike);
  const doubleStrike = check(t('format.font.doubleStrike'), current.doubleStrike);
  const superscript = check(t('format.font.superscript'), current.superscript);
  const subscript = check(t('format.font.subscript'), current.subscript);
  const smallCaps = check(t('format.font.smallCaps'), current.smallCaps);
  const caps = check(t('format.font.caps'), current.caps);
  const hidden = check(t('format.font.hidden'), current.hidden);
  // Each of these pairs is one or the other, or neither.
  const either = (a: { input: HTMLInputElement }, b: { input: HTMLInputElement }) => {
    a.input.addEventListener('change', () => {
      if (a.input.checked) b.input.checked = false;
      b.input.indeterminate = false;
    });
    b.input.addEventListener('change', () => {
      if (b.input.checked) a.input.checked = false;
      a.input.indeterminate = false;
    });
  };
  either(strike, doubleStrike);
  either(superscript, subscript);
  either(smallCaps, caps);

  const spacingKind = (n: number | undefined) => (n === undefined ? '' : n > 0 ? 'expanded' : n < 0 ? 'condensed' : 'normal');
  const spacing = choice(
    t('format.font.spacing'),
    [
      ['normal', t('format.font.normal')],
      ['expanded', t('format.font.expanded')],
      ['condensed', t('format.font.condensed')],
    ],
    spacingKind(current.spacing),
    (kind) => {
      spacingBy.disabled = kind === 'normal';
      spacingBy.value = kind === 'normal' ? '' : spacingBy.value || '1';
      preview();
    },
  );
  const spacingBy = numberInput(t('format.font.by'), current.spacing ? round(Math.abs(current.spacing) / 20) : '', '0.1', '0');
  spacingBy.disabled = spacing.value === 'normal';
  const positionKind = (n: number | undefined) => (n === undefined ? '' : n > 0 ? 'raised' : n < 0 ? 'lowered' : 'normal');
  const position = choice(
    t('format.font.position'),
    [
      ['normal', t('format.font.normal')],
      ['raised', t('format.font.raised')],
      ['lowered', t('format.font.lowered')],
    ],
    positionKind(current.position),
    (kind) => {
      positionBy.disabled = kind === 'normal';
      positionBy.value = kind === 'normal' ? '' : positionBy.value || '3';
      preview();
    },
  );
  const positionBy = numberInput(t('format.font.by'), current.position ? round(Math.abs(current.position) / 2) : '', '0.5', '0');
  positionBy.disabled = position.value === 'normal';

  const read = (): FontChoice => {
    const out: FontChoice = {};
    if (family.value) out.family = family.value;
    if (style.value) {
      out.bold = style.value === 'bold' || style.value === 'boldItalic';
      out.italic = style.value === 'italic' || style.value === 'boldItalic';
    }
    if (size.value.trim() !== '') out.size = Number(size.value);
    out.color = color.value;
    if (underline.value) out.underline = underline.value;
    out.underlineColor = underlineColor.value;
    const flag = (key: 'strike' | 'doubleStrike' | 'superscript' | 'subscript' | 'smallCaps' | 'caps' | 'hidden', box: { input: HTMLInputElement }) => {
      if (!box.input.indeterminate) out[key] = box.input.checked;
    };
    flag('strike', strike);
    flag('doubleStrike', doubleStrike);
    flag('superscript', superscript);
    flag('subscript', subscript);
    flag('smallCaps', smallCaps);
    flag('caps', caps);
    flag('hidden', hidden);
    if (spacing.value) out.spacing = spacing.value === 'normal' ? 0 : Math.round(Number(spacingBy.value) * 20) * (spacing.value === 'condensed' ? -1 : 1);
    if (position.value) out.position = position.value === 'normal' ? 0 : Math.round(Number(positionBy.value) * 2) * (position.value === 'lowered' ? -1 : 1);
    return out;
  };

  const sample = h('span', { text: t('format.font.sample') });
  const preview = () => paintFont(sample, { ...current, ...read() });
  for (const box of [strike, doubleStrike, superscript, subscript, smallCaps, caps, hidden]) box.input.addEventListener('change', preview);
  for (const input of [size, spacingBy, positionBy]) input.addEventListener('input', preview);
  preview();

  const fontTab = h(
    'div',
    { class: 'wm-page-tab', attrs: { role: 'tabpanel' } },
    field(t('format.font.family'), family.el),
    h('div', { class: 'wm-page-grid' }, field(t('format.font.style'), style.el), field(t('format.font.size'), size)),
    h('div', { class: 'wm-page-grid' }, field(t('format.font.color'), color.el), field(t('format.font.underline'), underline.el)),
    field(t('format.font.underlineColor'), underlineColor.el),
    h('label', { text: t('format.font.effects') }),
    h('div', { class: 'wm-fd-checks' }, strike.el, smallCaps.el, doubleStrike.el, caps.el, superscript.el, hidden.el, subscript.el),
  );
  const spacingTab = h(
    'div',
    { class: 'wm-page-tab', attrs: { role: 'tabpanel' } },
    h('div', { class: 'wm-page-grid' }, field(t('format.font.spacing'), spacing.el), field(t('format.font.by'), spacingBy, t('paragraph.pt'))),
    h('div', { class: 'wm-page-grid' }, field(t('format.font.position'), position.el), field(t('format.font.by'), positionBy, t('paragraph.pt'))),
  );
  const top = tabStrip([
    [t('format.font.title'), fontTab],
    [t('format.font.tabSpacing'), spacingTab],
  ]);

  return showForm<FontChoice>({
    title: t('format.font.title'),
    className: 'wm-fd-font',
    top,
    body: [fontTab, spacingTab, h('label', { text: t('format.preview') }), h('div', { class: 'wm-fd-sample' }, sample)],
    first: () => family.el,
    read(message) {
      const out = read();
      const bad = (n: number | undefined) => n !== undefined && !Number.isFinite(n);
      if ((out.size !== undefined && !(out.size >= 1 && out.size <= 1638)) || bad(out.spacing) || bad(out.position)) {
        message.textContent = t('format.bad');
        return null;
      }
      // Only what changed: the rest of a mixed selection, or of a style, stays as it is.
      return Object.fromEntries(Object.entries(out).filter(([key, value]) => value !== current[key as keyof FontChoice])) as FontChoice;
    },
  });
}
