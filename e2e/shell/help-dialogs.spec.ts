import type { Page } from '@playwright/test';
import { expect, MOD, test } from '../fixtures';
import { choose, isChecked, isMac, menuRow, openMenu, stored } from './helpers';

const shortcutsDialog = (page: Page) => page.locator('dialog', { has: page.locator('.wm-shortcuts') });
const windowStatus = (page: Page) => page.evaluate(() => (window as unknown as { status: string }).status);

test.describe('Keyboard Shortcuts dialog', () => {
  test('F1 opens it, Escape closes it and the document gets the keyboard back', async ({ app, page }) => {
    await app.blank();
    await page.keyboard.press('F1');
    await expect(shortcutsDialog(page)).toBeVisible();
    await expect(shortcutsDialog(page).locator('.wm-dialog-title')).toContainText('Keyboard Shortcuts');
    await page.keyboard.press('Escape');
    await expect(shortcutsDialog(page)).toHaveCount(0);
    await expect(app.editor).toBeFocused();
  });

  test('Help ▸ Keyboard Shortcuts and the toolbar button open it too', async ({ app, page }) => {
    await app.blank();
    await choose(app, 'Help', 'Keyboard Shortcuts');
    await expect(shortcutsDialog(page)).toBeVisible();
    await shortcutsDialog(page).getByRole('button', { name: 'OK' }).click();
    await app.toolbarButton('Keyboard Shortcuts').click();
    await expect(shortcutsDialog(page)).toBeVisible();
  });

  test('lists each command with its shortcut', async ({ app, page }) => {
    await app.blank();
    await page.keyboard.press('F1');
    const row = shortcutsDialog(page).locator('tr', { has: page.locator('td', { hasText: /^Bold$/ }) });
    await expect(row.locator('.wm-shortcut-key')).toHaveText((await isMac(page)) ? '⌘B' : 'Ctrl+B');
    await expect(shortcutsDialog(page).locator('tr', { has: page.locator('td', { hasText: /^Keyboard Shortcuts$/ }) }).locator('.wm-shortcut-key')).toHaveText('F1');
    // Clipboard keys are the browser's own: shown, but fixed.
    await expect(shortcutsDialog(page).locator('tr', { has: page.locator('td', { hasText: /^Copy$/ }) }).locator('.wm-shortcut-key')).toBeDisabled();
  });

  test('a shortcut can be changed, works at once, shows in the menu and is saved', async ({ app, page }) => {
    await app.blank();
    await page.keyboard.press('F1');
    await shortcutsDialog(page).getByRole('button', { name: 'Change shortcut for Page Grid' }).click();
    await expect(shortcutsDialog(page).getByRole('button', { name: 'Change shortcut for Page Grid' })).toHaveText('Press keys…');
    await page.keyboard.press('F9');
    await expect(shortcutsDialog(page).getByRole('button', { name: 'Change shortcut for Page Grid' })).toHaveText('F9');
    await expect.poll(async () => JSON.parse((await stored(page, 'wm-shortcuts')) ?? '{}')['view.grid']).toBe('F9');
    await page.keyboard.press('Escape');
    await app.focus();
    await page.keyboard.press('F9');
    await openMenu(app, 'View');
    expect(await isChecked(page, 'Page Grid')).toBe(true);
    await expect(menuRow(page, 'Page Grid').locator('.wm-shortcut')).toHaveText('F9');
    await page.reload();
    await app.ready();
    await openMenu(app, 'View');
    await expect(menuRow(page, 'Page Grid').locator('.wm-shortcut')).toHaveText('F9');
  });

  test('a key with no modifier is refused, Escape cancels and Backspace clears', async ({ app, page }) => {
    await app.blank();
    await page.keyboard.press('F1');
    const dialog = shortcutsDialog(page);
    const key = dialog.getByRole('button', { name: 'Change shortcut for Page Grid' });
    const original = (await isMac(page)) ? '⌥G' : 'Alt+G';
    await key.click();
    await page.keyboard.press('q');
    await expect(dialog.getByRole('status')).toContainText('Include Ctrl, Alt or');
    await page.keyboard.press('Escape'); // cancels the recording, not the dialog
    await expect(dialog).toBeVisible();
    await expect(key).toHaveText(original);
    await key.click();
    await page.keyboard.press('Backspace');
    await expect(key).toHaveText('None');
    await expect.poll(async () => JSON.parse((await stored(page, 'wm-shortcuts')) ?? '{}')['view.grid']).toBe('');
  });

  test('the Vector Editor section lists Illustrator’s keys and accepts a bare letter', async ({ app, page }) => {
    await app.blank();
    await page.keyboard.press('F1');
    const dialog = shortcutsDialog(page);
    await expect(dialog.locator('th', { hasText: 'Vector Editor' })).toBeVisible();
    const pen = dialog.getByRole('button', { name: 'Change shortcut for Pen', exact: true });
    await expect(pen).toHaveText('P');
    await pen.click();
    await page.keyboard.press('q');
    await expect(pen).toHaveText('Q');
    await expect.poll(async () => JSON.parse((await stored(page, 'wm-shortcuts')) ?? '{}')['vector.pen']).toBe('q');
    // The same letter in the other section is still refused: only vector keys may be bare.
    await dialog.getByRole('button', { name: 'Change shortcut for Page Grid' }).click();
    await page.keyboard.press('q');
    await expect(dialog.getByRole('status')).toContainText('Include Ctrl, Alt or');
  });

  test('giving a command keys another one has takes them away, and Restore Defaults puts everything back', async ({ app, page }) => {
    await app.blank();
    await page.keyboard.press('F1');
    const dialog = shortcutsDialog(page);
    await dialog.getByRole('button', { name: 'Change shortcut for Page Grid' }).click();
    await page.keyboard.press('F1'); // Keyboard Shortcuts' own key
    await expect(dialog.getByRole('status')).toContainText('Keyboard Shortcuts no longer has those keys');
    await expect(dialog.getByRole('button', { name: 'Change shortcut for Keyboard Shortcuts' })).toHaveText('None');
    await dialog.getByRole('button', { name: 'Restore Defaults' }).click();
    await expect(dialog.getByRole('button', { name: 'Change shortcut for Keyboard Shortcuts' })).toHaveText('F1');
    await expect(dialog.getByRole('button', { name: 'Change shortcut for Page Grid' })).toHaveText((await isMac(page)) ? '⌥G' : 'Alt+G');
    await expect.poll(() => stored(page, 'wm-shortcuts')).toBeNull();
  });
});

