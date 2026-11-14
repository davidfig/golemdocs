// Screen Reader Mode (Tools › Screen Reader Mode, Mod+Alt+Z): the document is drawn on a canvas, so while it is on the
// hidden textarea holds the text around the caret and a reading layer describes the pages (see docs/architecture/accessibility.md).
// A page cannot tell whether a screen reader is running, so this is a choice the person makes; it follows the account.

export const SCREEN_READER_KEY = 'golem.screenReader';
/** The shortcut that turns the mode on and off, as `ui/shortcuts.ts` writes them. */
export const SCREEN_READER_SHORTCUT = 'Mod+Alt+Z';

const read = (): boolean => {
  try {
    return localStorage.getItem(SCREEN_READER_KEY) === 'on';
  } catch {
    return false;
  }
};

let on = read();
const listeners = new Set<(on: boolean) => void>();

export const screenReaderOn = (): boolean => on;

/** Calls `listener` whenever the mode is turned on or off. Returns the way to stop (the viewer, mounted again for each file). */
export function onScreenReaderChange(listener: (on: boolean) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function turn(value: boolean): boolean {
  if (value === on) return false;
  on = value;
  for (const listener of listeners) listener(on);
  return true;
}

export function setScreenReader(value: boolean): void {
  if (value === on) return;
  try {
    localStorage.setItem(SCREEN_READER_KEY, value ? 'on' : 'off');
  } catch {
    // The choice lasts for this session only.
  }
  turn(value);
}

/** The mode as storage now has it (a choice from the account, settingsSync.ts). Reads and never writes. */
export function rereadScreenReader(): void {
  turn(read());
}
