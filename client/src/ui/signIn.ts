// Sign-in UI. The app works without an account (documents save in the browser); this only appears
// when the user asks to sign in, or their session ended with changes still to save.

import { availableProviders, signInUrl, takeAuthError } from '../auth.ts';
import { t } from '../i18n/index.ts';
import { dialogTitleBar } from './popup.ts';

/** One button per available provider. Signing in comes back to `returnTo` (a path on this site). */
export async function mountSignIn(root: HTMLElement, returnTo?: string): Promise<void> {
  const panel = document.createElement('div');
  panel.style.cssText = 'display:flex;flex-direction:column;gap:8px';

  const error = takeAuthError();
  if (error) {
    const message = document.createElement('p');
    message.setAttribute('role', 'alert');
    message.textContent = error;
    message.style.cssText = 'margin:0;color:#b00020';
    panel.append(message);
  }

  const providers = await availableProviders().catch(() => []);
  if (providers.length === 0) {
    const none = document.createElement('p');
    none.textContent = t('dialogs.signIn.unavailable');
    none.style.margin = '0';
    panel.append(none);
  }
  for (const provider of providers) {
    const link = document.createElement('a');
    link.href = signInUrl(provider.id, returnTo);
    link.textContent = t('dialogs.signIn.continueWith', { provider: provider.name });
    link.style.cssText = 'padding:8px 14px;border:1px solid var(--wm-border,#888);border-radius:4px;text-align:center;text-decoration:none;color:inherit;background:var(--wm-bar-top,#fff)';
    panel.append(link);
  }
  root.replaceChildren(panel);
}

/**
 * A modal asking the user to sign in. They come back to `returnTo` afterwards. `subscribe`: they
 * asked to pay for sync, so it says they go on to checkout after signing in.
 */
export function showSignInDialog(returnTo: string, options: { subscribe?: boolean } = {}): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'wm-dialog';
  dialog.style.maxWidth = '380px';

  const note = document.createElement('p');
  note.textContent = options.subscribe ? t('dialogs.signIn.subscribeNote') : t('dialogs.signIn.note');
  note.style.cssText = 'margin:0 0 12px';
  const providers = document.createElement('div');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = t('dialogs.signIn.notNow');
  cancel.style.cssText = 'margin-top:12px;padding:6px 14px';
  cancel.addEventListener('click', () => dialog.close());

  const body = document.createElement('div');
  body.className = 'wm-dialog-body';
  body.style.paddingBottom = '14px';
  body.append(note, providers, cancel);
  dialog.append(dialogTitleBar(t('dialogs.signIn.title'), () => dialog.close()), body);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  void mountSignIn(providers, returnTo);
}
