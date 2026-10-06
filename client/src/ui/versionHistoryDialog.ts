// File ▸ Version History: the earlier versions of the open document, kept in this browser and (for a document in the account) by the account.
// Opening one makes a new document and leaves this one as it is, so looking back can never lose anything. The rules for what is kept and for
// how long are in history.ts and @golemdocs/ops (versionPolicy.ts); this only shows them.

import { getLocale, t } from '../i18n/index.ts';
import { deleteEntry, loadHistory, renameEntry, saveNamedVersion, type HistoryEntry, type HistoryTarget } from '../history.ts';
import { formatSize } from './dashboardFormat.ts';
import { confirmDelete } from './deleteDialog.ts';
import { h } from './dom.ts';
import { dialogTitleBar } from './popup.ts';

export interface VersionHistoryHost {
  /** The open document as history knows it, or null if it has never been saved (the welcome document, say). */
  target(): HistoryTarget | null;
  /** Whether the person may save, open or change versions (a viewer of a shared document may only look). */
  canEdit(): boolean;
  /** Makes a new document from a version and opens it. Resolves with its name; throws (with a message for the person) if it could not. */
  openVersion(entry: HistoryEntry): Promise<string>;
  /** Says something short to the person (the status bar and a toast). */
  tell(text: string): void;
  focusEditor(): void;
}

const when = (version: number): string => new Date(version).toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' });

export class VersionHistoryDialog {
  private dialog: HTMLDialogElement | null = null;

  constructor(private readonly host: VersionHistoryHost) {}

