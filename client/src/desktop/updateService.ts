// Keeps the desktop shell up to date: looks for an update shortly after the app opens and every few hours, tells the page when one
// is found (the page asks the person: nothing is installed unasked), and installs it on request. "Later" is remembered for a day, per
// version and per device, so the same offer does not come back at every look.

import type { DesktopUpdater } from './bridge.ts';

export interface UpdateOffer {
  version: string;
}

export interface UpdateStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const SNOOZE_KEY = 'word.updateSnooze';
export const FIRST_LOOK_MS = 10_000;
export const LOOK_EVERY_MS = 6 * 60 * 60 * 1000;
export const SNOOZE_MS = 24 * 60 * 60 * 1000;

export class UpdateService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The update found by the last look, if any. */
  offer: UpdateOffer | null = null;

  constructor(
    private readonly updater: DesktopUpdater,
    /** Called when a look that nobody asked for finds an update the person has not put off. */
    private readonly onOffer: (offer: UpdateOffer) => void,
    private readonly storage: UpdateStorage,
    private readonly now: () => number = Date.now,
  ) {}

  /** The service for this page, or null in a browser. */
  static create(updater: DesktopUpdater | null, onOffer: (offer: UpdateOffer) => void): UpdateService | null {
    if (!updater) return null;
    const storage: UpdateStorage = {
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
          /* no storage: the offer comes back at the next look, which is only a nag */
        }
      },
    };
    return new UpdateService(updater, onOffer, storage);
  }

  start(): void {
    if (this.timer) return;
    const look = (after: number) => {
      this.timer = setTimeout(() => {
        void this.checkQuietly().finally(() => look(LOOK_EVERY_MS));
      }, after);
    };
    look(FIRST_LOOK_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** A look nobody asked for: failing (offline, no release yet) is silent. */
  async checkQuietly(): Promise<void> {
    try {
      const found = await this.check();
      if (found && !this.snoozed(found.version)) this.onOffer(found);
    } catch {
      /* the next look tries again */
    }
  }

  /** A look the person asked for. Rejects when the update server can't be reached. */
  async check(): Promise<UpdateOffer | null> {
    const found = await this.updater.check();
    this.offer = found ? { version: found.version } : null;
    return this.offer;
  }

  /** Installs the offered update and restarts. */
  install(): Promise<void> {
    return this.updater.install();
  }

  /** "Later": this version is not offered again unasked for a day. */
  snooze(version: string): void {
    this.storage.set(SNOOZE_KEY, JSON.stringify({ version, until: this.now() + SNOOZE_MS }));
  }

  private snoozed(version: string): boolean {
    try {
      const saved = JSON.parse(this.storage.get(SNOOZE_KEY) ?? 'null') as { version?: string; until?: number } | null;
      return saved?.version === version && typeof saved.until === 'number' && saved.until > this.now();
    } catch {
      return false;
    }
  }
}
