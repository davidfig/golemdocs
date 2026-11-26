// Page view (docs/html-pages.md) with a screen reader or the keyboard alone: the page is a named region with a named bar, Page,
// Document and Source are a radio group, where it came from is said in words, F6 reaches it, and Escape in the page goes to the bar.

import { expect, test } from '../files/fixtures';
import { dropFile, text } from '../files/helpers';

const PAGE = '<!doctype html><title>Keys</title><h1>Keys</h1><button id="inside" type="button">Inside</button><script>document.body.dataset.ran = "yes";</script>';

test('page view is named, its choices are a radio group, and the keyboard reaches it and leaves the page', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, text('Keys.html', PAGE));
  const region = page.getByRole('region', { name: 'Keys.html' });
  await expect(region).toBeVisible({ timeout: 30_000 });
  const bar = region.getByRole('toolbar', { name: 'Page' });
  const views = bar.getByRole('radiogroup', { name: 'Show as' });
  for (const name of ['Page', 'Document', 'Source']) await expect(views.getByRole('radio', { name })).toBeVisible();
  await expect(views.getByRole('radio', { name: 'Page' })).toHaveAttribute('aria-checked', 'true');
  await expect(bar.getByText('From elsewhere', { exact: true })).toBeVisible();
  await expect(region.getByRole('status')).toContainText('came from elsewhere');
  await expect(region.locator('iframe')).toHaveAttribute('title', 'Keys.html');

  await page.keyboard.press('F10');
  for (let i = 0; i < 8 && !(await region.evaluate((el) => el.contains(document.activeElement))); i++) await page.keyboard.press('F6');
  await expect.poll(() => region.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  const frame = page.frameLocator('iframe.wm-page-frame');
  await frame.locator('body[data-ran="yes"]').waitFor({ state: 'attached' });
  await frame.getByRole('button', { name: 'Inside' }).focus();
  await page.keyboard.press('Escape');
  await expect.poll(() => bar.evaluate((el) => el.contains(document.activeElement))).toBe(true);
});
