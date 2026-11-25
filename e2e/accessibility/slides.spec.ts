// The slides editor without a pointer (docs/slides.md, Accessibility): the slides take the keyboard, Tab moves between a
// slide's shapes and each is announced, Page Down turns slides, F6 reaches the notes pane, and the show's controls are
// buttons with names.

import type { Page } from '@playwright/test';
import { expect, test } from '../files/fixtures';
import { dropFile, fixture, waitForOpen } from '../files/helpers';

const state = (page: Page): Promise<{ current: number; selected: string[]; presenting: number | null }> =>
  page.evaluate(() => (window as unknown as { slidesEditor: { state(): { current: number; selected: string[]; presenting: number | null } } }).slidesEditor.state());

test('the slides are reached and edited from the keyboard', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, { ...fixture('slides/review.pptx'), name: 'review.pptx' });
  await waitForOpen(app, 'review.pptx');
  await expect(page.getByRole('textbox', { name: 'Slides' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await state(page)).selected).toEqual(['Title 1']);
  await expect(page.locator('[aria-live]').filter({ hasText: 'Quarterly review' }).first()).toBeAttached();
  await page.keyboard.press('Escape');
  await page.keyboard.press('PageDown');
  await expect.poll(async () => (await state(page)).current).toBe(1);
  // The notes pane, opened from View, is a labelled text box.
  await app.menu('View', 'Notes');
  await expect(page.getByRole('textbox', { name: 'Speaker notes' })).toBeVisible();
  // The show's controls are named buttons.
  await app.menu('Slide', 'Present from Current Slide');
  await expect(page.getByRole('dialog', { name: 'Slide show' }).getByRole('button', { name: 'End Show' })).toBeAttached();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).presenting).toBe(null);
});
