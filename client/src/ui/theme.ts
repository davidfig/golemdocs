// Color schemes: Office 2003's Silver (the default), Blue and Olive Green, plus Dark. A scheme is
// only a set of --wm-* colors in ui.css, chosen by data-theme on the root element. The choice
// belongs to this browser (kept in localStorage), not the document. With no choice made, a
// system that prefers dark gets Dark, else Silver.

export const THEMES = [
  { id: 'silver', label: '&Silver' },
  { id: 'blue', label: '&Blue' },
  { id: 'olive', label: '&Olive Green' },
  { id: 'dark', label: '&Dark' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

const STORAGE_KEY = 'golem.theme';

function isTheme(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}

function loadTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isTheme(saved)) return saved;
  } catch {
    // Storage unavailable: fall through to the system preference.
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'silver';
}

let current = loadTheme();
let desk: [number, number, number] | null = null;
const listeners = new Set<() => void>();

document.documentElement.dataset.theme = current;

export function theme(): ThemeId {
  return current;
}

export function setTheme(id: ThemeId): void {
  if (id === current) return;
  current = id;
  desk = null;
  document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Storage unavailable (private window, blocked): the choice lasts for this session only.
  }
  for (const listener of listeners) listener();
}

/** Calls `listener` whenever the scheme changes. Returns the way to stop. */
export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The color behind the pages, 0-1 per channel, as the scheme's --wm-desk. */
export function deskColor(): readonly [number, number, number] {
  if (!desk) {
    const hex = getComputedStyle(document.documentElement).getPropertyValue('--wm-desk').trim();
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    const n = m ? parseInt(m[1], 16) : 0xe5e5e5;
    desk = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  return desk;
}
