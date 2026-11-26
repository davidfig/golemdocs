// The slides' design commands without a pointer (docs/slides.md, M5): the Theme dialog's lists and choices are reached and
// changed with the keyboard and named, Escape gives the keyboard back to the slides, and master view is entered from the
// menu, announced, and left with Escape or its named button.

import type { Page } from '@playwright/test';
import { expect, test } from '../files/fixtures';
import { dropFile, fixture, waitForOpen } from '../files/helpers';

const masterView = (page: Page): Promise<boolean> => page.evaluate(() => (window as unknown as { slidesEditor: { state(): { masterView: boolean } } }).slidesEditor.state().masterView);

test('Theme and Background are worked from the keyboard, and master view is left with Escape', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, { ...fixture('slides/review.pptx'), name: 'review.pptx' });
  await waitForOpen(app, 'review.pptx');
  const slides = page.getByRole('textbox', { name: 'Slides' });
  await expect(slides).toBeFocused();

  await app.menu('Slide', 'Theme');
  const theme = page.getByRole('dialog', { name: 'Theme' });
  const colors = theme.getByRole('listbox', { name: 'Colors' });
  await expect(colors).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(colors.getByRole('option', { selected: true })).toHaveText('Office 2013–2022');
  await page.keyboard.press('Tab');
  await expect(theme.getByRole('listbox', { name: 'Fonts' })).toBeFocused();
  await expect(theme.getByRole('radiogroup', { name: 'Slides' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(theme).toBeHidden();
  await expect(slides).toBeFocused();

  // The Background dialog starts on its fill choices, a named radio group.
  await app.menu('Slide', 'Background');
  const background = page.getByRole('dialog', { name: 'Background' });
  await expect(background.getByRole('radiogroup', { name: 'Fill' }).getByRole('radio', { name: 'Solid' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(background.getByRole('radio', { name: 'Gradient' })).toHaveAttribute('aria-checked', 'true');
  await expect(background.getByRole('button', { name: 'From' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(background).toBeHidden();

  await app.menu('View', 'Edit Master');
  await expect.poll(() => masterView(page)).toBe(true);
  await expect(page.locator('[aria-live]').filter({ hasText: 'Master view' }).first()).toBeAttached();
  await expect(page.getByRole('region', { name: 'Slide Master' }).getByRole('button', { name: 'Close Master View' })).toBeVisible();
  await slides.focus();
  await page.keyboard.press('Escape');
  await expect.poll(() => masterView(page)).toBe(false);
  await expect(page.getByRole('region', { name: 'Slide Master' })).toBeHidden();
});
