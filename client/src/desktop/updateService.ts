// Keeps the desktop shell up to date: asks the shell whether a newer signed version exists, and installs it. It has no timer of its own:
// the page asks when it checks the site (ui/updateNotice.ts), so a new app and a new site are told in one note, at the same times.
// Help › Check for Updates asks too (ui/updateDialog.ts), and Update automatically installs what was found (desktop/autoUpdate.ts).

import type { DesktopUpdater } from './bridge.ts';

export interface UpdateOffer {
  version: string;
}

/** How long "Later" on the update note holds a new version of the app back. */
export const SNOOZE_MS = 4 * 60 * 60_000;
/** Per device, like any notice dismissed (settingsSync.ts): `{ version, until }`. */
const SNOOZE_KEY = 'golem.updateSnooze';

/** Where the snooze is kept: localStorage, or a stand-in in tests. */
export interface SnoozeStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const browserStorage: SnoozeStorage = {
  get: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // No storage: the note comes back at the next check.
    }
  },
};

export class UpdateService {
  /** The update found by the last look, if any. */
  offer: UpdateOffer | null = null;

  constructor(
    private readonly updater: DesktopUpdater,
    private readonly storage: SnoozeStorage = browserStorage,
    private readonly now: () => number = Date.now,
  ) {}

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

  /** "Later" on the note: `version` isn't offered there again for a while (Help › Check for Updates and Update automatically still see it). */
  snooze(version: string): void {
    this.storage.set(SNOOZE_KEY, JSON.stringify({ version, until: this.now() + SNOOZE_MS }));
  }

  /** Whether the note should leave `version` alone for now. A newer version than the one put off is offered at once. */
  snoozed(version: string): boolean {
    try {
      const saved = JSON.parse(this.storage.get(SNOOZE_KEY) ?? 'null') as { version?: unknown; until?: unknown } | null;
      return saved?.version === version && typeof saved.until === 'number' && this.now() < saved.until;
    } catch {
      return false;
    }
  }

  /** Installs the offered update and restarts. */
  install(): Promise<void> {
    return this.updater.install();
  }
}
