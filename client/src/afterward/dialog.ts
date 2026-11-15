// The one thing Afterward asks for: the writer's Anthropic API key, the first time it is needed on this device. Built from the
// format dialogs' shared parts, like the other forms.

import { t } from '../i18n/index.ts';
import { h } from '../ui/dom.ts';
import { field, showForm } from '../ui/formatDialogs/parts.ts';
import './afterward.css';

/** Asks for the API key. Resolves with it, or undefined. */
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
