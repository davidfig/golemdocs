// The parts the sheet's what-if dialogs are built from (Scenario Manager, Solver), all from the shared styles: a modal
// dialog with its title bar, body and buttons; a button; a text field.

import { h } from '../ui/dom.ts';
import { dialogTitleBar } from '../ui/popup.ts';

/** A modal dialog: a title bar, a body, a row of buttons; `onClose` when it closes, however it does. */
export function modal(title: string, body: Node[], buttons: HTMLElement[], onClose: () => void): HTMLDialogElement {
  const dialog = h('dialog', { class: 'wm-dialog wm-link', attrs: { 'aria-label': title } }, dialogTitleBar(title, () => dialog.close()), h('div', { class: 'wm-dialog-body wm-link-body' }, ...body), h('div', { class: 'wm-dialog-buttons' }, ...buttons));
  // Keys stay in the dialog: the sheet's handlers listen on the window.
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  dialog.addEventListener('close', () => {
    dialog.remove();
    onClose();
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

export const button = (text: string, primary = false): HTMLButtonElement => h('button', { class: primary ? 'wm-button wm-primary' : 'wm-button', text, attrs: { type: 'button' } });

export const field = (label: string, value = ''): HTMLInputElement => {
  const input = h('input', { class: 'wm-input', attrs: { type: 'text', 'aria-label': label, autocomplete: 'off', spellcheck: 'false' } });
  input.value = value;
  return input;
};

/** A message under a dialog's fields (what is wrong with them). */
export const message = (): HTMLElement => h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });
