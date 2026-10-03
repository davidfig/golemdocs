import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { choose, isChecked, openMenu, seedStorage, stored } from './helpers';
import { pngPixels } from '../layout/helpers';

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

  test('the loading screen is the desk color, so nothing flashes when it lifts', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await app.goto('?doc=welcome');
    const colors = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.background = 'var(--wm-desk)';
      document.body.append(probe);
      const desk = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { desk, loading: getComputedStyle(document.querySelector('.wm-loading')!).backgroundColor };
    });
    expect(colors.loading).toBe(colors.desk);
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

test.describe('dark pages', () => {
  const pagesAttr = (page: Page) => page.evaluate(() => document.documentElement.dataset.pages ?? null);

  /** Most pixels across the middle of the canvas, where the first page is: light (> 128) or dark. */
  async function pageIsLight(canvas: Locator): Promise<boolean> {
    const img = pngPixels(await canvas.screenshot());
    let light = 0;
    let total = 0;
    const y = Math.floor(img.height / 2);
    for (let x = Math.floor(img.width * 0.3); x < img.width * 0.7; x++) {
      const i = (y * img.width + x) * 4;
      if ((img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3 > 128) light++;
      total++;
    }
    return light > total / 2;
  }

  test('Dark Pages turns the pages dark along with the rest, and is remembered', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await app.goto('?doc=welcome');
    expect(await pageIsLight(app.canvas)).toBe(true);
    await choose(app, 'View', 'Color Scheme', 'Dark Pages');
    expect(await theme(page)).toEqual({ theme: 'dark', scheme: 'golem' });
    expect(await pagesAttr(page)).toBe('dark');
    await expect.poll(() => pageIsLight(app.canvas)).toBe(false);
    await expect.poll(() => stored(page, 'golem.darkPages')).toBe('on');
    await expect.poll(() => stored(page, 'golem.appearance')).toBe('dark');
    await page.reload();
    await app.ready();
    expect(await pagesAttr(page)).toBe('dark');
    await openMenu(app, 'View');
    await page.locator('.wm-menu .wm-item', { hasText: 'Color Scheme' }).hover();
    expect(await isChecked(page, 'Dark Pages')).toBe(true);
    expect(await isChecked(page, 'Dark Mode')).toBe(true);
  });

  test('turning Dark Pages off keeps dark mode with white pages', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await seedStorage(page, { 'golem.appearance': 'dark', 'golem.darkPages': 'on' });
    await app.goto('?doc=welcome');
    expect(await pagesAttr(page)).toBe('dark');
    await choose(app, 'View', 'Color Scheme', 'Dark Pages');
    expect(await pagesAttr(page)).toBeNull();
    expect((await theme(page)).theme).toBe('dark');
    await expect.poll(() => pageIsLight(app.canvas)).toBe(true);
    await expect.poll(() => stored(page, 'golem.darkPages')).toBe('off');
  });

  test('Dark Mode off shows white pages, and back on brings the dark pages back', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await seedStorage(page, { 'golem.appearance': 'dark', 'golem.darkPages': 'on' });
    await app.goto('?doc=welcome');
    await choose(app, 'View', 'Color Scheme', 'Dark Mode');
    expect((await theme(page)).theme).toBe('golem');
    expect(await pagesAttr(page)).toBeNull();
    await choose(app, 'View', 'Color Scheme', 'Dark Mode');
    expect(await pagesAttr(page)).toBe('dark');
  });

  test.describe('Page Sidebar', () => {
    test.use({ sidebarDefault: true });

    /** Most pixels of the first thumbnail are light (> 128). */
    const thumbLight = (page: Page) =>
      page.locator('.wm-pages-item canvas').first().evaluate((c: HTMLCanvasElement) => {
        const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let light = 0;
        for (let i = 0; i < data.length; i += 4) if ((data[i] + data[i + 1] + data[i + 2]) / 3 > 128) light++;
        return light > data.length / 8;
      });

    test('the thumbnails turn dark and back with Dark Pages', async ({ app, page }) => {
      await page.emulateMedia({ colorScheme: 'light' });
      await app.goto('?doc=welcome');
      await expect(page.locator('.wm-pages')).toBeVisible();
      await expect.poll(() => thumbLight(page)).toBe(true);
      // Redrawn in the same moment as the switch, not after a pause showing the old colors.
      await choose(app, 'View', 'Color Scheme', 'Dark Pages');
      expect(await thumbLight(page)).toBe(false);
      await choose(app, 'View', 'Color Scheme', 'Dark Pages');
      expect(await thumbLight(page)).toBe(true);
    });

    test('a thumbnail not drawn yet is dark, not white, under Dark Pages', async ({ app, page }) => {
      await page.emulateMedia({ colorScheme: 'light' });
      await seedStorage(page, { 'golem.appearance': 'dark', 'golem.darkPages': 'on' });
      await app.goto('?doc=welcome');
      const background = await page.locator('.wm-pages-thumb').first().evaluate((c) => getComputedStyle(c).backgroundColor);
      expect(background).toBe('rgb(40, 41, 45)');
    });
  });

  test('under Match System, Dark Pages follows a dark system', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await seedStorage(page, { 'golem.darkPages': 'on' });
    await app.goto('?doc=welcome');
    expect(await pagesAttr(page)).toBeNull();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => pagesAttr(page)).toBe('dark');
  });
});

async function menuRowClick(page: Page, label: string): Promise<void> {
  await page.locator('.wm-menu .wm-item').filter({ has: page.locator('span.label', { hasText: new RegExp(`^${label}$`) }) }).click();
}
