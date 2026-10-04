// Color schemes: Golem (the default, orange like the favicon) and Office 2003's Silver, Blue,
// Olive Green and Grayscale, each with a dark counterpart shared by all of them. A scheme is only a set of --wm-* colors in ui.css, chosen by
// data-theme on the root element. Two choices make it: the scheme, and the appearance, which is
// automatic (dark when the system prefers dark), always light, or always dark. A third, Dark Pages,
// also turns the pages dark with light letters while the dark colors show. All belong to this
// browser (kept in localStorage), not the document.

import { t } from '../i18n/index.ts';

export const SCHEMES = [
  { id: 'golem', get label() { return t('menus.scheme.golem'); } },
  { id: 'silver', get label() { return t('menus.scheme.silver'); } },
  { id: 'blue', get label() { return t('menus.scheme.blue'); } },
  { id: 'olive', get label() { return t('menus.scheme.olive'); } },
  { id: 'gray', get label() { return t('menus.scheme.gray'); } },
] as const;

export type SchemeId = (typeof SCHEMES)[number]['id'];
export type Appearance = 'auto' | 'light' | 'dark';

const SCHEME_KEY = 'golem.theme';
const APPEARANCE_KEY = 'golem.appearance';
const PAGES_KEY = 'golem.darkPages';

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

let scheme: SchemeId = 'golem';
let appearance: Appearance = 'auto';
let darkPages = read(PAGES_KEY) === 'on';
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
let accent: string | null = null;
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

/** Whether the pages are dark with light letters now: Dark Pages is on and the dark colors are showing. */
export function pagesDark(): boolean {
  return darkPages && isDark();
}

function setRootData(): void {
  const root = document.documentElement;
  root.dataset.theme = isDark() ? 'dark' : scheme;
  root.dataset.scheme = scheme;
  if (pagesDark()) root.dataset.pages = 'dark';
  else delete root.dataset.pages;
}

function apply(): void {
  desk = null;
  accent = null;
  setRootData();
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

/**
 * Turns Dark Pages on or off. Turning it on also turns the dark colors on, since dark pages only
 * show with them; turning it off leaves the rest dark.
 */
export function toggleDarkPages(): void {
  darkPages = !pagesDark();
  write(PAGES_KEY, darkPages ? 'on' : 'off');
  if (darkPages && !isDark()) {
    appearance = 'dark';
    write(APPEARANCE_KEY, appearance);
  }
  apply();
}

/** Calls `listener` whenever the colors change, including when the system flips under automatic. Returns the way to stop. */
export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

darkQuery.addEventListener('change', () => {
  if (appearance === 'auto') apply();
});

setRootData();

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

/** The scheme's accent (--wm-hot-border): what selections, handles and focus are drawn in, for what is drawn on a canvas. */
export function accentColor(): string {
  accent ??= getComputedStyle(document.documentElement).getPropertyValue('--wm-hot-border').trim() || '#316ac5';
  return accent;
}
