// Tools › Options › Update automatically: offered only in the desktop app (here a stand-in shell), off until chosen, reachable from
// the keyboard, and kept. When the app then updates itself is checked without a browser (client/test/autoUpdate.test.ts).

import { expect, test } from '../fixtures';
import { vaultShell } from './vaultShell';

test('the desktop app offers to update by itself, off until chosen, and keeps the choice', async ({ page, app }) => {
  await vaultShell(page, {});
  await app.goto('?doc=welcome');
  await app.menu('Tools', 'Options');
  const options = page.getByRole('dialog', { name: 'Options' });
  const choice = options.getByRole('button', { name: 'Update automatically' });
  await expect(choice).toHaveText('Off');
  // From the keyboard: open the list (on Off), go down two to 15 minutes, take it.
  await choice.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('option', { name: 'Off', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'After 15 minutes without activity' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(choice).toHaveText('After 15 minutes without activity');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('golem.autoUpdate'))).toBe('15');
  await page.keyboard.press('Escape');
  await expect(options).toHaveCount(0);

  await page.reload();
  await app.menu('Tools', 'Options');
  await expect(page.getByRole('dialog', { name: 'Options' }).getByRole('button', { name: 'Update automatically' })).toHaveText('After 15 minutes without activity');
});

test('a browser tab is never reloaded on its own, so it does not offer it', async ({ page, app }) => {
  await app.blank();
  await app.menu('Tools', 'Options');
  const options = page.getByRole('dialog', { name: 'Options' });
  await expect(options.getByRole('checkbox').first()).toBeVisible();
  await expect(options.getByRole('button', { name: 'Update automatically' })).toHaveCount(0);
});
