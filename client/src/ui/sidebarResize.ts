// A drag handle on the right edge of a sidebar (the files and pages panels): drag it, or press the
// arrow keys while it is focused, to set the panel's width. The width is remembered in this browser.

import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import './sidebarResize.css';

export interface ResizeOptions {
  /** localStorage key for the width. */
  key: string;
  min: number;
  max: number;
  /** The width when none was chosen. */
  initial: number;
  /** The width changed (to redraw what depends on it). */
  changed?: (width: number) => void;
}

/** Keyboard step, in CSS px. */
const STEP = 16;

export function makeResizable(panel: HTMLElement, { key, min, max, initial, changed }: ResizeOptions): void {
  const limit = (width: number): number => Math.round(Math.max(min, Math.min(max, window.innerWidth / 2, width)));
  let width = initial;
  try {
    const saved = Number(localStorage.getItem(key));
    if (Number.isFinite(saved) && saved > 0) width = saved;
  } catch {
    // Storage unavailable: the panel keeps its usual width.
  }
  const handle = h('div', { class: 'wm-resizer', attrs: { role: 'separator', 'aria-orientation': 'vertical', tabindex: '0', 'aria-label': t('panels.resize') }, title: t('panels.resize') });
  const set = (to: number, remember: boolean): void => {
    width = limit(to);
    panel.style.width = `${width}px`;
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(max));
    changed?.(width);
    if (!remember) return;
    try {
      localStorage.setItem(key, String(width));
    } catch {
      // Storage unavailable: the width lasts for this session only.
    }
  };
  set(width, false);
  let from: { x: number; width: number } | null = null;
  handle.addEventListener('pointerdown', (e) => {
    from = { x: e.clientX, width };
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('wm-resizing');
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (from) set(from.width + e.clientX - from.x, false);
  });
  const end = (): void => {
    if (!from) return;
    from = null;
    handle.classList.remove('wm-resizing');
    set(width, true);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => set(initial, true));
  handle.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowLeft' ? -STEP : e.key === 'ArrowRight' ? STEP : 0;
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    set(width + step, true);
  });
  panel.append(handle);
}
