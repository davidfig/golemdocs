// Sign-in UI. The app works without an account (documents save in the browser); this only appears
// when the user asks to sign in, or their session ended with changes still to save.

import { availableProviders, signInUrl, takeAuthError } from '../auth.ts';

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
    none.textContent = 'Sign-in is unavailable right now.';
    none.style.margin = '0';
    panel.append(none);
  }
  for (const provider of providers) {
    const link = document.createElement('a');
    link.href = signInUrl(provider.id, returnTo);
    link.textContent = `Continue with ${provider.name}`;
    link.style.cssText = 'padding:8px 14px;border:1px solid var(--wm-border,#888);border-radius:4px;text-align:center;text-decoration:none;color:inherit;background:var(--wm-bar-top,#fff)';
    panel.append(link);
  }
  root.replaceChildren(panel);
}

/** A modal asking the user to sign in. They come back to `returnTo` afterwards. */
export function showSignInDialog(returnTo: string): void {
  const dialog = document.createElement('dialog');
  dialog.style.cssText =
    'border:1px solid var(--wm-border,#888);border-radius:6px;padding:20px;max-width:340px;background:var(--wm-face,#f0f0f0);color:var(--wm-text,#000);font:14px var(--wm-font,system-ui,sans-serif)';

  const title = document.createElement('h2');
  title.textContent = 'Sign in';
  title.style.cssText = 'margin:0 0 8px;font-size:16px';
  const note = document.createElement('p');
  note.textContent = 'Signed in, your documents are saved to your account as you work, and you can open them on any device. The documents you’ve made in this browser come with you. Free while Golem Docs is in early access.';
  note.style.cssText = 'margin:0 0 12px';
  const providers = document.createElement('div');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Not now';
  cancel.style.cssText = 'margin-top:12px;padding:6px 14px';
  cancel.addEventListener('click', () => dialog.close());

  dialog.append(title, note, providers, cancel);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  void mountSignIn(providers, returnTo);
}
