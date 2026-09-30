// Helpers shared by the app-shell specs (menus, toolbars, themes, languages, responsive layout).

import type { Locator, Page } from '@playwright/test';
import { expect, type App } from '../fixtures';

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The menu bar's title button ("File", "View"…). */
export function menuTitle(app: App, title: string): Locator {
  return app.menubar.getByRole('menuitem', { name: new RegExp(`^${esc(title)}$`) });
}

/** A row in any open drop-down or submenu, by its exact label (mnemonic underlines and shortcut text ignored). */
export function menuRow(page: Page, label: string): Locator {
  return page.locator('.wm-menu .wm-item').filter({ has: page.locator('span.label', { hasText: new RegExp(`^${esc(label)}$`) }) });
}

/** Opens a menu by clicking its title and waits for the drop-down. */
export async function openMenu(app: App, title: string): Promise<void> {
  await menuTitle(app, title).click();
  await expect(menuTitle(app, title)).toHaveAttribute('aria-expanded', 'true');
}

/** Clicks through a path of rows, e.g. `choose(app, 'View', 'Zoom', 'Page Width')`. */
export async function choose(app: App, title: string, ...path: string[]): Promise<void> {
  await openMenu(app, title);
  for (const label of path) await menuRow(app.page, label).first().click();
}

/** Whether a row (in an already open menu) is checked. */
export async function isChecked(page: Page, label: string): Promise<boolean> {
  return (await menuRow(page, label).first().getAttribute('aria-checked')) === 'true';
}

/** The current camera zoom (1 = 100%). */
export function zoom(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { camera: { zoom: number } }).camera.zoom);
}

export function camera(page: Page): Promise<{ x: number; y: number; zoom: number }> {
  return page.evaluate(() => {
    const c = (window as unknown as { camera: { x: number; y: number; zoom: number } }).camera;
    return { x: c.x, y: c.y, zoom: c.zoom };
  });
}

/** Waits until the camera zoom satisfies a predicate (layout and zooming are asynchronous). */
export async function expectZoom(page: Page, check: (z: number) => boolean, what = 'zoom'): Promise<number> {
  await expect.poll(async () => check(await zoom(page)), { message: what }).toBe(true);
  return zoom(page);
}

export function isMac(page: Page): Promise<boolean> {
  return page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
}

/** Reads one localStorage key. */
export function stored(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => localStorage.getItem(k), key);
}

/** Presets localStorage on the first load only (so a test can change it and reload without the preset coming back). */
export async function seedStorage(page: Page, values: Record<string, string>): Promise<void> {
  await page.addInitScript((entries: Record<string, string>) => {
    try {
      if (sessionStorage.getItem('e2e.seeded')) return;
      sessionStorage.setItem('e2e.seeded', '1');
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    } catch {
      // storage unavailable
    }
  }, values);
}

/** Resizes the window and waits for the app to settle on it. */
export async function resize(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

export const PHONE = { width: 390, height: 780 };
export const TABLET = { width: 820, height: 1024 };
export const DESKTOP = { width: 1280, height: 800 };
