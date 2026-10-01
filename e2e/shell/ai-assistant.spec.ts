import { expect, test } from '../fixtures';
import { choose, isChecked, openMenu, stored } from './helpers';

test.describe('AI assistant visibility', () => {
  test('hiding the AI keeps it hidden after a reload, and View ▸ AI Assistant brings it back', async ({ app, page }) => {
    await app.blank();
    const clip = page.locator('.wm-clip');
    await expect(clip).toBeVisible();
    await openMenu(app, 'View');
    expect(await isChecked(page, 'AI Assistant')).toBe(true);
    await page.keyboard.press('Escape');

    await page.locator('.wm-clip-hide').click({ force: true });
    await expect(clip).toBeHidden();
    await expect.poll(() => stored(page, 'golem.clip.hidden')).toBe('1');

    await page.reload();
    await app.ready();
    await expect(clip).toBeHidden();
    await openMenu(app, 'View');
    expect(await isChecked(page, 'AI Assistant')).toBe(false);
    await page.keyboard.press('Escape');

    await choose(app, 'View', 'AI Assistant');
    await expect(clip).toBeVisible();
    await expect.poll(() => stored(page, 'golem.clip.hidden')).toBeNull();
    await page.reload();
    await app.ready();
    await expect(clip).toBeVisible();
  });

  test('the item is in the View menu, not the Help menu', async ({ app, page }) => {
    await app.blank();
    await openMenu(app, 'Help');
    await expect(page.locator('.wm-menu .wm-item span.label', { hasText: /^AI Assistant$/ })).toHaveCount(0);
  });
});
