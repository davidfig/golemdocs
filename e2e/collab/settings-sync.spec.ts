// Interface settings follow the account: set on one computer, found on another. A phone keeps its own.

import { test, expect, App } from '../fixtures';
import { newPerson, signInAs } from './helpers';
import type { Browser, Page } from '@playwright/test';

const cloud = async (page: Page, profile: string): Promise<Record<string, { value: string | null }>> =>
  ((await (await page.request.get(`/api/preferences?profile=${profile}`)).json()) as { prefs: Record<string, { value: string | null }> }).prefs;

/** Puts settings in the account, as another computer of this person would. */
async function setInAccount(page: Page, prefs: Record<string, string>): Promise<void> {
  const status = await page.evaluate(
    async (prefs) => (await fetch('/api/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'desktop', prefs }) })).status,
    prefs,
  );
  expect(status).toBe(200);
}

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
  // The first load takes the account's settings and shows them.
  await expect.poll(() => second.page.evaluate(() => localStorage.getItem('word.footer')), { timeout: 15_000 }).toBe('off');
  await second.app.ready();
  await expect(second.page.locator('#footer')).toBeHidden();
  await second.context.close();
  await person.context.close();
});

test('settings from the account show at once, without loading the page again, and are not sent back changed', async ({ browser }) => {
  const person = await newPerson(browser, 'noreload');
  await person.app.blank();
  // Its own document type goes up first, or it would land on top of what is put in the account below.
  await expect.poll(async () => (await cloud(person.page, 'desktop'))['golem.newKinds']?.value, { timeout: 15_000 }).toBe('["docx"]');
  // One of each way of applying, so that a page error in any of them fails here.
  const prefs = {
    'golem.newKinds': '["md"]',
    'word.footer': 'off',
    'word.toolbarsShown': 'off',
    'word.ruler': 'on',
    'word.formattingMarks': 'on',
    'word.viewMode': 'flow',
    'golem.appearance': 'dark',
    'wm-shortcuts': '{"help.about":"ctrl+alt+y"}',
    'word.autoFormat': 'off',
    'word.autoCorrect': '["quotes"]',
    'word.spelling.grammar': 'off',
    'word.userDictionary.v1': '["golemish"]',
    'word.fullScreenMenus': 'on',
    'word.scrollPastEnd': 'off',
    'wm.largeWrap': '0',
    'vector.nudgeSize': '50',
  };
  await setInAccount(person.page, prefs);

  const second = await another(browser, person.email);
  // Last here on an older release, so the note about it shows.
  await second.page.addInitScript(() => localStorage.setItem('golem.newVersion.seen', '0.0.1'));
  let loads = 0;
  second.page.on('load', () => loads++);
  const errors: string[] = [];
  second.page.on('pageerror', (e) => errors.push(e.message));
  await second.page.goto('/');
  await second.app.ready();
  await expect(second.page.locator('#footer')).toBeHidden();
  await expect(second.page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => second.page.evaluate(() => localStorage.getItem('golem.newKinds')), { timeout: 15_000 }).toBe('["md"]');
  await expect(second.page.getByRole('complementary', { name: 'New version' })).toBeVisible();
  await second.page.waitForTimeout(3000); // past the next check for changes to send
  expect(loads).toBe(1);
  expect(errors).toEqual([]);
  const inAccount = await cloud(second.page, 'desktop');
  for (const [key, value] of Object.entries(prefs)) expect(inAccount[key]?.value).toBe(value);
  await second.context.close();
  await person.context.close();
});

test('a language from the account shows from the next load', async ({ browser }) => {
  const person = await newPerson(browser, 'language');
  await person.app.blank();
  await setInAccount(person.page, { 'wm.locale': 'de' });

  const second = await another(browser, person.email);
  let loads = 0;
  second.page.on('load', () => loads++);
  await second.page.goto('/');
  await second.app.ready();
  await expect.poll(() => second.page.evaluate(() => localStorage.getItem('wm.locale')), { timeout: 15_000 }).toBe('de');
  await second.page.waitForTimeout(1000);
  expect(loads).toBe(1);
  expect(await second.page.evaluate(() => document.documentElement.lang)).not.toBe('de');
  await second.page.reload();
  await second.app.ready();
  await expect.poll(() => second.page.evaluate(() => document.documentElement.lang)).toBe('de');
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
