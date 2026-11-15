// Tools › Read It Afterward…: who the piece is for (optional), and the key the reading is paid with (docs/afterward.md §2).
// Built from the format dialogs' shared parts, like the other forms.

import { t } from '../i18n/index.ts';
import { h } from '../ui/dom.ts';
import { field, showForm } from '../ui/formatDialogs/parts.ts';
import './afterward.css';

export interface StartChoice {
  /** Who the piece is for, as the writer put it ('' for anyone). */
  audience: string;
  /** A new key typed in ('' keeps the one there is). */
  key: string;
}

/** Asks who the piece is for and, when none is set on this device, for the key. `audience` is what the last read was told. */
export function showStartDialog(audience: string, hasKey: boolean, removeKey: () => void, note = ''): Promise<StartChoice | undefined> {
  const forWhom = h('textarea', { class: 'wm-input wm-afterward-about', attrs: { rows: '2', 'aria-label': t('afterward.dialog.audience'), placeholder: t('afterward.dialog.audienceHint') } });
  forWhom.value = audience;
  const key = h('input', { class: 'wm-input', attrs: { type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('afterward.dialog.key'), placeholder: hasKey ? t('afterward.dialog.keySet') : 'sk-ant-…' } });
  const remove = h('button', { class: 'wm-button', text: t('afterward.dialog.removeKey'), attrs: { type: 'button' } });
  remove.hidden = !hasKey;
  remove.addEventListener('click', () => {
    removeKey();
    hasKey = false;
    remove.hidden = true;
    key.placeholder = 'sk-ant-…';
    key.focus();
  });
  return showForm<StartChoice>({
    title: t('afterward.dialog.title'),
    className: 'wm-afterward-dialog',
    body: [
      h('p', { class: 'wm-hint', text: t('afterward.dialog.intro') }),
      note ? h('p', { class: 'wm-afterward-scope', text: note }) : null,
      field(t('afterward.dialog.audience'), forWhom),
      field(t('afterward.dialog.key'), key),
      h('p', { class: 'wm-hint', text: t('afterward.dialog.keyHint') }),
    ],
    left: [remove],
    okText: t('afterward.dialog.read'),
    first: () => forWhom,
    read: (message) => {
      const typed = key.value.trim();
      if (!typed && !hasKey) {
        message.textContent = t('afterward.dialog.noKey');
        return null;
      }
      return { audience: forWhom.value.trim(), key: typed };
    },
  });
}

/** Asks for the API key alone (a command other than Read It Afterward, with none set). Resolves with it, or undefined. */
export function askForKey(): Promise<string | undefined> {
  const key = h('input', { class: 'wm-input', attrs: { type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('afterward.dialog.key'), placeholder: 'sk-ant-…' } });
  return showForm<string>({
    title: t('afterward.dialog.keyTitle'),
    className: 'wm-afterward-dialog',
    body: [field(t('afterward.dialog.key'), key), h('p', { class: 'wm-hint', text: t('afterward.dialog.keyHint') })],
    okText: t('afterward.dialog.useKey'),
    first: () => key,
    read: (message) => {
      if (key.value.trim()) return key.value.trim();
      message.textContent = t('afterward.dialog.noKey');
      return null;
    },
  });
}
