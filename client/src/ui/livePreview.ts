// The "Show Markdown at the Caret" setting: in a Markdown document, the paragraph the caret is in shows its
// Markdown source (see layout/livePreview.ts). Off unless chosen; kept on this device. The layout worker is
// told on every change and on each document opened.

const KEY = 'word.livePreview';

let on = false;
try {
  on = localStorage.getItem(KEY) === 'on';
} catch {
  // Storage unavailable: off, for this session.
}

const listeners = new Set<(on: boolean) => void>();

export const livePreviewOn = (): boolean => on;

export function setLivePreview(value: boolean): void {
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
export function onLivePreview(listener: (on: boolean) => void): void {
  listeners.add(listener);
}
