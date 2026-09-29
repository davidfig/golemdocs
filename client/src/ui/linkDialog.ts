// Insert ▸ Hyperlink: the address a piece of text links to, and the text that shows. A modal
// dialog like the others; the editor does the linking (see @word/editor).

import { t } from '../i18n/index.ts';
import { h } from './dom.ts';

/** Schemes a link may open. Anything else (javascript:, data:…) is refused. */
const SAFE = /^(https?|mailto|tel|ftp):/i;

/**
 * The address as a link should store it: what's typed, with a scheme added when it has none
 * ("example.com" is a web page, "ada@example.com" an e-mail address). Null when it isn't a link
 * the app opens, or is empty.
 */
export function linkAddress(text: string): string | null {
  const address = text.trim();
  if (!address) return null;
  if (address.startsWith('#')) return address.length > 1 ? address : null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(address)) return SAFE.test(address) ? address : null;
  if (/^[^\s@/]+@[^\s@/]+$/.test(address)) return `mailto:${address}`;
  return /\s/.test(address) ? null : `https://${address}`;
}

/** Whether a link is one the app opens in a new tab when it is Ctrl+clicked. */
export const opensLink = (url: string): boolean => SAFE.test(url);

export interface LinkChoice {
  url: string;
  text: string;
}

/**
 * Asks for a link. `current` is the link the selection is in (to change or remove), `selected`
 * the text selected (which the link shows unless it is changed). Resolves with the choice, `null`
 * to take the link off, or `undefined` on Cancel.
 */
export function showLinkDialog(current: LinkChoice | null, selected: string): Promise<LinkChoice | null | undefined> {
  return new Promise((resolve) => {
    const shown = current?.text ?? selected;
    const input = (label: string, value: string) => {
      const el = h('input', { class: 'wm-input', attrs: { type: 'text', 'aria-label': label, autocomplete: 'off', spellcheck: 'false' } });
      el.value = value;
      return el;
    };
    const text = input(t('link.textLabel'), shown);
    const address = input(t('link.addressLabel'), current?.url ?? '');
    const message = h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });
    const ok = h('button', { class: 'wm-button', text: t('link.ok'), attrs: { type: 'submit' } });
    const cancel = h('button', { class: 'wm-button', text: t('link.cancel'), attrs: { type: 'button' } });
    const remove = h('button', { class: 'wm-button', text: t('link.remove'), attrs: { type: 'button' } });
    remove.disabled = !current;

    const close = h('button', { class: 'wm-dialog-close', text: '×', attrs: { type: 'button', 'aria-label': t('link.close') } });
    const form = h(
      'form',
      { attrs: { method: 'dialog' } },
      h(
        'div',
        { class: 'wm-dialog-body wm-link-body' },
        h('label', { text: t('link.textField') }),
        text,
        h('label', { text: t('link.addressField') }),
        address,
        message,
      ),
      h('div', { class: 'wm-dialog-buttons spread' }, remove, h('span', { class: 'wm-link-actions' }, ok, cancel)),
    );
    const dialog = h('dialog', { class: 'wm-dialog wm-link', attrs: { 'aria-label': t('link.title') } }, h('div', { class: 'wm-dialog-title' }, h('span', { text: t('link.title') }), close), form);

    let result: LinkChoice | null | undefined;
    // Keys stay in the dialog: the document's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    close.addEventListener('click', () => dialog.close());
    cancel.addEventListener('click', () => dialog.close());
    remove.addEventListener('click', () => {
      result = null;
      dialog.close();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const url = linkAddress(address.value);
      if (!url) {
        message.textContent = address.value.trim() ? t('link.badAddress') : t('link.noAddress');
        address.focus();
        return;
      }
      result = { url, text: text.value };
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    // The address is what's missing when there's text to show already.
    (text.value ? address : text).focus();
  });
}
