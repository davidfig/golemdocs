// Help > Send Feedback (anyone) and Admin > Feedback (admins): the dialog that sends a message to
// the admins, and the list they read, both over the server's /api/feedback endpoints.

import { getLocale, t } from '../i18n/index.ts';
import { h } from './dom.ts';
import { showConfirm } from './popup.ts';

const MAX_CHARS = 5000;

async function failure(response: Response): Promise<string> {
  if (response.status === 401) return t('panels.feedback.signIn');
  const error = ((await response.json().catch(() => null)) as { error?: string } | null)?.error;
  return error ?? t('panels.feedback.status', { status: response.status });
}

/** Asks for feedback and sends it. Resolves true once it has been sent, false on Cancel. */
export function showFeedbackDialog(): Promise<boolean> {
  return new Promise((resolve) => {
    const message = h('textarea', { class: 'wm-input wm-feedback-text', attrs: { rows: '14', maxlength: String(MAX_CHARS), 'aria-label': t('panels.feedback.label'), spellcheck: 'true' } });
    const status = h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });
    const send = h('button', { class: 'wm-button', text: t('panels.feedback.send'), attrs: { type: 'submit' } });
    const cancel = h('button', { class: 'wm-button', text: t('panels.feedback.cancel'), attrs: { type: 'button' } });
    const close = h('button', { class: 'wm-dialog-close', text: '×', attrs: { type: 'button', 'aria-label': t('panels.feedback.cancel') } });
    const form = h(
      'form',
      { attrs: { method: 'dialog' } },
      h('div', { class: 'wm-dialog-body wm-feedback' }, h('label', { text: t('panels.feedback.prompt') }), message, status),
      h('div', { class: 'wm-dialog-buttons' }, send, cancel),
    );
    const title = t('panels.feedback.title');
    const dialog = h('dialog', { class: 'wm-dialog wm-feedback-dialog', attrs: { 'aria-label': title } }, h('div', { class: 'wm-dialog-title' }, h('span', { text: title }), close), form);

    let sent = false;
    let busy = false;
    // While it is being sent nothing can send it again or close the dialog on it.
    const sending = (on: boolean) => {
      busy = on;
      send.disabled = cancel.disabled = close.disabled = on;
    };
    dialog.addEventListener('cancel', (e) => {
      if (busy) e.preventDefault();
    });
    // Keys stay in the dialog: the document's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    close.addEventListener('click', () => dialog.close());
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = message.value.trim();
      if (!text) {
        status.textContent = t('panels.feedback.empty');
        message.focus();
        return;
      }
      sending(true);
      status.textContent = '';
      void (async () => {
        try {
          const response = await fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: text }) });
          if (!response.ok) throw new Error(await failure(response));
          sent = true;
          dialog.close();
        } catch (error) {
          status.textContent = t('panels.feedback.failed', { reason: error instanceof Error ? error.message : String(error) });
          sending(false);
        }
      })();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(sent);
    });
    document.body.append(dialog);
    dialog.showModal();
    message.focus();
  });
}

interface Entry {
  id: number;
  message: string;
  createdAt: number;
  resolvedAt: number | null;
  from: { name: string | null; email: string | null } | null;
}

/** The body of Admin > Feedback: everything people have sent, newest first. */
export function feedbackPanel(): HTMLElement {
  const body = h('div', { class: 'wm-feedback-list' }, h('p', { text: t('panels.feedback.loading') }));
  void load(body);
  return body;
}

async function load(body: HTMLElement): Promise<void> {
  try {
    const response = await fetch('/api/admin/feedback');
    if (!response.ok) throw new Error(await failure(response));
    render(body, (await response.json()) as Entry[]);
  } catch (error) {
    body.replaceChildren(h('p', { class: 'wm-billing-error', text: t('panels.feedback.loadFailed', { reason: error instanceof Error ? error.message : String(error) }) }));
  }
}

function render(body: HTMLElement, entries: Entry[]): void {
  if (!entries.length) {
    body.replaceChildren(h('p', { text: t('panels.feedback.none') }));
    return;
  }
  body.replaceChildren(...entries.map((entry) => row(body, entry)));
}

function row(body: HTMLElement, entry: Entry): HTMLElement {
  const who = (entry.from ? [entry.from.name, entry.from.email].filter(Boolean).join(' · ') : '') || t('panels.feedback.unknown');
  const error = h('span', { class: 'wm-billing-error', attrs: { role: 'alert' } });
  const button = (label: string, act: () => Promise<Response | null>) => {
    const el = h('button', { class: 'wm-button', text: label, attrs: { type: 'button' } });
    el.addEventListener('click', () => {
      el.disabled = true;
      error.textContent = '';
      void act()
        .then(async (response) => {
          if (response && !response.ok) throw new Error(await failure(response));
          if (response) await load(body);
        })
        .catch((e: unknown) => (error.textContent = t('panels.feedback.failed', { reason: e instanceof Error ? e.message : String(e) })))
        .finally(() => (el.disabled = false));
    });
    return el;
  };
  const url = `/api/admin/feedback/${entry.id}`;
  const resolve = button(entry.resolvedAt ? t('panels.feedback.reopen') : t('panels.feedback.resolve'), () =>
    fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resolved: !entry.resolvedAt }) }),
  );
  const remove = button(t('panels.feedback.delete'), async () => {
    const yes = await showConfirm(t('panels.feedback.deleteTitle'), h('p', { text: t('panels.feedback.deleteAsk') }), t('panels.feedback.delete'));
    return yes ? fetch(url, { method: 'DELETE' }) : null;
  });
  return h(
    'article',
    { class: entry.resolvedAt ? 'wm-feedback-entry resolved' : 'wm-feedback-entry' },
    h(
      'header',
      {},
      h('strong', { text: who }),
      h('time', { text: new Date(entry.createdAt).toLocaleString(getLocale()) }),
    ),
    // textContent, so whatever people typed is shown as text and never parsed.
    h('p', { class: 'wm-feedback-message', text: entry.message }),
    h('footer', {}, entry.resolvedAt ? h('span', { class: 'wm-feedback-badge', text: t('panels.feedback.resolved') }) : h('span'), error, h('span', { class: 'wm-feedback-actions' }, resolve, remove)),
  );
}
