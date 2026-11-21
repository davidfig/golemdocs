// Print Layout or Flow, as the person last chose it (View › Print Layout / Flow, or the status bar's buttons). Remembered in this
// browser and followed by the editor and the site's viewer pages. The third view, the page grid, is never remembered.

import type { ViewMode } from './actions.ts';

export const VIEW_KEY = 'word.viewMode';

export function savedViewMode(): Exclude<ViewMode, 'grid'> {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    // 'normal' is Flow's earlier name.
    if (saved === 'flow' || saved === 'normal') return 'flow';
    if (saved === 'print') return saved;
  } catch {
    // Storage unavailable: use the default for this screen.
  }
  // With no saved choice, a phone-sized screen starts in Flow (a page shrunk to fit is unreadable there).
  return window.matchMedia('(max-width: 720px)').matches ? 'flow' : 'print';
}
