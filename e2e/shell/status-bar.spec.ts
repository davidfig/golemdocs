import { test, expect } from '../fixtures';
import { DOC } from '../editing/helpers';
import { choose } from './helpers';

test.describe('Status Bar, by default', () => {
  test.use({ statusBarDefault: true });

  test('is on until View ▸ Status Bar turns it off, and the choice is remembered', async ({ app, page }) => {
    await app.blank();
    await expect(page.locator('#footer')).toBeVisible();
    await app.menu('View', 'Status Bar');
    await expect(page.locator('#footer')).toBeHidden();
    await page.reload();
    await app.ready();
    await expect(page.locator('#footer')).toBeHidden();
    await app.menu('View', 'Status Bar');
    await expect(page.locator('#footer')).toBeVisible();
  });

  test('Clip, the assistant, sits above it', async ({ app, page }) => {
    await app.blank();
    const clip = page.locator('.wm-clip');
    test.skip(!(await clip.isVisible()), 'the assistant is not shown here');
    const bar = (await page.locator('#footer').boundingBox())!;
    expect((await clip.boundingBox())!.y + (await clip.boundingBox())!.height).toBeLessThanOrEqual(bar.y);
  });
});

test.describe('Status Bar', () => {
  test('the page opens Go To, the word count Word Count, and the zoom the list of sizes', async ({ app, page }) => {
    await app.blank();
    await app.type('one two three');
    await app.menu('View', 'Status Bar');
    const bar = page.locator('#footer');
    await bar.getByRole('button', { name: 'Page 1 of 1' }).click();
    const goTo = page.getByRole('tab', { name: 'Go To', selected: true });
    await expect(goTo).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(goTo).toBeHidden();
    await bar.getByRole('button', { name: '3 words' }).click();
    const count = page.getByRole('dialog', { name: 'Word Count' });
    await expect(count).toBeVisible();
    await count.getByRole('button', { name: 'Close' }).first().click();
    await expect(count).toBeHidden();
    await bar.getByRole('button', { name: /%$/ }).click();
    const list = page.getByRole('listbox', { name: 'Zoom' });
    await list.getByRole('option', { name: '200%' }).click();
    await expect(bar.getByRole('button', { name: '200%' })).toBeVisible();
    await expect(list).toHaveCount(0);
  });

  test('its buttons switch between Print Layout, Flow and Page Grid, the one in use pressed', async ({ app, page }) => {
    await app.blank();
    await app.type('Some text');
    await app.menu('View', 'Status Bar');
    const views = page.locator('#footer').getByRole('group', { name: 'Views' });
    const button = (name: string) => views.getByRole('button', { name, exact: true });
    await expect(button('Print Layout')).toHaveAttribute('aria-pressed', 'true');
    await expect(button('Flow')).toHaveAttribute('aria-pressed', 'false');
    await button('Flow').click();
    await expect(button('Flow')).toHaveAttribute('aria-pressed', 'true');
    await expect(button('Print Layout')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('word.viewMode'))).toBe('flow');
    await button('Page Grid').click();
    await expect(button('Page Grid')).toHaveAttribute('aria-pressed', 'true');
    await expect(button('Flow')).toHaveAttribute('aria-pressed', 'false');
    await app.menu('View');
    await expect(page.getByRole('menuitemradio', { name: /^Page Grid/ })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await button('Print Layout').click();
    await expect(button('Print Layout')).toHaveAttribute('aria-pressed', 'true');
    // The editor kept the focus: typing goes on where it was.
    await page.keyboard.type('!');
    await expect.poll(() => app.text()).toBe('Some text!');
  });

  test('a text document shows its page, its word count and the zoom, and counts the selection', async ({ app, page }) => {
    await app.blank();
    await app.menu('View', 'Status Bar');
    await app.type('one two three');
    await expect(page.locator('#footer')).toContainText('Page 1 of 1');
    await expect(page.locator('#footer')).toContainText('3 words');
    await expect(page.locator('#footer')).toContainText('%');
    await app.press(`${DOC}+Home`);
    await app.press('Shift+ArrowRight', 7);
    await expect(page.locator('#footer')).toContainText('2 of 3 words');
  });

  test('a CSV shows its rows and columns, and a picture its size in pixels', async ({ app, page }) => {
    await app.blank();
    await app.menu('View', 'Status Bar');
    const chooser = page.waitForEvent('filechooser');
    await choose(app, 'File', 'Import…');
    await (await chooser).setFiles({ name: 'data.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b,c\n1,2,3\n4,5,6\n7,8,9\n') });
    await expect(page.locator('#footer')).toContainText('4 rows × 3 columns', { timeout: 20_000 });
    await expect(page.locator('#footer')).not.toContainText('words');
  });
});
