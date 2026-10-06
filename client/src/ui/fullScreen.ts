// View ▸ Full Screen: the browser goes full screen and the app's own chrome gets out of the way
// (menu bar, toolbars, ruler, status bar), leaving the document. Esc leaves it: the browser handles
// the key and says so with a `fullscreenchange`, which is what puts the chrome back, so the two
// can't disagree. Tools ▸ Options can keep the menu bar showing.

import { t } from '../i18n/index.ts';
import { showToast } from './toast.ts';

export const FULL_SCREEN_MENU_KEY = 'word.fullScreenMenus';

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

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
