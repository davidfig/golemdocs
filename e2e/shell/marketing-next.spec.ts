// The next marketing site (client/home/next), a preview the dev server serves at /home/next while it is designed.

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

const PAGES = [
  { path: '/home/next', menu: 'Home', heading: 'Your second brain, for every kind of document.' },
  { path: '/home/next/ai', menu: 'Your ai', heading: 'Ask your ai to help with your documents.' },
  { path: '/home/next/formats', menu: 'Formats', heading: 'If you can name it, you can probably open it.' },
  { path: '/home/next/pricing', menu: 'Pricing', heading: 'Free to use. Paying covers my server bills.' },
  { path: '/home/next/journal', menu: 'Journal', heading: 'What changed lately.' },
  { path: '/home/next/about', menu: 'About', heading: 'Why I built this.' },
  { path: '/home/next/developers', menu: 'Developers', heading: 'Plain files, and a sync you can reason about.' },
  { path: '/home/next/download', menu: 'Download', heading: 'Golem Docs on your computer.' },
] as const;

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

test('every page has its heading, marks itself in the menu, and loads without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const { path, menu, heading } of PAGES) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
    await expect(nav(page).locator('[aria-current="page"]')).toHaveText(menu);
    await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', 'noindex');
  }
  expect(errors).toEqual([]);
});

test('the menu bar goes from page to page', async ({ page }) => {
  await page.goto('/home/next');
  await nav(page).getByRole('link', { name: 'Journal' }).click();
  await expect(page).toHaveURL(/\/home\/next\/journal$/);
  await expect(page.locator('.entry').first()).toBeVisible();
  await nav(page).getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/home\/next$/);
});

test('the demo shows the chat app, and the pane\'s Terminal tab shows it in a terminal', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/home/next');
  const demo = page.locator('#demo');
  await demo.scrollIntoViewIfNeeded();
  await expect(demo.getByRole('tab', { name: 'Chat app' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#chatSteps li')).toHaveCount(5);
  await expect(demo.getByText('Earlier versions: File › Version History')).toBeVisible();
  await demo.getByRole('tab', { name: 'Terminal' }).click();
  await expect(demo.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#chat')).toBeHidden();
  await expect(page.locator('#term')).toContainText('3 files changed.');
});

test('the demo plays in the chat app, then again in the terminal', { tag: '@heavy' }, async ({ page }) => {
  await page.goto('/home/next');
  const demo = page.locator('#demo');
  await demo.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await expect(page.locator('#chatSteps li.last')).toBeVisible({ timeout: 15_000 });
  await expect(demo.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  await expect(page.locator('#term')).toContainText('Golem Docs $ ai');
});

test('the demo keeps its height while it plays and switches, so the page never moves', { tag: '@heavy' }, async ({ page }) => {
  await page.goto('/home/next');
  const demo = page.locator('#demo');
  await demo.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  const height = async () => (await demo.boundingBox())!.height;
  const first = await height();
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(400);
    expect(await height()).toBe(first);
  }
  await demo.getByRole('tab', { name: 'Terminal' }).click();
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(400);
    expect(await height()).toBe(first);
  }
});

test('choosing a file in the editor picture shows a drawing, a PDF or a spreadsheet, each with its own toolbar', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); // no stepping through on its own
  await page.goto('/home/next');
  const editor = page.locator('#editor');
  const shown = editor.locator('.ed-page:visible');
  await expect(shown).toContainText('Garden plan');
  await expect(page.locator('#edTabs')).toBeHidden(); // the sidebar does the choosing
  for (const [file, text] of [['Bed layout.svg', 'Tomatoes'], ['Seed order form.pdf', 'Spring seed order'], ['Seed order.csv', 'San Marzano']] as const) {
    const row = editor.getByRole('button', { name: file });
    await expect(row).toHaveCSS('cursor', 'pointer');
    await row.click();
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await expect(shown).toHaveCount(1);
    await expect(shown).toContainText(text);
    await expect(editor.locator('.tb:visible')).toHaveCount(1);
  }
  await expect(page.locator('#filesHint')).toBeHidden();
  // The keyboard works too.
  await editor.getByRole('button', { name: 'Garden plan.docx' }).focus();
  await page.keyboard.press('Enter');
  await expect(shown).toContainText('Order seeds by March');
});

test('the editor picture steps through the files until one is chosen', async ({ page }) => {
  await page.goto('/home/next');
  const editor = page.locator('#editor');
  await editor.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await expect(editor.locator('.ed-row.current')).toHaveText('Bed layout.svg', { timeout: 8000 });
  await editor.getByRole('button', { name: 'Seed order.csv' }).click();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(4000);
  await expect(editor.locator('.ed-row.current')).toHaveText('Seed order.csv');
});

test('on a phone, where the sidebar is hidden, tabs choose the file', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/home/next');
  await page.getByRole('tab', { name: 'PDF' }).click();
  await expect(page.locator('#editor .ed-page:visible')).toContainText('Spring seed order');
});

test('the developers page copies its AGENTS.md', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/home/next/developers');
  await page.getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^# This folder is my second brain/);
});

test('the download page says the app is not ready before a release is published', async ({ page }) => {
  await page.goto('/home/next/download');
  await expect(page.getByText('The desktop app is not ready to download yet.')).toBeVisible();
});

test('no page scrolls sideways on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const { path } of PAGES) {
    await page.goto(path);
    expect(await noHorizontalScroll(page), path).toBe(true);
  }
});
