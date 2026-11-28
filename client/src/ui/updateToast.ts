// The toast that tells of updates, centered near the bottom of the window: one line with the message, its actions as links and a close
// button, on a dark ground whatever the theme (updateNotice.ts offers an update; newVersionNotice.ts says one was installed, in green).
// It is a note like the others (`showNotice`): read out when it appears, reached with F6, and it gives the keyboard back when it goes.

import { CLOSE_ICON, h, iconButton, keepAboveFooter } from './dom.ts';
import { showNotice } from './notice.ts';
import './updateToast.css';

export interface UpdateToast {
  readonly el: HTMLElement;
  readonly message: HTMLParagraphElement;
  readonly close: HTMLButtonElement;
  /** Adds an action, shown as a link after the message and the earlier actions. */
  action(text: string): HTMLButtonElement;
  show(shown: boolean): void;
}

/** The column the toasts stack in, so two showing at once sit one above the other. */
let host: HTMLElement | null = null;

export function updateToast(parent: HTMLElement, label: string, closeLabel: string, kind: 'info' | 'success' = 'info'): UpdateToast {
  const el = h('aside', { class: `wm-update-toast${kind === 'success' ? ' wm-update-toast-success' : ''}`, attrs: { 'aria-label': label } });
  const message = h('p', { attrs: { role: 'status' } });
  const actions = h('div', { class: 'wm-update-toast-actions' });
  const close = iconButton('wm-update-toast-close', CLOSE_ICON, closeLabel);
  el.append(message, actions, close);
  el.hidden = true;
  if (!host?.isConnected) {
    host = h('div', { class: 'wm-update-toasts' });
    parent.append(host);
    keepAboveFooter(host);
  }
  host.append(el);
  return {
    el,
    message,
    close,
    action(text) {
      const button = h('button', { class: 'wm-update-toast-action', text, attrs: { type: 'button' } });
      actions.append(button);
      return button;
    },
    show: (shown) => showNotice(el, shown),
  };
}