  open(): void {
    if (this.dialog) return;
    const target = this.host.target();
    const list = h('ul', { class: 'wm-history-list', attrs: { 'aria-label': t('history.title') } });
    const notes = h('div', { class: 'wm-history-notes' });
    const body = h('div', { class: 'wm-dialog-body wm-history-body' }, h('p', { class: 'wm-history-intro', text: t('history.intro') }));

    const close = h('button', { class: 'wm-button', text: t('history.close'), attrs: { type: 'button' } });
    const dialog = h('dialog', { class: 'wm-dialog wm-history', attrs: { 'aria-label': t('history.title') } }, dialogTitleBar(t('history.title'), () => dialog.close()), body, h('div', { class: 'wm-dialog-buttons' }, close));
    // Keys stay in the dialog: the document's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      this.dialog = null;
      this.host.focusEditor();
    });
    this.dialog = dialog;

    if (!target) {
      body.append(h('p', { class: 'wm-history-empty', text: t('history.unsaved') }));
    } else {
      const canEdit = this.host.canEdit();
      if (canEdit) body.append(this.nameRow(target, () => void refresh()));
      else body.append(h('p', { class: 'wm-history-note', text: t('history.viewerNote') }));
      body.append(notes, list);
      let busy = false;
      const refresh = async () => {
        list.replaceChildren(h('li', { class: 'wm-history-empty', text: t('history.loading') }));
        notes.replaceChildren();
        const { entries, unreachable } = await loadHistory(target);
        if (!this.dialog) return;
        for (const source of unreachable) notes.append(h('p', { class: 'wm-history-note wm-history-warning', text: t(source === 'account' ? 'history.accountUnreachable' : 'history.deviceUnreachable') }));
        list.replaceChildren(...(entries.length ? entries.map((entry) => this.row(target, entry, canEdit, () => busy, (v) => (busy = v), () => void refresh())) : [h('li', { class: 'wm-history-empty', text: t('history.empty') })]));
      };
      void refresh();
    }
    document.body.append(dialog);
    dialog.showModal();
  }

  /** The row that keeps the document as it is now under a name. */
  private nameRow(target: HistoryTarget, refresh: () => void): HTMLElement {
    const field = h('input', { class: 'wm-input', attrs: { type: 'text', 'aria-label': t('history.nameLabel'), placeholder: t('history.nameHint'), maxlength: '120', autocomplete: 'off' } });
    const save = h('button', { class: 'wm-button', text: t('history.save'), attrs: { type: 'submit' } });
    save.disabled = true;
    field.addEventListener('input', () => (save.disabled = !field.value.trim()));
    const form = h('form', { class: 'wm-history-name', attrs: { method: 'dialog' } }, h('label', { text: t('history.nameLabel') }), h('div', { class: 'wm-history-name-row' }, field, save));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = field.value.trim();
      if (!name) return;
      save.disabled = true;
      saveNamedVersion(target, name).then(
        () => {
          field.value = '';
          refresh();
        },
        (error: unknown) => {
          this.host.tell(t('history.saveFailed', { message: (error as Error).message }));
          save.disabled = false;
        },
      );
    });
    return form;
  }

  private row(target: HistoryTarget, entry: HistoryEntry, canEdit: boolean, busy: () => boolean, setBusy: (busy: boolean) => void, refresh: () => void): HTMLElement {
    const label = when(entry.version);
    const title = entry.name !== null ? h('span', { class: 'wm-history-name-text', text: entry.name }) : null;
    const meta = h('span', { class: 'wm-history-meta', text: `${label} · ${formatSize(entry.size)}` });
    const source = h('span', { class: 'wm-history-source', text: t(entry.source === 'account' ? 'history.account' : 'history.device') });
    const info = h('div', { class: 'wm-history-info' }, title, meta, source);
    const actions = h('div', { class: 'wm-history-actions' });
    if (canEdit) {
      const open = h('button', { class: 'wm-button', text: t('history.open'), attrs: { type: 'button' } });
      open.addEventListener('click', () => {
        if (busy()) return;
        setBusy(true);
        open.disabled = true;
        this.host.openVersion(entry).then(
          (name) => {
            this.host.tell(t('history.opened', { name }));
            this.dialog?.close();
          },
          (error: unknown) => {
            this.host.tell(t('history.openFailed', { message: (error as Error).message || t('history.gone') }));
            open.disabled = false;
            setBusy(false);
          },
        );
      });
      const rename = h('button', { class: 'wm-button', text: t('history.rename'), attrs: { type: 'button' } });
      rename.addEventListener('click', () => this.editName(target, entry, info, refresh));
      const remove = h('button', { class: 'wm-button', text: t('history.delete'), attrs: { type: 'button' } });
      remove.addEventListener('click', () => {
        void confirmDelete(t('history.deleteTitle'), [entry.name !== null ? `${entry.name} (${label})` : label], this.dialog ?? document.body).then(async (yes) => {
          if (!yes) return;
          await deleteEntry(target, entry).catch((error: unknown) => this.host.tell((error as Error).message));
          refresh();
        });
      });
      actions.append(open, rename, remove);
    }
    return h('li', { class: 'wm-history-row', attrs: { 'aria-label': t('history.rowLabel', { when: label }) } }, info, actions);
  }

  /** Replaces the row's text with a field for the version's name. */
  private editName(target: HistoryTarget, entry: HistoryEntry, info: HTMLElement, refresh: () => void): void {
    const field = h('input', { class: 'wm-input', attrs: { type: 'text', 'aria-label': t('history.renameField'), maxlength: '120', autocomplete: 'off' } });
    field.value = entry.name ?? '';
    const ok = h('button', { class: 'wm-button', text: t('history.renameOk'), attrs: { type: 'button' } });
    const cancel = h('button', { class: 'wm-button', text: t('history.renameCancel'), attrs: { type: 'button' } });
    const done = h('div', { class: 'wm-history-name-row' }, field, ok, cancel);
    info.replaceChildren(done);
    field.focus();
    const commit = () => {
      // Empty lets the version be thinned like the others again.
      renameEntry(target, entry, field.value.trim() || null).then(refresh, (error: unknown) => {
        this.host.tell((error as Error).message);
        refresh();
      });
    };
    ok.addEventListener('click', commit);
    cancel.addEventListener('click', refresh);
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        // Not the dialog's own Escape, which would close it with the name half typed.
        e.preventDefault();
        e.stopPropagation();
        refresh();
      }
    });
  }
}
