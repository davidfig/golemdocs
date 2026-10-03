// Edit ▸ Paste Special: what is on the clipboard, and which form of it to paste (Word 2003's list
// of formats, here the two the browser gives: formatted text as HTML, and plain text).

import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import { dialogTitleBar } from './popup.ts';

export interface Clipboard {
  html?: string;
  text?: string;
}

/** What is on the clipboard now, or null if the browser won't let the page look. */
export async function readClipboard(): Promise<Clipboard | null> {
  try {
    if (navigator.clipboard.read) {
      const clip: Clipboard = {};
      for (const item of await navigator.clipboard.read()) {
        if (item.types.includes('text/html')) clip.html ??= await (await item.getType('text/html')).text();
        if (item.types.includes('text/plain')) clip.text ??= await (await item.getType('text/plain')).text();
      }
      return clip;
    }
    return { text: await navigator.clipboard.readText() };
  } catch {
    return null;
  }
}

/** Asks how to paste: resolves with the form chosen, or `undefined` on Cancel. */
export async function showPasteSpecialDialog(clip: Clipboard | null): Promise<'html' | 'text' | undefined> {
  return new Promise((resolve) => {
    const options: { value: 'html' | 'text'; label: string; preview: string }[] = [];
    if (clip?.html) options.push({ value: 'html', label: t('pasteSpecial.html'), preview: clip.text ?? '' });
    if (clip?.text) options.push({ value: 'text', label: t('pasteSpecial.text'), preview: clip.text });

    const list = h('div', { class: 'wm-paste-options', attrs: { role: 'radiogroup', 'aria-label': t('pasteSpecial.as') } });
    const radios = options.map((option, i) => {
      const input = h('input', { attrs: { type: 'radio', name: 'form', value: option.value } });
      input.checked = i === 0;
      list.append(h('label', { class: 'wm-find-case' }, input, option.label));
      return input;
    });
    const preview = h('div', { class: 'wm-paste-preview', attrs: { 'aria-live': 'polite' } });
    const showPreview = () => {
      const chosen = radios.findIndex((r) => r.checked);
      const text = options[chosen]?.preview ?? '';
      preview.textContent = text.length > 400 ? `${text.slice(0, 400)}…` : text;
    };
    radios.forEach((r) => r.addEventListener('change', showPreview));
    showPreview();
    const message = h('div', { class: 'wm-find-message', text: clip === null ? t('pasteSpecial.unavailable') : options.length ? '' : t('pasteSpecial.empty') });

    const ok = h('button', { class: 'wm-button', text: t('pasteSpecial.ok'), attrs: { type: 'submit' } });
    ok.disabled = options.length === 0;
    const cancel = h('button', { class: 'wm-button', text: t('pasteSpecial.cancel'), attrs: { type: 'button' } });
    const form = h(
      'form',
      { attrs: { method: 'dialog' } },
      h('div', { class: 'wm-dialog-body wm-link-body' }, h('label', { text: t('pasteSpecial.as') }), list, preview, message),
      h('div', { class: 'wm-dialog-buttons' }, h('span', { class: 'wm-link-actions' }, ok, cancel)),
    );
    const dialog = h('dialog', { class: 'wm-dialog wm-link wm-pastespecial', attrs: { 'aria-label': t('pasteSpecial.title') } }, dialogTitleBar(t('pasteSpecial.title'), () => dialog.close()), form);

    let result: 'html' | 'text' | undefined;
    // Keys stay in the dialog: the document's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      result = options[radios.findIndex((r) => r.checked)]?.value;
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    (options.length ? radios[0] : cancel).focus();
  });
}
