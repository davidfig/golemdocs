// The "Format as you type" setting: typing Markdown shortcuts ("# ", "- ", "**bold**") makes real
// formatting. Kept on this device; the layout worker is told on every change and on each document opened.

const KEY = 'word.autoFormat';

let on = true;
try {
  on = localStorage.getItem(KEY) !== 'off';
} catch {
  // Storage unavailable: on, for this session.
}

const listeners = new Set<(on: boolean) => void>();

export const autoFormatOn = (): boolean => on;

export function setAutoFormat(value: boolean): void {
  if (value === on) return;
  on = value;
  try {
    localStorage.setItem(KEY, value ? 'on' : 'off');
  } catch {
    // The choice lasts for this session only.
  }
  for (const listener of listeners) listener(on);
}

/** Calls `listener` when the setting changes. */
export function onAutoFormat(listener: (on: boolean) => void): void {
  listeners.add(listener);
}
