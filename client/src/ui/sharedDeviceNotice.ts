// A small note in the bottom right for people who aren't signed in: their documents stay in this
// browser, so on a shared computer they may want to clear them before leaving. Dismissing it
// hides it for good in this browser (until its data is cleared).

import { h } from './dom.ts';
import './sharedDeviceNotice.css';

const DISMISSED_KEY = 'golem.sharedDeviceNotice.dismissed';

export class SharedDeviceNotice {
  readonly el = h('aside', { class: 'wm-shared-notice', attrs: { 'aria-label': 'Shared computer' } });

  constructor(parent: HTMLElement, clear: () => void) {
    const clearButton = h('button', { class: 'wm-button', text: 'Clear Local Data…', attrs: { type: 'button' } });
    const close = h('button', { class: 'wm-shared-notice-close', text: '×', attrs: { type: 'button', 'aria-label': 'Dismiss' } });
    this.el.append(
      close,
      h('p', { text: 'Your documents are saved in this browser. On a shared computer, clear them when you’re done.' }),
      clearButton,
    );
    clearButton.addEventListener('click', clear);
    close.addEventListener('click', () => {
      try {
        localStorage.setItem(DISMISSED_KEY, '1');
      } catch {
        // storage blocked: dismissed for this visit only
      }
      this.el.hidden = true;
    });
    this.el.hidden = true;
    parent.append(this.el);
  }

  /** Shown while signed out, unless dismissed before. */
  update(signedIn: boolean): void {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      // storage blocked: treat as not dismissed
    }
    this.el.hidden = signedIn || dismissed;
  }
}
