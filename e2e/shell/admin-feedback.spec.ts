import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { choose } from './helpers';

const ENTRIES = [
  { id: 2, message: 'Open one\nwith more', createdAt: Date.UTC(2026, 10, 2), resolvedAt: null, from: { name: 'Ada', email: 'ada@example.com' } },
  { id: 1, message: '\nFixed thing\nsecond line', createdAt: Date.UTC(2026, 10, 1), resolvedAt: Date.UTC(2026, 10, 2), from: { name: 'Bob', email: 'bob@example.com' } },
];

/** Signs the page in as an admin and answers the feedback list locally. */
async function asAdmin(page: Page): Promise<void> {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { user: { id: 'e2e-admin', email: 'admin@example.com', name: 'Admin', isAdmin: true } } }),
  );
  await page.route('**/api/admin/feedback', (route) => route.fulfill({ json: ENTRIES }));
}

test.describe('Admin › Feedback', () => {
  test('a resolved entry is collapsed to sender, date and first line, and opens and closes again', async ({ app, page }) => {
    await asAdmin(page);
    await app.blank();
    await choose(app, 'Admin', 'Feedback…');
    const entries = page.locator('.wm-feedback-entry');
    const open = entries.nth(0);
    const resolved = entries.nth(1);

    await expect(open.locator('.wm-feedback-message')).toBeVisible();
    await expect(open.getByRole('button', { name: 'Expand' })).toHaveCount(0);

    await expect(resolved.locator('header')).toContainText('Bob · bob@example.com');
    await expect(resolved.locator('.wm-feedback-summary')).toHaveText('Fixed thing');
    await expect(resolved.locator('.wm-feedback-message')).toBeHidden();
    await expect(resolved.getByRole('button', { name: 'Reopen' })).toBeHidden();

    await resolved.getByRole('button', { name: 'Expand' }).click();
    await expect(resolved.locator('.wm-feedback-message')).toBeVisible();
    await expect(resolved.locator('.wm-feedback-summary')).toBeHidden();
    await expect(resolved.getByRole('button', { name: 'Reopen' })).toBeVisible();

    await resolved.getByRole('button', { name: 'Collapse' }).click();
    await expect(resolved.locator('.wm-feedback-message')).toBeHidden();
  });
});
