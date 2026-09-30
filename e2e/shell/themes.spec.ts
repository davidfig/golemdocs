import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { choose, isChecked, openMenu, seedStorage, stored } from './helpers';

const theme = (page: Page) => page.evaluate(() => ({ theme: document.documentElement.dataset.theme, scheme: document.documentElement.dataset.scheme }));
const cssVar = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

const SCHEMES = [
  ['Golem', 'golem'],
  ['Silver', 'silver'],
  ['Blue', 'blue'],
  ['Olive Green', 'olive'],
  ['Grayscale', 'gray'],
] as const;

test.describe('color schemes', () => {
  test('Golem is the default scheme and follows a light system', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await app.goto('?doc=welcome');
    expect(await theme(page)).toEqual({ theme: 'golem', scheme: 'golem' });
  });

  test('the Color Scheme submenu lists the five schemes as radios with Golem ticked', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await app.goto('?doc=welcome');
    await openMenu(app, 'View');
    await page.locator('.wm-menu .wm-item', { hasText: 'Color Scheme' }).hover();
    for (const [label] of SCHEMES) await expect(page.locator('.wm-menu .wm-item').filter({ has: page.locator('span.label', { hasText: new RegExp(`^${label}$`) }) })).toHaveAttribute('role', 'menuitemradio');
    expect(await isChecked(page, 'Golem')).toBe(true);
    expect(await isChecked(page, 'Blue')).toBe(false);
  });

  for (const [label, id] of SCHEMES) {
    test(`choosing ${label} sets data-theme, changes the colors and is remembered`, async ({ app, page }) => {
      await page.emulateMedia({ colorScheme: 'light' });
      await app.goto('?doc=welcome');
      const before = await cssVar(page, '--wm-menu-bg');
      await choose(app, 'View', 'Color Scheme', label);
      expect(await theme(page)).toEqual({ theme: id, scheme: id });
      // (Choosing the scheme already in use changes, and so saves, nothing.)
      if (id !== 'golem') await expect.poll(() => stored(page, 'golem.theme')).toBe(id);
      if (id !== 'golem') expect(await cssVar(page, '--wm-menu-bg')).not.toBe(before);
      await page.reload();
      await app.ready();
      expect(await theme(page)).toEqual({ theme: id, scheme: id });
      await openMenu(app, 'View');
      await page.locator('.wm-menu .wm-item', { hasText: 'Color Scheme' }).hover();
      expect(await isChecked(page, label)).toBe(true);
    });
  }

  test('each scheme has its own palette', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await app.goto('?doc=welcome');
    const seen = new Set<string>();
    for (const [label] of SCHEMES) {
      await choose(app, 'View', 'Color Scheme', label);
      seen.add(`${await cssVar(page, '--wm-bar-top')}|${await cssVar(page, '--wm-desk')}|${await cssVar(page, '--wm-menu-border')}`);
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });
});

test.describe('dark mode', () => {
  test('Dark Mode switches every scheme dark, keeps the scheme choice, and turning it off restores it', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await app.goto('?doc=welcome');
    await choose(app, 'View', 'Color Scheme', 'Blue');
    const lightBg = await cssVar(page, '--wm-menu-bg');
    await choose(app, 'View', 'Color Scheme', 'Dark Mode');
    expect(await theme(page)).toEqual({ theme: 'dark', scheme: 'blue' });
    expect(await cssVar(page, '--wm-menu-bg')).not.toBe(lightBg);
    await expect.poll(() => stored(page, 'golem.appearance')).toBe('dark');
    await openMenu(app, 'View');
    await page.locator('.wm-menu .wm-item', { hasText: 'Color Scheme' }).hover();
    expect(await isChecked(page, 'Dark Mode')).toBe(true);
    await menuRowClick(page, 'Dark Mode');
    expect(await theme(page)).toEqual({ theme: 'blue', scheme: 'blue' });
    await expect.poll(() => stored(page, 'golem.appearance')).toBe('light');
  });

  test('dark mode is remembered across a reload and applied before the app loads', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await app.goto('?doc=welcome');
    await choose(app, 'View', 'Color Scheme', 'Dark Mode');
    await page.reload({ waitUntil: 'commit' });
    // The inline script in index.html sets the theme before any module has run.
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await app.ready();
    expect((await theme(page)).theme).toBe('dark');
  });

  test('Match System is ticked by default and follows the system setting live', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await app.goto('?doc=welcome');
    await openMenu(app, 'View');
    await page.locator('.wm-menu .wm-item', { hasText: 'Color Scheme' }).hover();
    expect(await isChecked(page, 'Match System')).toBe(true);
    expect(await isChecked(page, 'Dark Mode')).toBe(false);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(async () => (await theme(page)).theme).toBe('dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(async () => (await theme(page)).theme).toBe('golem');
  });

  test('a dark system starts the app dark', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await app.goto('?doc=welcome');
    expect(await theme(page)).toEqual({ theme: 'dark', scheme: 'golem' });
  });

  test('an explicit choice ignores the system: Dark Mode on a light system, light on a dark one', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await app.goto('?doc=welcome');
    await choose(app, 'View', 'Color Scheme', 'Dark Mode'); // was dark via the system: this turns it light for good
    expect((await theme(page)).theme).toBe('golem');
    await openMenu(app, 'View');
    await page.locator('.wm-menu .wm-item', { hasText: 'Color Scheme' }).hover();
    expect(await isChecked(page, 'Match System')).toBe(false);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ colorScheme: 'dark' });
    expect((await theme(page)).theme).toBe('golem');
    await page.reload();
    await app.ready();
    expect((await theme(page)).theme).toBe('golem');
  });

  test('Match System hands control back to the system', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await seedStorage(page, { 'golem.appearance': 'light' });
    await app.goto('?doc=welcome');
    expect((await theme(page)).theme).toBe('golem');
    await openMenu(app, 'View');
    await page.locator('.wm-menu .wm-item', { hasText: 'Color Scheme' }).hover();
    await menuRowClick(page, 'Match System');
    await expect.poll(async () => (await theme(page)).theme).toBe('dark');
    await expect.poll(() => stored(page, 'golem.appearance')).toBe('auto');
  });

  test('an old saved "dark" scheme still opens dark', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await seedStorage(page, { 'golem.theme': 'dark' });
    await app.goto('?doc=welcome');
    expect((await theme(page)).theme).toBe('dark');
  });

  test('unknown saved values are ignored', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await seedStorage(page, { 'golem.theme': 'neon', 'golem.appearance': 'sideways' });
    await app.goto('?doc=welcome');
    expect(await theme(page)).toEqual({ theme: 'golem', scheme: 'golem' });
  });

  test('the canvas desk color follows the theme', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await app.goto('?doc=welcome');
    const light = await cssVar(page, '--wm-desk');
    await choose(app, 'View', 'Color Scheme', 'Dark Mode');
    const dark = await cssVar(page, '--wm-desk');
    expect(dark).not.toBe(light);
    // Draws still work after the switch.
    await expect(app.canvas).toBeVisible();
  });

  test('Dark Mode is one tap in the phone menu', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 390, height: 780 });
    await app.goto('?doc=welcome');
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('dialog', { name: 'Menu' }).getByRole('menuitemcheckbox', { name: /^Dark Mode/ }).click();
    expect((await theme(page)).theme).toBe('dark');
  });
});

async function menuRowClick(page: Page, label: string): Promise<void> {
  await page.locator('.wm-menu .wm-item').filter({ has: page.locator('span.label', { hasText: new RegExp(`^${label}$`) }) }).click();
}
