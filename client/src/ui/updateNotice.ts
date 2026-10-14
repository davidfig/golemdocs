// A note near the bottom when the site has been updated while this page was open, with a button to
// reload into the new version. The page asks now and then (buildCheck.ts), and when a hidden tab comes
// back to the front. It never reloads by itself: "Reload" saves what is open first (the caller's
// `reload`), and "Later" hides the note until the next check finds the site still ahead.

import { CHECK_EVERY_MS, CHECK_MIN_GAP_MS, shouldOfferReload } from '../buildCheck.ts';
import { t } from '../i18n/index.ts';
import { CLOSE_ICON, h, iconButton } from './dom.ts';
import './newVersionNotice.css';

export class UpdateNotice {
  readonly el = h('aside', { class: 'wm-version-notice', attrs: { 'aria-label': t('dialogs.update.label'), role: 'status' } });
  private lastCheck = 0;
  private checking = false;

  constructor(
    parent: HTMLElement,
    private readonly running: string,
    private readonly reload: () => void,
    /** In the desktop app: whether a newer shell is on offer, which makes its own dialog the only message (see `shouldOfferReload`). */
    private readonly shellUpdateOnOffer?: () => Promise<boolean>,
  ) {
    const close = iconButton('wm-version-notice-close', CLOSE_ICON, t('dialogs.update.later'));
    const now = h('button', { class: 'wm-button', text: t('dialogs.update.reload'), attrs: { type: 'button' } });
    const later = h('button', { class: 'wm-version-notice-off', text: t('dialogs.update.later'), attrs: { type: 'button' } });
    this.el.append(close, h('p', { text: t('dialogs.update.message') }), h('div', { class: 'wm-version-notice-actions' }, now, later));
    close.addEventListener('click', () => (this.el.hidden = true));
    later.addEventListener('click', () => (this.el.hidden = true));
    now.addEventListener('click', () => this.reload());
    this.el.hidden = true;
    parent.append(this.el);
    if (running === '') return; // development: there is no build to compare with
    setInterval(() => void this.check(), CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.check();
    });
    // iOS keeps a page alive in its back/forward cache or a suspended tab and brings it back as it was, sometimes without a visibility change.
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) void this.check();
    });
    window.addEventListener('online', () => void this.check());
    // A lazily loaded chunk (a format, a font page) that the new deploy removed can't be fetched by the old page: the page is out of date, whatever build.json says.
    window.addEventListener('vite:preloadError', () => void this.show());
    const footer = document.getElementById('footer');
    if (footer) new ResizeObserver(() => this.el.style.setProperty('--wm-footer-clearance', `${footer.offsetHeight}px`)).observe(footer);
  }

  private async check(): Promise<void> {
    const now = Date.now();
    if (this.checking || now - this.lastCheck < CHECK_MIN_GAP_MS) return;
    this.checking = true;
    this.lastCheck = now;
    try {
      if (await shouldOfferReload(this.running, this.shellUpdateOnOffer)) this.el.hidden = false;
    } finally {
      this.checking = false;
    }
  }

  /** The page knows it is out of date (a chunk is gone), so only the shell's own update can take the place of the note. */
  private async show(): Promise<void> {
    try {
      if (this.shellUpdateOnOffer && (await this.shellUpdateOnOffer())) return;
    } catch {
      /* ask no more: show the note */
    }
    this.el.hidden = false;
  }
}