test.describe('Help menu documents', () => {
  test('About opens the welcome document', async ({ app, page }) => {
    await app.blank();
    await choose(app, 'Help', 'About Golem Docs');
    await expect.poll(() => app.text(), { timeout: 15_000 }).toContain('Welcome to Golem Docs');
    await expect(page).toHaveTitle(/Welcome to Golem Docs/);
  });

  test('What’s New opens the changelog as a document', async ({ app, page }) => {
    await app.blank();
    await choose(app, 'Help', 'What’s New');
    await expect(page).toHaveTitle(/What.s New|Changelog/i);
    await expect.poll(async () => (await app.text()).length, { timeout: 15_000 }).toBeGreaterThan(50);
    const text = await app.text();
    expect(text).toMatch(/Added|Changed|Fixed|Unreleased/);
    expect(new URL(page.url()).pathname).toBe('/changelog');
  });

  test('Privacy Policy and Terms of Service open as documents', async ({ app }) => {
    await app.blank();
    await choose(app, 'Help', 'Privacy Policy');
    await expect.poll(() => app.text(), { timeout: 15_000 }).toMatch(/privacy/i);
    await choose(app, 'Help', 'Terms of Service');
    await expect.poll(() => app.text(), { timeout: 15_000 }).toMatch(/terms/i);
  });

  test('the website item opens the marketing site in another tab', async ({ app, context }) => {
    await app.blank();
    const popup = context.waitForEvent('page');
    await choose(app, 'Help', 'Golem Docs Website');
    const tab = await popup;
    await expect.poll(() => new URL(tab.url()).pathname).toMatch(/^\/home\/?$/);
  });

  test('the Help menu lists its items in order', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await openMenu(app, 'Help');
    const labels = await page.locator('.wm-menu .wm-item span.label').allTextContents();
    expect(labels).toEqual(['Keyboard Shortcuts', 'Send Feedback…', 'What’s New', 'About Golem Docs', 'Golem Docs Website', 'Privacy Policy', 'Terms of Service']);
  });
});

test.describe('Send Feedback', () => {
  test('an empty message is refused with a hint and nothing is sent', async ({ app, page }) => {
    await app.blank();
    let posted = 0;
    await page.route('**/api/feedback', (route) => {
      posted++;
      return route.continue();
    });
    await choose(app, 'Help', 'Send Feedback…');
    const dialog = page.getByRole('dialog', { name: 'Send feedback' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Feedback' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Send' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Write something first.');
    expect(posted).toBe(0);
  });

  test('sending posts the message to /api/feedback, closes the dialog and confirms', async ({ app, page }) => {
    await app.blank();
    await choose(app, 'Help', 'Send Feedback…');
    const dialog = page.getByRole('dialog', { name: 'Send feedback' });
    await dialog.getByRole('textbox', { name: 'Feedback' }).fill('  Love the dark mode.  ');
    const [request] = await Promise.all([
      page.waitForRequest((r) => new URL(r.url()).pathname === '/api/feedback' && r.method() === 'POST'),
      dialog.getByRole('button', { name: 'Send' }).click(),
    ]);
    expect(request.postDataJSON()).toEqual({ message: 'Love the dark mode.' });
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => windowStatus(page)).toBe('Thanks for your feedback.');
    await expect(app.editor).toBeFocused();
  });

  test('a failed send keeps the dialog open with the reason', async ({ app, page }) => {
    await app.blank();
    await page.route('**/api/feedback', (route) => route.fulfill({ status: 500, json: { error: 'server is having a moment' } }));
    await choose(app, 'Help', 'Send Feedback…');
    const dialog = page.getByRole('dialog', { name: 'Send feedback' });
    await dialog.getByRole('textbox', { name: 'Feedback' }).fill('hello');
    await dialog.getByRole('button', { name: 'Send' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Couldn’t send feedback: server is having a moment');
    await expect(dialog.getByRole('button', { name: 'Send' })).toBeEnabled();
    await expect(dialog).toBeVisible();
  });

  test('Cancel and Escape close it without sending', async ({ app, page }) => {
    await app.blank();
    let posted = 0;
    await page.route('**/api/feedback', (route) => {
      posted++;
      return route.continue();
    });
    await choose(app, 'Help', 'Send Feedback…');
    const dialog = page.getByRole('dialog', { name: 'Send feedback' });
    await dialog.getByRole('textbox', { name: 'Feedback' }).fill('never mind');
    await dialog.locator('.wm-dialog-buttons').getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await choose(app, 'Help', 'Send Feedback…');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(posted).toBe(0);
    await expect(app.editor).toBeFocused();
  });

  test('typing in the dialog does not edit the document behind it', async ({ app, page }) => {
    await app.blank();
    await app.type('keep');
    await choose(app, 'Help', 'Send Feedback…');
    await page.keyboard.type('feedback text');
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.press('Escape');
    expect(await app.text()).toBe('keep');
  });
});
