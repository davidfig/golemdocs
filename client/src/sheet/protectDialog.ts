// Sheet › Protect Sheet and Unprotect Sheet: the password, asked in a dialog (it is about the whole sheet). Protecting
// asks for it twice, and may be left empty; unprotecting asks only when the sheet has one.

import { t } from '../i18n/index.ts';
import { h } from '../ui/dom.ts';
import { dialogTitleBar } from '../ui/popup.ts';

/** Resolves with the password typed ('' for none), or null if the dialog was cancelled. */
export function askSheetPassword(mode: 'protect' | 'unprotect'): Promise<string | null> {
  return new Promise((resolve) => {
    const title = t(mode === 'protect' ? 'sheet.op.protectSheet' : 'sheet.op.unprotectSheet');
    const field = (label: string) => h('input', { class: 'wm-input wm-sheet-password', attrs: { type: 'text', 'aria-label': label, autocomplete: 'off', spellcheck: 'false', 'data-1p-ignore': '', 'data-lpignore': 'true' } });
    const password = field(t('sheet.protect.password'));
    const again = field(t('sheet.protect.again'));
    const message = h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });
    const ok = h('button', { class: 'wm-button wm-primary', text: t('sheet.protect.ok'), attrs: { type: 'submit' } });
    const cancel = h('button', { class: 'wm-button', text: t('sheet.protect.cancel'), attrs: { type: 'button' } });
    const rows = [h('label', { text: t('sheet.protect.password') }), password];
    if (mode === 'protect') rows.push(h('label', { text: t('sheet.protect.again') }), again);
    const form = h(
      'form',
      { attrs: { method: 'dialog' } },
      h('div', { class: 'wm-dialog-body wm-link-body' }, ...(mode === 'protect' ? [h('p', { text: t('sheet.protect.explain') })] : []), ...rows, message),
      h('div', { class: 'wm-dialog-buttons' }, ok, cancel),
    );
    const dialog = h('dialog', { class: 'wm-dialog wm-link', attrs: { 'aria-label': title } }, dialogTitleBar(title, () => dialog.close()), form);
    let answer: string | null = null;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (mode === 'protect' && password.value !== again.value) {
        message.textContent = t('sheet.protect.mismatch');
        again.focus();
        return;
      }
      answer = password.value;
      dialog.close();
    });
    cancel.addEventListener('click', () => dialog.close());
    // Keys stay in the dialog: the sheet's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(answer);
    });
    document.body.append(dialog);
    dialog.showModal();
    password.focus();
  });
}
