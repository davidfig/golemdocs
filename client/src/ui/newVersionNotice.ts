// A note in the bottom left when a new version has been released, with a button to What's New.
// Closing it hides it until the next release; "Don't show again" turns it off for good (a synced
// preference, see settingsSync.ts). The first run on a device only records the version, so a new
// visitor isn't told about a release they never missed.

import { version } from '../../../package.json';
import { t } from '../i18n/index.ts';
import { CLOSE_ICON, h, iconButton } from './dom.ts';
import './newVersionNotice.css';

const SEEN_KEY = 'golem.newVersion.seen';
const OFF_KEY = 'golem.newVersion.off';

/** TESTING: shows the note on every start, whatever was seen or turned off. Set to false before release. */
const ALWAYS_SHOW = true;

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
  readonly el = h('aside', { class: 'wm-version-notice', attrs: { 'aria-label': t('dialogs.newVersion.label') } });

  constructor(parent: HTMLElement, openChangelog: () => void) {
    const close = iconButton('wm-version-notice-close', CLOSE_ICON, t('dialogs.newVersion.close'));
    const view = h('button', { class: 'wm-button', text: t('dialogs.newVersion.view'), attrs: { type: 'button' } });
    const hide = h('button', { class: 'wm-version-notice-off', text: t('dialogs.newVersion.off'), attrs: { type: 'button' } });
    this.el.append(close, h('p', { text: t('dialogs.newVersion.message', { version }) }), h('div', { class: 'wm-version-notice-actions' }, view, hide));
    close.addEventListener('click', () => (this.el.hidden = true));
    view.addEventListener('click', () => {
      this.el.hidden = true;
      openChangelog();
    });
    hide.addEventListener('click', () => {
      write(OFF_KEY, '1');
      this.el.hidden = true;
    });
    const first = read(SEEN_KEY) === null;
    const isNew = !first && read(SEEN_KEY) !== version;
    write(SEEN_KEY, version);
    this.el.hidden = !(ALWAYS_SHOW || (isNew && read(OFF_KEY) !== '1'));
    parent.append(this.el);
    // Sits above the status bar when it is showing: the page's bottom edge is the bar's top edge.
    const footer = document.getElementById('footer');
    if (footer) new ResizeObserver(() => this.el.style.setProperty('--wm-footer-clearance', `${footer.offsetHeight}px`)).observe(footer);
  }
}
