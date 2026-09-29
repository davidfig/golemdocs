// Color schemes: Office 2003's Silver (the default), Blue and Olive Green, each with a dark
// counterpart shared by all three. A scheme is only a set of --wm-* colors in ui.css, chosen by
// data-theme on the root element. Two choices make it: the scheme, and the appearance, which is
// automatic (dark when the system prefers dark), always light, or always dark. Both belong to this
// browser (kept in localStorage), not the document.

export const SCHEMES = [
  { id: 'silver', label: '&Silver' },
  { id: 'blue', label: '&Blue' },
  { id: 'olive', label: '&Olive Green' },
] as const;

export type SchemeId = (typeof SCHEMES)[number]['id'];
export type Appearance = 'auto' | 'light' | 'dark';

const SCHEME_KEY = 'golem.theme';
const APPEARANCE_KEY = 'golem.appearance';

const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // Storage unavailable: the defaults apply.
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private window, blocked): the choice lasts for this session only.
  }
}

const isScheme = (value: unknown): value is SchemeId => SCHEMES.some((s) => s.id === value);
const isAppearance = (value: unknown): value is Appearance => value === 'auto' || value === 'light' || value === 'dark';

let scheme: SchemeId = 'silver';
let appearance: Appearance = 'auto';
{
  const savedScheme = read(SCHEME_KEY);
  const savedAppearance = read(APPEARANCE_KEY);
  if (isScheme(savedScheme)) scheme = savedScheme;
  if (isAppearance(savedAppearance)) appearance = savedAppearance;
  // Before appearance existed the scheme list held Dark; a saved Dark stays dark, and any other
  // saved scheme is just a palette, so appearance stays automatic.
  else if (savedScheme === 'dark') appearance = 'dark';
}

let desk: [number, number, number] | null = null;
const listeners = new Set<() => void>();

export function currentScheme(): SchemeId {
  return scheme;
}

export function currentAppearance(): Appearance {
  return appearance;
}

/** Whether the dark colors are showing now. */
export function isDark(): boolean {
  return appearance === 'auto' ? darkQuery.matches : appearance === 'dark';
}

function apply(): void {
  desk = null;
  document.documentElement.dataset.theme = isDark() ? 'dark' : scheme;
  for (const listener of listeners) listener();
}

export function setScheme(id: SchemeId): void {
  if (id === scheme) return;
  scheme = id;
  write(SCHEME_KEY, id);
  apply();
}

export function setAppearance(value: Appearance): void {
  if (value === appearance) return;
  appearance = value;
  write(APPEARANCE_KEY, value);
  apply();
}

/** Turns dark on or off for good (this leaves automatic). */
export function toggleDark(): void {
  setAppearance(isDark() ? 'light' : 'dark');
}

/** Calls `listener` whenever the colors change, including when the system flips under automatic. Returns the way to stop. */
export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

darkQuery.addEventListener('change', () => {
  if (appearance === 'auto') apply();
});

document.documentElement.dataset.theme = isDark() ? 'dark' : scheme;

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
