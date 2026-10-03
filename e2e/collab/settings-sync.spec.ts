// Interface settings follow the account: set on one computer, found on another. A phone keeps its own.

import { test, expect, App } from '../fixtures';
import { newPerson, signInAs } from './helpers';
import type { Browser, Page } from '@playwright/test';

const cloud = async (page: Page, profile: string): Promise<Record<string, { value: string | null }>> =>
  ((await (await page.request.get(`/api/preferences?profile=${profile}`)).json()) as { prefs: Record<string, { value: string | null }> }).prefs;

async function another(browser: Browser, email: string, options: Parameters<Browser['newContext']>[0] = {}) {
  const context = await browser.newContext(options);
  await signInAs(context, email);
  const page = await context.newPage();
  return { context, page, app: new App(page) };
}

test('a setting made on one computer is there on the next, and the status bar is one of them', async ({ browser }) => {
  const person = await newPerson(browser, 'settings');
  await person.app.blank();
  await expect(person.page.locator('#footer')).toBeVisible();
  await person.app.menu('View', 'Status Bar');
  await expect(person.page.locator('#footer')).toBeHidden();
  await expect.poll(async () => (await cloud(person.page, 'desktop'))['word.footer']?.value, { timeout: 15_000 }).toBe('off');

  const second = await another(browser, person.email);
  await second.page.goto('/');
  await second.app.ready();
  // The first load takes the account's settings and reloads once to show them.
  await expect.poll(() => second.page.evaluate(() => localStorage.getItem('word.footer')), { timeout: 15_000 }).toBe('off');
  await second.app.ready();
  await expect(second.page.locator('#footer')).toBeHidden();
  await second.context.close();
  await person.context.close();
});

test('a phone has settings of its own', async ({ browser }) => {
  const person = await newPerson(browser, 'phone');
  await person.app.blank();
  await person.app.menu('View', 'Status Bar');
  await expect.poll(async () => (await cloud(person.page, 'desktop'))['word.footer']?.value, { timeout: 15_000 }).toBe('off');

  const phone = await another(browser, person.email, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.page.goto('/');
  await phone.app.ready();
  await phone.page.waitForTimeout(1500);
  expect(await phone.page.evaluate(() => localStorage.getItem('word.footer'))).toBeNull(); // the computer's choice does not reach it
  expect(Object.keys(await cloud(phone.page, 'mobile'))).not.toContain('word.footer');
  await phone.context.close();
  await person.context.close();
});
