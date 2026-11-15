// Tools › Afterward › Show Reader Attention: a choice of view, so it follows the account (settingsSync.ts). Small and loaded
// with the menus; the marks themselves are drawn by Afterward (afterward.ts) when it is loaded.

const KEY = 'golem.afterward.marks';
const listeners = new Set<() => void>();

/** Whether the readers' attention is shown beside the text (it is, unless turned off). */
export function afterwardMarksShown(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function toggleAfterwardMarks(): void {
  try {
    if (afterwardMarksShown()) localStorage.setItem(KEY, 'off');
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: nothing to change */
  }
  afterwardMarksChanged();
}

/** Runs `listener` whenever the choice changes (here, or from the account). */
export function onAfterwardMarks(listener: () => void): void {
  listeners.add(listener);
}

/** The choice changed: what shows it, shows it. */
export function afterwardMarksChanged(): void {
  for (const listener of listeners) listener();
}
