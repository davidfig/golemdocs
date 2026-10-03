// Importing a file whose name a document already has (with other contents): overwrite it, keep both
// (the new one is renamed) or skip it. "Do this for all" answers the same for the rest of the import.

import { t } from '../i18n/index.ts';
import type { Duplicate, DuplicateChoice } from '../storage/zipImport.ts';
import { h } from './dom.ts';
import { dialogTitleBar } from './popup.ts';

/** Asks what to do with a duplicate; resolves 'cancel' if the dialog is dismissed (the import stops). */
export function askDuplicate(duplicate: Duplicate): Promise<DuplicateChoice> {
  return new Promise((resolve) => {
    const path = [...duplicate.folders, duplicate.name].join('/');
    const all = h('input', { attrs: { type: 'checkbox' } });
    const button = (text: string) => h('button', { class: 'wm-button', text, attrs: { type: 'button' } });
    const overwrite = button(t('app.importDuplicateOverwrite'));
    const rename = button(t('app.importDuplicateRename'));
    const skip = button(t('app.importDuplicateSkip'));
    const dialog = h('dialog', { class: 'wm-dialog' });
    dialog.append(
      dialogTitleBar(t('app.importDuplicateTitle'), () => dialog.close()),
      h('div', { class: 'wm-dialog-body' }, h('p', { text: t('app.importDuplicateMessage', { name: path }) }), h('label', {}, all, h('span', { text: ` ${t('app.importDuplicateAll')}` }))),
      h('div', { class: 'wm-dialog-buttons' }, skip, rename, overwrite),
    );
    let choice: DuplicateChoice = 'cancel';
    const pick = (action: 'overwrite' | 'rename' | 'skip') => () => {
      choice = { action, all: all.checked };
      dialog.close();
    };
    overwrite.addEventListener('click', pick('overwrite'));
    rename.addEventListener('click', pick('rename'));
    skip.addEventListener('click', pick('skip'));
    // Keys stay in the dialog: the document's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(choice);
    });
    document.body.append(dialog);
    dialog.showModal();
    rename.focus(); // Enter shouldn't destroy anything
  });
}
