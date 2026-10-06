// Tools ▸ Options ▸ Edit List: the user's own autocorrect replacements ("omw" becomes "on my way").
// Each change is kept at once (see autoCorrect.ts).

import { t } from '../i18n/index.ts';
import { CLOSE_ICON, h, iconButton } from './dom.ts';
import { autoCorrectReplacements, setReplacements, type Replacement } from './autoCorrect.ts';
import { showDialog } from './popup.ts';

/** The body of the dialog: a row for each entry, and a button to add one. */
export function replacementsPanel(): HTMLElement {
  const rows = h('div', { class: 'wm-replacements-rows' });
  const save = () => {
    const list: Replacement[] = [...rows.querySelectorAll<HTMLElement>('.wm-replacements-row')].map((row) => {
      const [text, replacement] = [...row.querySelectorAll('input')].map((input) => input.value);
      return [text, replacement];
    });
    setReplacements(list);
  };
  const addRow = (entry: Replacement = ['', '']): HTMLElement => {
    const text = h('input', { attrs: { type: 'text', 'aria-label': t('dialogs.options.replacementsText'), spellcheck: 'false', autocomplete: 'off' } });
    const replacement = h('input', { attrs: { type: 'text', 'aria-label': t('dialogs.options.replacementsWith'), spellcheck: 'false', autocomplete: 'off' } });
    [text.value, replacement.value] = entry;
    const remove = iconButton('wm-replacements-remove', CLOSE_ICON, t('dialogs.options.replacementsRemove'));
    const row = h('div', { class: 'wm-replacements-row' }, text, replacement, remove);
    text.addEventListener('change', save);
    replacement.addEventListener('change', save);
    remove.addEventListener('click', () => {
      row.remove();
      save();
    });
    rows.append(row);
    return row;
  };
  for (const entry of autoCorrectReplacements()) addRow(entry);
  const add = h('button', { class: 'wm-button', text: t('dialogs.options.replacementsAdd'), attrs: { type: 'button' } });
  add.addEventListener('click', () => addRow().querySelector('input')?.focus());
  return h(
    'div',
    { class: 'wm-replacements' },
    h('p', { text: t('dialogs.options.replacementsHint') }),
    h('div', { class: 'wm-replacements-head' }, h('span', { text: t('dialogs.options.replacementsText') }), h('span', { text: t('dialogs.options.replacementsWith') })),
    rows,
    add,
  );
}

export function showReplacements(onClose?: () => void): void {
  showDialog(t('dialogs.options.replacementsTitle'), replacementsPanel(), onClose);
}
