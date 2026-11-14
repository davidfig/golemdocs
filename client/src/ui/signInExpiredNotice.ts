// A note for someone whose sign-in ran out: their account's documents drop out of view until they
// sign in again, which looks as if they are gone, so it says they are safe and offers the way back.
// It names the account, as signing in with a different one would show an empty list. Closing it
// ends it for this visit, and `closed` lets the caller forget the lapse too (auth.ts).

import type { User } from '../auth.ts';
import { t } from '../i18n/index.ts';
import { CLOSE_ICON, h, iconButton, keepAboveFooter } from './dom.ts';
import { showNotice } from './notice.ts';
import './newVersionNotice.css';

export class SignInExpiredNotice {
  readonly el = h('aside', { class: 'wm-version-notice wm-signin-notice', attrs: { 'aria-label': t('dialogs.signInExpired.label') } });
  private readonly message = h('p');
  private dismissed = false;

  constructor(parent: HTMLElement, signIn: () => void, closed: () => void) {
    const close = iconButton('wm-version-notice-close', CLOSE_ICON, t('dialogs.signInExpired.close'));
    const again = h('button', { class: 'wm-button', text: t('dialogs.sync.signIn'), attrs: { type: 'button' } });
    this.el.append(close, this.message, h('div', { class: 'wm-version-notice-actions' }, again));
    again.addEventListener('click', signIn);
    close.addEventListener('click', () => {
      this.dismissed = true;
      showNotice(this.el, false);
      closed();
    });
    this.el.hidden = true;
    parent.append(this.el);
    keepAboveFooter(this.el);
  }

  /** `account`: whose sign-in has run out, if anyone's. */
  update(account: User | null): void {
    if (account) {
      const name = account.email ?? account.name;
      this.message.textContent = name ? t('dialogs.signInExpired.messageFor', { account: name }) : t('dialogs.signInExpired.message');
    }
    showNotice(this.el, !!account && !this.dismissed);
  }
}
