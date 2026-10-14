// Tools ▸ Options ▸ View: letting the page scroll up past the end of the document, so the last lines can be brought to the
// middle of the screen. On unless turned off; it only grows the scroll range and never scrolls on the user's behalf.

export const SCROLL_PAST_END_KEY = 'word.scrollPastEnd';

const read = (): boolean => {
  try {
    return localStorage.getItem(SCROLL_PAST_END_KEY) !== 'off';
  } catch {
    return true;
  }
};

let past = read();
const listeners = new Set<() => void>();

/** Whether the view may scroll until the end of the document is half a screen up from the bottom. */
export const scrollPastEndOn = (): boolean => past;

/** Calls `listener` whenever the choice changes. */
export const onScrollPastEndChange = (listener: () => void): void => void listeners.add(listener);

export function setScrollPastEnd(on: boolean): void {
  past = on;
  try {
    localStorage.setItem(SCROLL_PAST_END_KEY, on ? 'on' : 'off');
  } catch {
    // The choice is not kept.
  }
  for (const listener of listeners) listener();
}
