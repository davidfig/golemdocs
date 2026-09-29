// Pure helpers for the dashboard (dashboard.ts): text for dates, sizes and sync badges, and the
// rules for where opening a card gets its document.

import type { LibraryEntry, SyncState } from '../sync.ts';

/** "Just now", "5 minutes ago", "3 hours ago", "Yesterday", "4 days ago", else the date. */
export function relativeTime(then: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (seconds < 45) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return plural(days, 'day');
  return new Date(then).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The sync badge for a state, or null when there is nothing worth saying. */
export function syncBadge(state: SyncState): { text: string; tone: 'ok' | 'pending' | 'warn' | 'muted' } | null {
  switch (state) {
    case 'synced':
      return { text: 'Synced', tone: 'ok' };
    case 'local-ahead':
      return { text: 'Not yet uploaded', tone: 'pending' };
    case 'cloud-ahead':
      return { text: 'Newer in the cloud', tone: 'pending' };
    case 'conflict':
      return { text: 'Changed in both places', tone: 'warn' };
    case 'unknown':
      return { text: 'Cloud unavailable', tone: 'muted' };
    default:
      return null;
  }
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
