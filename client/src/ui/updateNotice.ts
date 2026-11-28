// A toast near the bottom (updateToast.ts) when there is something newer than what is running, with a button to move to it. The page asks now and then
// (buildCheck.ts), when a hidden tab comes back to the front and when it goes back online. In the desktop app the same check asks the
// app too, so a new app and a new site are one note at the same times: a new app says Restart to update (which loads the new site
// too), a new site alone says Reload. Nothing happens by itself (Update automatically, desktop/autoUpdate.ts, is the person's own
// choice): both save what is open first. Closing it is "Later": it hides the note until the next check finds an update still waiting; for a
// new app it puts that version off for a few hours (updateService.ts `snooze`), and only a new site is offered meanwhile.

import { CHECK_EVERY_MS, CHECK_MIN_GAP_MS, updateToOffer } from '../buildCheck.ts';
import { t } from '../i18n/index.ts';
import { type UpdateToast, updateToast } from './updateToast.ts';

/** The desktop app's own updates, as the note needs them. */
export interface AppUpdates {
  /** Whether a newer version of the app is waiting that the note may offer (not one put off with Later). */
  check(): Promise<boolean>;
  /** The version `check` found, for the note to name. */
  version(): string | undefined;
  /** "Later" on a new app: put it off for a while. */
  snooze(): void;
  /** Saves, installs it and restarts; it only comes back if the install failed. */
  install(): Promise<void>;
}

/** How soon after the app starts it asks about its own update (the site it just loaded is current). */
const FIRST_APP_CHECK_MS = 10_000;

export class UpdateNotice {
  private readonly toast: UpdateToast;
  readonly el: HTMLElement;
  private readonly message: HTMLParagraphElement;
  private readonly now: HTMLButtonElement;
  private readonly later: HTMLButtonElement;
  private kind: 'app' | 'site' = 'site';
  private lastCheck = 0;
  private checking = false;

  constructor(
    parent: HTMLElement,
    private readonly running: string,
    private readonly reload: () => void,
    /** In the desktop app: its own updates, told in this same note. */
    private readonly app?: AppUpdates,
  ) {
    // The close button is Later: it hides the note, and for a new app puts that version off for a while.
    this.toast = updateToast(parent, t('dialogs.update.label'), t('dialogs.update.later'));
    ({ el: this.el, message: this.message, close: this.later } = this.toast);
    this.now = this.toast.action('');
    this.later.addEventListener('click', () => {
      if (this.kind === 'app') this.app?.snooze();
      this.toast.show(false);
    });
    this.now.addEventListener('click', () => (this.kind === 'app' ? void this.install() : this.reload()));
    if (running === '') return; // development: there is no build to compare with
    setInterval(() => void this.check(), CHECK_EVERY_MS);
    if (app) setTimeout(() => void this.check(), FIRST_APP_CHECK_MS);
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
  }

  private async check(): Promise<void> {
    const now = Date.now();
    if (this.checking || now - this.lastCheck < CHECK_MIN_GAP_MS) return;
    this.checking = true;
    this.lastCheck = now;
    try {
      const update = await updateToOffer(this.running, this.app && (() => this.app!.check()));
      if (update) this.display(update);
    } finally {
      this.checking = false;
    }
  }

  /** The page knows it is out of date (a chunk is gone): a new app if there is one, else a reload. */
  async show(): Promise<void> {
    const app = this.app ? await this.app.check().catch(() => false) : false;
    this.display(app ? 'app' : 'site');
  }

  private display(kind: 'app' | 'site'): void {
    // Installing: the note says so until the app restarts, and no check changes it.
    if (this.now.disabled) return;
    this.kind = kind;
    const version = kind === 'app' ? this.app?.version() : undefined;
    this.message.textContent = version ? t('update.note', { version }) : t('dialogs.update.message');
    this.now.textContent = t(kind === 'app' ? 'update.restart' : 'dialogs.update.reload');
    this.now.hidden = false;
    this.toast.show(true);
  }

  /** An update of the app is being installed by itself (Update automatically): the note says so until the app restarts. */
  installing(): void {
    this.display('app');
    this.now.disabled = this.later.disabled = true;
    this.now.hidden = true;
    this.message.textContent = t('update.installing');
  }

  private async install(): Promise<void> {
    this.now.disabled = this.later.disabled = true;
    this.now.hidden = true;
    this.message.textContent = t('update.installing');
    try {
      await this.app!.install();
    } catch (error) {
      this.message.textContent = t('update.failed', { message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.now.disabled = this.later.disabled = false;
      this.now.hidden = false;
    }
  }
}
