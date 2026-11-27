// Updating by itself (desktop app, Tools › Options › Update automatically): once the app has been left alone for the chosen time and
// nothing is in flight (everything saved and uploaded, no vault sync running, nothing playing or recording, no dialog open, no
// encrypted folder unlocked), an update that is waiting is put in: a new version of the app is installed and the app restarts, and an
// update of the site alone reloads the page. Either way the document comes back where it was. Off unless the person turns it on.

/** The choices offered: minutes without activity before updating; 0 is off. */
export const AUTO_UPDATE_CHOICES = [0, 5, 15, 30, 60] as const;
export type AutoUpdateMinutes = (typeof AUTO_UPDATE_CHOICES)[number];

/** A preference, so it follows the account (settingsSync.ts). */
export const AUTO_UPDATE_KEY = 'golem.autoUpdate';
/** When this computer last updated by itself: per device, never synced. */
const LAST_KEY = 'golem.autoUpdate.last';
/** The least time between two updates done by itself, so an update that doesn't take (a failed install, a site still serving the old build) can't loop. */
export const AUTO_UPDATE_GAP_MS = 30 * 60_000;
/** How often the app looks whether it can update now. */
export const AUTO_UPDATE_TICK_MS = 60_000;

/** The chosen minutes (0: off). Anything unknown or unreadable is off. */
export function autoUpdateMinutes(): AutoUpdateMinutes {
  try {
    const value = Number(localStorage.getItem(AUTO_UPDATE_KEY));
    return (AUTO_UPDATE_CHOICES as readonly number[]).includes(value) ? (value as AutoUpdateMinutes) : 0;
  } catch {
    return 0;
  }
}

export function setAutoUpdateMinutes(minutes: AutoUpdateMinutes): void {
  try {
    localStorage.setItem(AUTO_UPDATE_KEY, String(minutes));
  } catch {
    // No storage: the choice can't be kept, so it stays off.
  }
}

/** What is waiting: a new version of the app (which loads the current site too), the site alone, or nothing. */
export type PendingUpdate = 'app' | 'site' | null;

export interface AutoUpdateHost {
  now(): number;
  /** The chosen minutes without activity (0: off). */
  minutes(): number;
  /** When the person last did anything in the app. */
  lastActivity(): number;
  /** Why it can't update now (something unsaved, uploading, syncing, playing...), or null when nothing is in flight. */
  busy(): string | null;
  /** What update is waiting. Asked only once the app is idle and nothing is in flight. */
  pending(): Promise<PendingUpdate>;
  /** Puts the update in: installs the app's and restarts, or reloads the page. */
  apply(update: Exclude<PendingUpdate, null>): Promise<void>;
  /** When this computer last updated by itself (null: never), and noting that it is doing so now. */
  lastUpdate(): number | null;
  noteUpdate(at: number): void;
}

/** What a look found; for tests and the log. */
export type AutoUpdateOutcome = 'off' | 'active' | 'recent' | 'busy' | 'none' | 'updating';

/** The hosts with an update being put in (or a look waiting for the site's answer): a second look meanwhile does nothing. */
const inFlight = new WeakSet<AutoUpdateHost>();

/** One look: whether to update now, and doing it if so. */
export async function autoUpdateTick(host: AutoUpdateHost): Promise<AutoUpdateOutcome> {
  const minutes = host.minutes();
  if (minutes <= 0) return 'off';
  if (inFlight.has(host)) return 'busy';
  inFlight.add(host);
  try {
    return await look(host, minutes);
  } finally {
    inFlight.delete(host);
  }
}

async function look(host: AutoUpdateHost, minutes: number): Promise<AutoUpdateOutcome> {
  const now = host.now();
  if (now - host.lastActivity() < minutes * 60_000) return 'active';
  const last = host.lastUpdate();
  if (last !== null && now - last < AUTO_UPDATE_GAP_MS) return 'recent';
  if (host.busy()) return 'busy';
  const update = await host.pending();
  if (!update) return 'none';
  // Asked again after the wait for the site's answer: a key pressed or a save started meanwhile puts it off.
  if (host.now() - host.lastActivity() < minutes * 60_000 || host.busy()) return 'busy';
  host.noteUpdate(host.now());
  await host.apply(update);
  return 'updating';
}

/** When this computer last updated by itself (localStorage, per device). */
export function storedLastUpdate(): number | null {
  try {
    const value = Number(localStorage.getItem(LAST_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function storeLastUpdate(at: number): void {
  try {
    localStorage.setItem(LAST_KEY, String(at));
  } catch {
    // No storage: the gap isn't kept across the reload, at worst one more update than needed.
  }
}

/** Follows activity in the window: keys, the pointer and the wheel. Returns when the last one was. */
export function watchActivity(target: Window, now: () => number = Date.now): () => number {
  let last = now();
  const seen = () => (last = now());
  for (const type of ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart']) target.addEventListener(type, seen, { capture: true, passive: true });
  return () => last;
}
