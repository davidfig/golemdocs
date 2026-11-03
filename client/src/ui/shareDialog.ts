// Sharing, in one dialog: for a cloud document, the people it is shared with: the owner adds them by
// the email they signed in with, as editors (who can change the document) or viewers (who can only
// look: they open it in the read-only viewer, docs/architecture/viewer.md), and removes them; and its public link, which anyone may
// open in that viewer without signing in, or embed in another website.

import { addShare, listShares, publicLink, publicLinkUrl, removeShare, type Share, type ShareRole } from '../cloud.ts';
import { t } from '../i18n/index.ts';
import { avatar } from './avatar.ts';
import { writeClipboardText } from './clipboard.ts';
import { h, segmented } from './dom.ts';
import { dialogTitleBar } from './popup.ts';

/** Can edit | Can view: the shared segmented control, set to `value`, with `pick` told of a change. */
function roleChoice(value: ShareRole, pick: (role: ShareRole) => void): { el: HTMLElement; set(role: ShareRole): void } {
  const choice = segmented<ShareRole>(
    t('dialogs.share.access'),
    [
      { value: 'editor', text: t('dialogs.share.canEdit') },
      { value: 'viewer', text: t('dialogs.share.canView') },
    ],
    (role) => {
      choice.set(role);
      pick(role);
    },
  );
  choice.set(value);
  return choice;
}

export interface ShareTarget {
  name: string;
  /** The cloud document to share with people by email, or why that can't be done. */
  people: { id: string } | { unavailable: string };
}

const section = (heading: string, ...content: (HTMLElement | null)[]): HTMLElement => {
  const title = h('h3', { text: heading });
  title.style.cssText = 'margin:14px 0 6px;font-size:1em';
  // Named by its heading, so each section's status line can be told apart (People, Public link).
  return h('section', { attrs: { 'aria-label': heading } }, title, ...content);
};

/** The embed code for a public link: a frame of the viewer, sized like a page column. */
export const embedCode = (url: string, title: string): string =>
  `<iframe src="${url.replace(/&/g, '&amp;')}" title="${title.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" width="800" height="600" style="border:0" allowfullscreen></iframe>`;

