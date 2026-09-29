// Who a cloud document is shared with: the owner adds people by the email they signed in with,
// as editors (who can change the document) or viewers (who can only look, live), and removes them.

import { addShare, listShares, removeShare, type Share, type ShareRole } from '../cloud.ts';
import { h } from './dom.ts';

const ROLE_LABEL: Record<ShareRole, string> = { editor: 'Can edit', viewer: 'Can view' };

function roleSelect(value: ShareRole): HTMLSelectElement {
  const select = h('select', { attrs: { 'aria-label': 'Access' } });
  for (const role of ['editor', 'viewer'] as const) {
    const option = h('option', { text: ROLE_LABEL[role] });
    option.value = role;
    select.append(option);
  }
  select.value = value;
  return select;
}

/** A modal for sharing the cloud document `doc`. */
export function showShareDialog(doc: { id: string; name: string }): void {
  const dialog = h('dialog', { class: 'wm-share', attrs: { 'aria-label': `Share ${doc.name}` } });
  dialog.style.cssText =
    'border:1px solid var(--wm-border,#888);border-radius:6px;padding:20px;width:min(420px,90vw);background:var(--wm-face,#f0f0f0);color:var(--wm-text,#000);font:14px var(--wm-font,system-ui,sans-serif)';

  const people = h('div', { attrs: { role: 'list' } });
  people.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:12px 0';
  const message = h('p', { attrs: { role: 'status' } });
  message.style.cssText = 'margin:8px 0 0;min-height:1.2em';

  const email = h('input', { attrs: { type: 'email', placeholder: 'Their email address', 'aria-label': 'Email address', autocomplete: 'off' } });
  email.style.cssText = 'flex:1;min-width:0;padding:6px';
  const role = roleSelect('editor');
  const add = h('button', { text: 'Share', attrs: { type: 'submit' } });
  const form = h('form', {}, email, role, add);
  form.style.cssText = 'display:flex;gap:6px';

  const say = (text: string, error = false) => {
    message.textContent = text;
    message.style.color = error ? '#b00020' : 'inherit';
  };

  const row = (share: Share): HTMLElement => {
    const label = h('span', { text: share.name && share.email ? `${share.name} (${share.email})` : (share.email ?? share.name ?? 'Unknown') });
    label.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const access = roleSelect(share.role);
    access.addEventListener('change', () => {
      if (!share.email) return;
      addShare(doc.id, share.email, access.value as ShareRole).then(
        () => say(''),
        (error: Error) => say(error.message, true),
      );
    });
    const remove = h('button', { text: 'Remove', attrs: { type: 'button' } });
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
      people.replaceChildren(...(shares.length ? shares.map(row) : [h('p', { text: 'Not shared with anyone yet.' })]));
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

  const done = h('button', { text: 'Done', attrs: { type: 'button' } });
  done.style.cssText = 'margin-top:12px;padding:6px 14px';
  done.addEventListener('click', () => dialog.close());

  const title = h('h2', { text: `Share “${doc.name}”` });
  title.style.cssText = 'margin:0 0 4px;font-size:16px;overflow-wrap:anywhere';
  const note = h('p', { text: 'People need to have signed in to Golem Docs once. Editors and viewers see changes live.' });
  note.style.margin = '0';

  dialog.append(title, note, people, form, message, done);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  void refresh();
}
