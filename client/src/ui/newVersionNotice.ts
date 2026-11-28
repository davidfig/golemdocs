// A toast after an update: "Updated to Golem Docs X", with What's New a click away. It shows once per version and goes by itself after a
// while (not while the pointer or the keyboard is on it, nor in Screen Reader Mode). The first run on a device only records the version,
// so a new visitor isn't told about a release they never missed. Someone who once chose "Don't show again" (a synced preference, see
// settingsSync.ts) still isn't shown it.

import { version } from '../../../package.json';
import { t } from '../i18n/index.ts';
import { screenReaderOn } from './screenReader.ts';
import { type UpdateToast, updateToast } from './updateToast.ts';

const SEEN_KEY = 'golem.newVersion.seen';
const OFF_KEY = 'golem.newVersion.off';
/** How long the toast stays up untouched. */
const SHOWN_MS = 12_000;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage blocked: hidden for this visit only
  }
}

export class NewVersionNotice {
  private readonly toast: UpdateToast;
  readonly el: HTMLElement;
  private timer = 0;

  constructor(parent: HTMLElement, openChangelog: () => void) {
    this.toast = updateToast(parent, t('dialogs.newVersion.label'), t('dialogs.newVersion.close'), 'success');
    this.el = this.toast.el;
    this.toast.message.textContent = t('dialogs.newVersion.message', { version });
    this.toast.action(t('dialogs.newVersion.view')).addEventListener('click', () => {
      this.toast.show(false);
      openChangelog();
    });
    this.toast.close.addEventListener('click', () => this.toast.show(false));
    // Held while the pointer or the keyboard is on it; the clock starts again once both have left.
    const hold = () => clearTimeout(this.timer);
    const release = () => {
      if (!this.el.matches(':hover') && !this.el.contains(document.activeElement)) this.arm();
    };
    this.el.addEventListener('pointerenter', hold);
    this.el.addEventListener('focusin', hold);
    this.el.addEventListener('pointerleave', release);
    this.el.addEventListener('focusout', () => setTimeout(release));

    const first = read(SEEN_KEY) === null;
    const isNew = !first && read(SEEN_KEY) !== version;
    write(SEEN_KEY, version);
    if (isNew && read(OFF_KEY) !== '1') {
      this.toast.show(true);
      this.arm();
    }
  }

  private arm(): void {
    clearTimeout(this.timer);
    if (this.el.hidden || screenReaderOn()) return;
    this.timer = window.setTimeout(() => this.toast.show(false), SHOWN_MS);
  }

  /** "Don't show again" came from the account: the toast goes, if it is showing. */
  rereadOff(): void {
    if (read(OFF_KEY) === '1') this.toast.show(false);
  }
}
