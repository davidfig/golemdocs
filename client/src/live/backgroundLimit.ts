// Tools › Options › Live Blocks: the largest update this device does in the background (docs/live-blocks.md §6, *Updates in
// the background*): a dependent and its sources together, as stored. A phone's setting is its own (settingsSync.ts), so
// each kind of device starts from its own default. Read each time it is used, so a value from the account applies at once.

import { settingsProfile } from '../settingsSync.ts';
import { COMPUTER_LIMIT_BYTES, PHONE_LIMIT_BYTES } from './background.ts';

export const LIVE_LIMIT_KEY = 'golem.liveBackgroundLimit';
/** The choices, in MB; 0 is "never in the background". */
export const LIVE_LIMIT_CHOICES = [0, 10, 20, 50, 100, 250, 500] as const;

const MB = 1024 * 1024;

/** The default for this kind of device, in MB. */
export const defaultLimitMb = (): number => (settingsProfile() === 'mobile' ? PHONE_LIMIT_BYTES : COMPUTER_LIMIT_BYTES) / MB;

/** The chosen limit in MB (0: never). */
export function liveLimitMb(): number {
  try {
    const value = Number(localStorage.getItem(LIVE_LIMIT_KEY));
    return localStorage.getItem(LIVE_LIMIT_KEY) !== null && Number.isFinite(value) && value >= 0 ? value : defaultLimitMb();
  } catch {
    return defaultLimitMb();
  }
}

/** The limit in bytes (0: nothing is updated in the background). */
export const liveLimitBytes = (): number => liveLimitMb() * MB;

export function setLiveLimitMb(mb: number): void {
  try {
    if (mb === defaultLimitMb()) localStorage.removeItem(LIVE_LIMIT_KEY);
    else localStorage.setItem(LIVE_LIMIT_KEY, String(mb));
  } catch {
    // The choice is not kept.
  }
}
