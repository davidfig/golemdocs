// View ▸ Full Screen: the browser goes full screen and the app's own chrome gets out of the way
// (menu bar, toolbars, ruler, status bar), leaving the document. Esc leaves it: the browser handles
// the key and says so with a `fullscreenchange`, which is what puts the chrome back, so the two
// can't disagree. Tools ▸ Options can keep the menu bar showing.

import { t } from '../i18n/index.ts';
import { showToast } from './toast.ts';

export const FULL_SCREEN_MENU_KEY = 'word.fullScreenMenus';

/** Desktop app on a Mac: show the menus in the window as well as in the system's menu bar (the system's menu bar keeps working either way). */
export const MAC_IN_APP_MENU_KEY = 'golem.macInAppMenu';

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** Whether the desktop app on a Mac also shows its menus in the window (off by default). */
export function inAppMenuOnMac(): boolean {
  return read(MAC_IN_APP_MENU_KEY) === 'on';
}

const inAppListeners = new Set<() => void>();

/** Calls `listener` whenever the choice changes. */
export const onInAppMenuChange = (listener: () => void): void => void inAppListeners.add(listener);

export function setInAppMenuOnMac(on: boolean): void {
  try {
    localStorage.setItem(MAC_IN_APP_MENU_KEY, on ? 'on' : 'off');
  } catch {
    // The choice is not kept.
  }
  for (const listener of inAppListeners) listener();
}

let keepMenu = read(FULL_SCREEN_MENU_KEY) === 'on';
let installed = false;

/** Whether the menu bar stays in full screen (only the toolbars, ruler and status bar go). */
export const keepMenuInFullScreen = (): boolean => keepMenu;

export function setKeepMenuInFullScreen(on: boolean): void {
  keepMenu = on;
  try {
    localStorage.setItem(FULL_SCREEN_MENU_KEY, on ? 'on' : 'off');
  } catch {
    // The choice lasts for this session only.
  }
  apply();
}

function apply(): void {
  const on = !!document.fullscreenElement;
  document.body.classList.toggle('wm-fullscreen', on);
  document.body.classList.toggle('wm-fullscreen-menu', on && keepMenu);
}

/** Starts listening for the browser entering and leaving full screen (once). */
export function installFullScreen(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('fullscreenchange', () => {
    apply();
    if (document.fullscreenElement) showToast(t('chrome.fullScreen.hint'));
  });
  apply();
}

/** Full screen on, or off again. */
export function toggleFullScreen(): Promise<void> {
  return (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
}
