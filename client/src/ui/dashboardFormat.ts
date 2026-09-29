// Pure helpers for the dashboard (dashboard.ts): text for dates, sizes and sync badges, and the
// rules for where opening a card gets its document.

import { getLocale, t } from '../i18n/index.ts';
import type { LibraryEntry, SyncState } from '../sync.ts';

/** "Just now", "5 minutes ago", "3 hours ago", "Yesterday", "4 days ago", else the date; in the current language. */
export function relativeTime(then: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  const relative = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'always' });
  if (seconds < 45) return t('panels.time.justNow');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return relative.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return relative.format(-hours, 'hour');
  const days = Math.round(hours / 24);
  if (days === 1) return t('panels.time.yesterday');
  if (days < 7) return relative.format(-days, 'day');
  return new Date(then).toLocaleDateString(getLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return t('panels.size.bytes', { value: bytes });
  if (bytes < 1024 * 1024) return t('panels.size.kb', { value: Math.round(bytes / 1024) });
  return t('panels.size.mb', { value: (bytes / (1024 * 1024)).toFixed(1) });
}

/**
 * The badge for a card, or null when there is nothing worth saying, which is nearly always: only
 * a signed-in user's changes that haven't reached their account yet (offline, say) are mentioned.
 */
export function syncBadge(state: SyncState, signedIn: boolean): { text: string; tone: 'pending' } | null {
  if (!signedIn) return null;
  return state === 'local-only' || state === 'local-ahead' || state === 'conflict' ? { text: t('panels.dashboard.notSaved'), tone: 'pending' } : null;
}

/** Where opening an entry gets its document: the cloud only when that has something the browser doesn't. */
export function opensFromCloud(entry: LibraryEntry): boolean {
  if (!entry.cloud) return false;
  return !entry.local || entry.state === 'cloud-ahead' || entry.state === 'conflict';
}

export function matchesSearch(entry: LibraryEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || entry.name.toLowerCase().includes(q);
}
