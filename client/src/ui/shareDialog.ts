// Who a cloud document is shared with: the owner adds people by the email they signed in with,
// as editors (who can change the document) or viewers (who can only look, live), and removes them.

import { addShare, listShares, removeShare, type Share, type ShareRole } from '../cloud.ts';
import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import { dialogTitleBar } from './popup.ts';

const roleLabel = (role: ShareRole): string => t(role === 'editor' ? 'dialogs.share.canEdit' : 'dialogs.share.canView');

function roleSelect(value: ShareRole): HTMLSelectElement {
  const select = h('select', { attrs: { 'aria-label': t('dialogs.share.access') } });
  for (const role of ['editor', 'viewer'] as const) {
    const option = h('option', { text: roleLabel(role) });
    option.value = role;
    select.append(option);
  }
  select.value = value;
  return select;
}

/** A modal for sharing the cloud document `doc`. */
export function showShareDialog(doc: { id: string; name: string }): void {
  const dialog = h('dialog', { class: 'wm-dialog wm-share', attrs: { 'aria-label': t('dialogs.share.label', { name: doc.name }) } });
  dialog.style.width = 'min(420px, 90vw)';

  const people = h('div', { attrs: { role: 'list' } });
  people.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:12px 0';
  const message = h('p', { attrs: { role: 'status' } });
  message.style.cssText = 'margin:8px 0 0;min-height:1.2em';

  const email = h('input', { attrs: { type: 'email', placeholder: t('dialogs.share.emailPlaceholder'), 'aria-label': t('dialogs.share.emailLabel'), autocomplete: 'off' } });
  email.style.cssText = 'flex:1;min-width:0;padding:6px';
  const role = roleSelect('editor');
  const add = h('button', { text: t('dialogs.share.share'), attrs: { type: 'submit' } });
  const form = h('form', {}, email, role, add);
  form.style.cssText = 'display:flex;gap:6px';

  const say = (text: string, error = false) => {
    message.textContent = text;
    message.style.color = error ? '#b00020' : 'inherit';
  };

  const row = (share: Share): HTMLElement => {
    const label = h('span', { text: share.name && share.email ? t('dialogs.share.person', { name: share.name, email: share.email }) : (share.email ?? share.name ?? t('dialogs.share.unknown')) });
    label.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const access = roleSelect(share.role);
    access.addEventListener('change', () => {
      if (!share.email) return;
      addShare(doc.id, share.email, access.value as ShareRole).then(
        () => say(''),
        (error: Error) => say(error.message, true),
      );
    });
    const remove = h('button', { text: t('dialogs.share.remove'), attrs: { type: 'button' } });
    remove.addEventListener('click', () => {
      remove.disabled = true;
      removeShare(doc.id, share.userId).then(
        () => void refresh(),
        (error: Error) => {
          remove.disabled = false;
          say(error.message, true);
        },
      );
    });
    const el = h('div', { attrs: { role: 'listitem' } }, label, access, remove);
    el.style.cssText = 'display:flex;gap:6px;align-items:center';
    return el;
  };

  async function refresh(): Promise<void> {
    try {
      const shares = await listShares(doc.id);
      people.replaceChildren(...(shares.length ? shares.map(row) : [h('p', { text: t('dialogs.share.nobody') })]));
    } catch (error) {
      say((error as Error).message, true);
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const address = email.value.trim();
    if (!address) return;
    add.disabled = true;
    addShare(doc.id, address, role.value as ShareRole).then(
      () => {
        email.value = '';
        say('');
        return refresh();
      },
      (error: Error) => say(error.message, true),
    ).finally(() => (add.disabled = false));
  });

  const done = h('button', { text: t('dialogs.share.done'), attrs: { type: 'button' } });
  done.style.cssText = 'margin-top:12px;padding:6px 14px';
  done.addEventListener('click', () => dialog.close());

  const note = h('p', { text: t('dialogs.share.note') });
  note.style.margin = '0';

  const body = h('div', { class: 'wm-dialog-body' }, note, people, form, message, done);
  body.style.paddingBottom = '14px';
  dialog.append(dialogTitleBar(t('dialogs.share.title', { name: doc.name }), () => dialog.close()), body);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  void refresh();
}
