// View ▸ Full Screen: the browser goes full screen and the app's own chrome gets out of the way
// (menu bar, toolbars, ruler, status bar), leaving the document. Esc leaves it: the browser handles
// the key and says so with a `fullscreenchange`, which is what puts the chrome back, so the two
// can't disagree. Tools ▸ Options can keep the menu bar showing.
//
// Where the browser can't go full screen (a phone: Safari on an iPhone and the phone apps), the app
// only hides its own chrome, and a button in the corner (or Esc) brings it back.

import { t } from '../i18n/index.ts';
import { iconButton } from './dom.ts';
import { showToast } from './toast.ts';

const EXIT_ICON = 'M4.5 1V4.5H1M7.5 1V4.5H11M4.5 11V7.5H1M7.5 11V7.5H11';

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
/** Full screen drawn by the app alone, where the browser has none. */
let inApp = false;
let exitButton: HTMLButtonElement | null = null;
const changeListeners = new Set<() => void>();

/** Whether the document has the screen to itself. */
export const isFullScreen = (): boolean => !!document.fullscreenElement || inApp;

/** Calls `listener` whenever full screen starts or ends. */
export const onFullScreenChange = (listener: () => void): void => void changeListeners.add(listener);

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
  const on = isFullScreen();
  document.body.classList.toggle('wm-fullscreen', on);
  document.body.classList.toggle('wm-fullscreen-menu', on && keepMenu);
  if (inApp && !exitButton) {
    exitButton = iconButton('wm-fullscreen-exit', EXIT_ICON, t('chrome.fullScreen.exit'));
    exitButton.addEventListener('click', () => void toggleFullScreen());
    document.body.append(exitButton);
  } else if (!inApp && exitButton) {
    exitButton.remove();
    exitButton = null;
  }
  for (const listener of changeListeners) listener();
}

/** Starts listening for the browser entering and leaving full screen (once). */
export function installFullScreen(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('fullscreenchange', () => {
    apply();
    if (document.fullscreenElement) showToast(t('chrome.fullScreen.hint'));
  });
  window.addEventListener(
    'keydown',
    (e) => {
      if (!inApp || e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      void toggleFullScreen();
    },
    true,
  );
  apply();
}

/** Full screen on, or off again. */
export function toggleFullScreen(): Promise<void> {
  if (inApp || !document.fullscreenEnabled) {
    inApp = !inApp;
    apply();
    return Promise.resolve();
  }
  return (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
}
