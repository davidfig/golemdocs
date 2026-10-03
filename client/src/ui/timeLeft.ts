// "About 2 min left" for the progress card, from how fast the work has gone so far.

import { getLocale } from '../i18n/index.ts';

/** Seconds still to go if the rest goes as fast as the work since `startedAt` (ms): null until there is enough to go on. */
export function estimateSeconds(fraction: number, startFraction: number, elapsedMs: number): number | null {
  const gained = fraction - startFraction;
  // Too little work or time to say anything but noise.
  if (gained < 0.02 || elapsedMs < 2000) return null;
  return ((elapsedMs / gained) * (1 - fraction)) / 1000;
}

/** A length of time in the page's language, rounded to what is useful to read: "45 sec", "3 min", "1 hr 20 min". */
export function formatDuration(seconds: number): string {
  const unit = (value: number, name: 'second' | 'minute' | 'hour'): string =>
    new Intl.NumberFormat(getLocale(), { style: 'unit', unit: name, unitDisplay: 'short' }).format(value);
  if (seconds < 55) return unit(Math.max(5, Math.round(seconds / 5) * 5), 'second');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return unit(Math.max(1, minutes), 'minute');
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${unit(hours, 'hour')} ${unit(rest, 'minute')}` : unit(hours, 'hour');
}
