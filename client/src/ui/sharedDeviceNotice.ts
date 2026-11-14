// A small note in the bottom right for people who aren't signed in: their documents stay in this
// browser, so on a shared computer they may want to clear them before leaving. Dismissing it
// hides it for good in this browser (until its data is cleared). It waits while only the welcome
// document is showing, since there's nothing of theirs to clear yet.

import { t } from '../i18n/index.ts';
import { CLOSE_ICON, h, iconButton } from './dom.ts';
import { showNotice } from './notice.ts';
import './sharedDeviceNotice.css';

const DISMISSED_KEY = 'golem.sharedDeviceNotice.dismissed';

export class SharedDeviceNotice {
  readonly el = h('aside', { class: 'wm-shared-notice', attrs: { 'aria-label': t('dialogs.sharedDevice.label') } });
  /** Null until the account lookup has finished: the note stays hidden rather than flash for a signed-in person. */
  private signedIn: boolean | null = null;
  private welcome = true;

  constructor(parent: HTMLElement, clear: () => void) {
    const clearButton = h('button', { class: 'wm-button', text: t('dialogs.sharedDevice.clear'), attrs: { type: 'button' } });
    const close = iconButton('wm-shared-notice-close', CLOSE_ICON, t('dialogs.sharedDevice.dismiss'));
    this.el.append(
      close,
      h('p', { text: t('dialogs.sharedDevice.message') }),
      clearButton,
    );
    clearButton.addEventListener('click', clear);
    close.addEventListener('click', () => {
      try {
        localStorage.setItem(DISMISSED_KEY, '1');
      } catch {
        // storage blocked: dismissed for this visit only
      }
      showNotice(this.el, false);
    });
    this.el.hidden = true;
    parent.append(this.el);
  }

  /** Shown once known to be signed out, with a document other than the welcome one open, unless dismissed before. */
  update(state: { signedIn?: boolean; welcome?: boolean }): void {
    this.signedIn = state.signedIn ?? this.signedIn;
    this.welcome = state.welcome ?? this.welcome;
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      // storage blocked: treat as not dismissed
    }
    showNotice(this.el, !(this.signedIn !== false || this.welcome || dismissed));
  }
}
