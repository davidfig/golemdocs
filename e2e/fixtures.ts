// Shared helpers for the end-to-end tests.
//
// The editor draws to a WebGL canvas, so there is no document text in the DOM to assert on. Tests
// read the document through the window hooks main.ts already exposes (`selectionState`, `loaded`,
// `pages`, `status`), through the DOM of the menus, toolbars and dialogs, and through files the
// app downloads.

import { expect, test as base, type Download, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

export const MOD = 'ControlOrMeta';

export class App {
  constructor(readonly page: Page) {}

  /** Opens the app (default: a blank document in a throwaway room-less session) and waits for the first layout. */
  async goto(query = '?doc=fonts'): Promise<void> {
    await this.page.goto(`/${query}`);
    await this.ready();
  }

  /** A new, empty document (File ▸ New), with the caret in it. Each test starts in a fresh browser profile, so nothing else is saved. */
  async blank(): Promise<void> {
    await this.goto('?doc=welcome');
    await this.menu('File', 'New');
    await this.page.waitForFunction(() => (window as unknown as { selectionState: { caret: unknown } }).selectionState.caret !== null);
    await this.focus();
  }

  async ready(): Promise<void> {
    await this.page.waitForFunction(() => (window as unknown as { loaded: boolean }).loaded === true, null, { timeout: 30_000 });
  }

  get editor(): Locator {
    return this.page.locator('#input');
  }

  get canvas(): Locator {
    return this.page.locator('#canvas');
  }

  get menubar(): Locator {
    return this.page.getByRole('menubar');
  }

  async focus(): Promise<void> {
    // After a modal dialog closes, #input is the active element but Chromium has dropped its text-input
    // connection, so typed characters vanish (keys still work). Focusing from scratch restores it.
    await this.editor.evaluate((el) => {
      el.blur();
      el.focus({ preventScroll: true });
    });
  }

  async type(text: string, delay = 0): Promise<void> {
    await this.focus();
    await this.page.keyboard.type(text, { delay });
  }

  async press(key: string, times = 1): Promise<void> {
    for (let i = 0; i < times; i++) await this.page.keyboard.press(key);
  }

  /** Waits for the layout worker to settle after an edit (a selection update arrives with every layout). */
  async settle(): Promise<void> {
    await this.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }

  /** The whole document's text (selects all, reads what the selection holds, then leaves the caret at the end of the document). */
  async text(): Promise<string> {
    await this.focus();
    await this.page.keyboard.press(`${MOD}+a`);
    await this.settle();
    const text = await this.selectedText();
    await this.page.keyboard.press(`${MOD}+End`);
    return text;
  }

  async selectedText(): Promise<string> {
    return this.page.evaluate(() => (window as unknown as { selectionState: { text: string } }).selectionState.text);
  }

  /** Opens a menu and clicks a path of items, e.g. `menu('File', 'Convert To', 'PDF')`. Names match exactly, ignoring mnemonic underlines. */
  async menu(title: string, ...path: string[]): Promise<void> {
    await this.menubar.getByRole('menuitem', { name: new RegExp(`^${escape(title)}$`) }).click();
    for (const name of path) {
      const menus = this.page.getByRole('menu');
      const match = { name: new RegExp(`^${escape(name)}(…|\\.\\.\\.)?(\\s|$)`) };
      // Checked items (Bold, Align Left…) are checkbox/radio menu items.
      await menus
        .getByRole('menuitem', match)
        .or(menus.getByRole('menuitemcheckbox', match))
        .or(menus.getByRole('menuitemradio', match))
        .first()
        .click();
    }
  }

  toolbarButton(name: string | RegExp): Locator {
    return this.page.getByRole('toolbar').getByRole('button', { name });
  }

  /** Runs `action` and returns the file it downloads. */
  async download(action: () => Promise<void>): Promise<{ name: string; bytes: Buffer; text: string }> {
    const [download]: [Download, void] = await Promise.all([this.page.waitForEvent('download'), action()]);
    const path = await download.path();
    const bytes = await readFile(path);
    return { name: download.suggestedFilename(), bytes, text: bytes.toString('utf8') };
  }
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const test = base.extend<{ app: App; sidebarDefault: boolean; statusBarDefault: boolean }>({
  // The page sidebar is open by default in a wide window, where it would cover the PDF tool palette and shift the
  // page. Tests start with it closed (unless the browser already holds a choice); the ones about the default opt in.
  sidebarDefault: [false, { option: true }],
  // The status bar too is on by default; tests start with it off, so the document has the window's whole height.
  statusBarDefault: [false, { option: true }],
  page: async ({ page, sidebarDefault, statusBarDefault }, use) => {
    if (!sidebarDefault) {
      await page.addInitScript(() => {
        try {
          if (localStorage.getItem('word.pagesPanel') === null) localStorage.setItem('word.pagesPanel', 'off');
        } catch {
          // No storage: the app falls back to its default.
        }
      });
    }
    if (!statusBarDefault) {
      await page.addInitScript(() => {
        try {
          if (localStorage.getItem('word.footer') === null) localStorage.setItem('word.footer', 'off');
        } catch {
          // No storage: the app falls back to its default.
        }
      });
    }
    await use(page);
  },
  app: async ({ page }, use) => {
    await use(new App(page));
  },
});

export { expect };