/** The public link: a switch, and while it is on, the address, Copy Link, Copy Embed Code and Reset Link. */
function publicSection(id: string, name: string): HTMLElement {
  const toggle = h('input', { attrs: { type: 'checkbox' } });
  const address = h('input', { class: 'wm-input', attrs: { type: 'text', readonly: '', 'aria-label': t('dialogs.share.publicLinkLabel') } });
  address.style.cssText = 'flex:1;min-width:0;margin:0';
  address.addEventListener('focus', () => address.select());
  const copyLink = h('button', { class: 'wm-button', text: t('dialogs.share.copyLink'), attrs: { type: 'button' } });
  const copyEmbed = h('button', { class: 'wm-button', text: t('dialogs.share.copyEmbed'), attrs: { type: 'button' } });
  const reset = h('button', { class: 'wm-button', text: t('dialogs.share.resetLink'), attrs: { type: 'button', title: t('dialogs.share.resetNote') } });
  const linkRow = h('div', {}, address, copyLink);
  linkRow.style.cssText = 'display:flex;gap:6px;margin-top:8px';
  const moreRow = h('div', {}, copyEmbed, reset);
  moreRow.style.cssText = 'display:flex;gap:6px;margin-top:6px';
  const message = h('p', { attrs: { role: 'status' } });
  message.style.cssText = 'margin:8px 0 0;min-height:1.2em';
  const say = (text: string, error = false) => {
    message.textContent = text;
    message.style.color = error ? 'var(--wm-error)' : 'inherit';
  };

  let token: string | null = null;
  const show = (next: string | null) => {
    token = next;
    toggle.checked = !!token;
    // Their inline `display: flex` would win over `hidden`.
    for (const row of [linkRow, moreRow]) row.style.display = token ? 'flex' : 'none';
    address.value = token ? publicLinkUrl(token) : '';
  };
  show(null);
  const controls = [toggle, copyLink, copyEmbed, reset];
  const change = (to: 'make' | 'reset' | 'off') => {
    for (const c of controls) c.disabled = true;
    publicLink(id, to).then(
      (next) => {
        show(next);
        say('');
      },
      (error: Error) => {
        show(token); // it didn't change
        say(error.message, true);
      },
    ).finally(() => {
      for (const c of controls) c.disabled = false;
    });
  };
  toggle.addEventListener('change', () => change(toggle.checked ? 'make' : 'off'));
  reset.addEventListener('click', () => change('reset'));
  const copy = (text: string) => writeClipboardText(text).then(() => say(t('dialogs.share.copied')), (error: Error) => say(error.message, true));
  copyLink.addEventListener('click', () => token && void copy(publicLinkUrl(token)));
  copyEmbed.addEventListener('click', () => token && void copy(embedCode(publicLinkUrl(token, true), t('dialogs.share.embedTitle', { name }))));
  publicLink(id).then(show, (error: Error) => say(error.message, true));

  const note = h('p', { text: t('dialogs.share.publicNote') });
  note.style.margin = '0 0 8px';
  return section(t('dialogs.share.publicHeading'), note, h('label', { class: 'wm-find-case' }, toggle, t('dialogs.share.publicToggle')), linkRow, moreRow, message);
}

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

  const email = h('input', { class: 'wm-input', attrs: { type: 'email', placeholder: t('dialogs.share.emailPlaceholder'), 'aria-label': t('dialogs.share.emailLabel'), autocomplete: 'off' } });
  email.style.cssText = 'flex:1;min-width:0;margin:0';
  let role: ShareRole = 'editor';
  const roleFor = roleChoice(role, (next) => (role = next));
  const add = h('button', { class: 'wm-button', text: t('dialogs.share.share'), attrs: { type: 'submit' } });
  const form = h('form', {}, email, roleFor.el, add);
  form.style.cssText = 'display:flex;gap:6px';

  const say = (text: string, error = false) => {
    message.textContent = text;
    message.style.color = error ? 'var(--wm-error)' : 'inherit';
  };

  const row = (share: Share): HTMLElement => {
    const label = h('span', { text: share.name && share.email ? t('dialogs.share.person', { name: share.name, email: share.email }) : (share.email ?? share.name ?? t('dialogs.share.unknown')) });
    label.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const access = roleChoice(share.role, (next) => {
      if (!share.email) return access.set(share.role);
      addShare(personId, share.email, next).then(
        () => {
          share.role = next;
          say('');
        },
        (error: Error) => {
          // It didn't change: show the access they still have.
          access.set(share.role);
          say(error.message, true);
        },
      );
    });
    const remove = h('button', { class: 'wm-button', text: t('dialogs.share.remove'), attrs: { type: 'button' } });
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
    const el = h('div', { attrs: { role: 'listitem' } }, avatar(share.picture, share.name ?? share.email, 24), label, access.el, remove);
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
    addShare(personId, address, role).then(
      () => {
        email.value = '';
        say('');
        return refresh();
      },
      (error: Error) => say(error.message, true),
    ).finally(() => (add.disabled = false));
  });

  const done = h('button', { class: 'wm-button', text: t('dialogs.share.done'), attrs: { type: 'button' } });
  done.style.marginTop = '16px';
  done.addEventListener('click', () => dialog.close());

  const note = h('p', { text: t('dialogs.share.note') });
  note.style.margin = '0';

  const peopleSection =
    'id' in target.people
      ? section(t('dialogs.share.peopleHeading'), note, people, form, message)
      : section(t('dialogs.share.peopleHeading'), h('p', { text: target.people.unavailable }));
  const body = h('div', { class: 'wm-dialog-body' }, peopleSection, 'id' in target.people ? publicSection(target.people.id, doc.name) : null, done);
  body.style.paddingBottom = '14px';
  dialog.append(dialogTitleBar(t('dialogs.share.title', { name: doc.name }), () => dialog.close()), body);
  // Keys stay in the dialog: the document's handlers listen on the window.
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  if ('id' in target.people) void refresh();
}
