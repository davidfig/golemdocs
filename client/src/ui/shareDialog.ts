// Sharing, in one dialog: for a cloud document, the people it is shared with: the owner adds them by
// the email they signed in with, as editors (who can change the document) or viewers (who can only
// look, live), and removes them.

import { addShare, listShares, removeShare, type Share, type ShareRole } from '../cloud.ts';
import { t } from '../i18n/index.ts';
import { avatar } from './avatar.ts';
import { h } from './dom.ts';
import { dialogTitleBar } from './popup.ts';

const roleLabel = (role: ShareRole): string => t(role === 'editor' ? 'dialogs.share.canEdit' : 'dialogs.share.canView');

function roleSelect(value: ShareRole): HTMLSelectElement {
  const select = h('select', { class: 'wm-select', attrs: { 'aria-label': t('dialogs.share.access') } });
  for (const role of ['editor', 'viewer'] as const) {
    const option = h('option', { text: roleLabel(role) });
    option.value = role;
    select.append(option);
  }
  select.value = value;
  return select;
}

export interface ShareTarget {
  name: string;
  /** The cloud document to share with people by email, or why that can't be done. */
  people: { id: string } | { unavailable: string };
}

const section = (heading: string, ...content: (HTMLElement | null)[]): HTMLElement => {
  const title = h('h3', { text: heading });
  title.style.cssText = 'margin:14px 0 6px;font-size:1em';
  return h('section', {}, title, ...content);
};

/** A modal for sharing the open document with people. */
export function showShareDialog(target: ShareTarget): void {
  const doc = { name: target.name };
  const dialog = h('dialog', { class: 'wm-dialog wm-share', attrs: { 'aria-label': t('dialogs.share.label', { name: doc.name }) } });
  dialog.style.width = 'min(460px, 90vw)';

  const personId = 'id' in target.people ? target.people.id : '';
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
    message.style.color = error ? 'var(--wm-error)' : 'inherit';
  };

  const row = (share: Share): HTMLElement => {
    const label = h('span', { text: share.name && share.email ? t('dialogs.share.person', { name: share.name, email: share.email }) : (share.email ?? share.name ?? t('dialogs.share.unknown')) });
    label.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const access = roleSelect(share.role);
    access.addEventListener('change', () => {
      if (!share.email) return;
      const next = access.value as ShareRole;
      addShare(personId, share.email, next).then(
        () => {
          share.role = next;
          say('');
        },
        (error: Error) => {
          // It didn't change: show the access they still have.
          access.value = share.role;
          say(error.message, true);
        },
      );
    });
    const remove = h('button', { text: t('dialogs.share.remove'), attrs: { type: 'button' } });
    remove.addEventListener('click', () => {
      remove.disabled = true;
      removeShare(personId, share.userId).then(
        () => void refresh(),
        (error: Error) => {
          remove.disabled = false;
          say(error.message, true);
        },
      );
    });
    const el = h('div', { attrs: { role: 'listitem' } }, avatar(share.picture, share.name ?? share.email, 24), label, access, remove);
    el.style.cssText = 'display:flex;gap:6px;align-items:center';
    return el;
  };

  async function refresh(): Promise<void> {
    try {
      const shares = await listShares(personId);
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
    addShare(personId, address, role.value as ShareRole).then(
      () => {
        email.value = '';
        say('');
        return refresh();
      },
      (error: Error) => say(error.message, true),
    ).finally(() => (add.disabled = false));
  });

  const done = h('button', { text: t('dialogs.share.done'), attrs: { type: 'button' } });
  done.style.cssText = 'margin-top:16px;padding:6px 14px';
  done.addEventListener('click', () => dialog.close());

  const note = h('p', { text: t('dialogs.share.note') });
  note.style.margin = '0';

  const peopleSection =
    'id' in target.people
      ? section(t('dialogs.share.peopleHeading'), note, people, form, message)
      : section(t('dialogs.share.peopleHeading'), h('p', { text: target.people.unavailable }));
  const body = h('div', { class: 'wm-dialog-body' }, peopleSection, done);
  body.style.paddingBottom = '14px';
  dialog.append(dialogTitleBar(t('dialogs.share.title', { name: doc.name }), () => dialog.close()), body);
  // Keys stay in the dialog: the document's handlers listen on the window.
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  if ('id' in target.people) void refresh();
}
