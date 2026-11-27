// Keeps the desktop shell up to date: asks the shell whether a newer signed version exists, and installs it. It has no timer of its own:
// the page asks when it checks the site (ui/updateNotice.ts), so a new app and a new site are told in one note, at the same times.
// Help › Check for Updates asks too (ui/updateDialog.ts), and Update automatically installs what was found (desktop/autoUpdate.ts).

import type { DesktopUpdater } from './bridge.ts';

export interface UpdateOffer {
  version: string;
}

export class UpdateService {
  /** The update found by the last look, if any. */
  offer: UpdateOffer | null = null;

  constructor(private readonly updater: DesktopUpdater) {}

  /** The service for this page, or null in a browser. */
  static create(updater: DesktopUpdater | null): UpdateService | null {
    return updater ? new UpdateService(updater) : null;
  }

  /** Asks the shell. Rejects when the update server can't be reached. */
  async check(): Promise<UpdateOffer | null> {
    const found = await this.updater.check();
    this.offer = found ? { version: found.version } : null;
    return this.offer;
  }

  /** Installs the offered update and restarts. */
  install(): Promise<void> {
    return this.updater.install();
  }
}
