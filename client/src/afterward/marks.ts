// Tools › Afterward › Read Along: whether the editor reads along while the writer works. A choice of how the app behaves, so it
// follows the account (settingsSync.ts); off until turned on, since reading along is paid for on the writer's key. Small and
// loaded with the menus; the reading itself is Afterward's (afterward.ts), loaded when needed.

const KEY = 'golem.afterward.readAlong';
const listeners = new Set<() => void>();

export function readAlongOn(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

export function toggleReadAlong(): void {
  try {
    if (readAlongOn()) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, 'on');
  } catch {
    /* storage unavailable: nothing to change */
  }
  readAlongChanged();
}

/** Runs `listener` whenever the choice changes (here, or from the account). */
export function onReadAlong(listener: () => void): void {
  listeners.add(listener);
}

/** The choice changed: what depends on it hears. */
export function readAlongChanged(): void {
  for (const listener of listeners) listener();
}
