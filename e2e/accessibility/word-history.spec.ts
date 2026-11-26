// Tools › Word Count › Progress for someone with a keyboard and a screen reader: the chart is a named image, its numbers are
// also a table, and the period and view are radio groups moved through with the arrow keys.

import { test, expect, type App } from '../fixtures';

const count = (app: App) => app.page.getByRole('dialog', { name: 'Word Count' });

test('Progress is reachable and readable without a pointer', async ({ app, page }) => {
  await app.blank();
  await app.type('one two three');
  await expect
    .poll(() => page.evaluate(async () => (await (window as unknown as { golem: { doc: { wordHistory(): Promise<{ days: unknown[] } | null> } } }).golem.doc.wordHistory())?.days.length))
    .toBe(1);
  await app.menu('Tools', 'Word Count');
  const periods = count(app).getByRole('radiogroup', { name: 'Period' });
  await expect(periods.getByRole('radio', { name: 'Month' })).toHaveAttribute('aria-checked', 'true');
  await expect(count(app).getByRole('img', { name: /^Words written each day, .+: \+3 words in all\. Most on .+ \(3\)\.$/ })).toBeVisible();

  // The arrow keys choose a period, and the focus stays on the group as the section is redrawn.
  await periods.getByRole('radio', { name: 'Month' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(periods.getByRole('radio', { name: 'Year' })).toHaveAttribute('aria-checked', 'true');
  await expect(periods.getByRole('radio', { name: 'Year' })).toBeFocused();
  await expect(count(app).getByRole('img', { name: /^Words written each month/ })).toBeVisible();

  // The same numbers as a table.
  const views = count(app).getByRole('radiogroup', { name: 'Show as' });
  await views.getByRole('radio', { name: 'Chart' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(views.getByRole('radio', { name: 'Table' })).toBeFocused();
  await expect(count(app).getByRole('columnheader', { name: 'Words written' })).toBeVisible();
  await expect(count(app).getByRole('rowheader').last()).toBeVisible();

  // The status bar's choice has a name, and Escape closes the dialog with the focus back in the document.
  await expect(count(app).getByRole('button', { name: 'Status bar shows:' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(count(app)).toHaveCount(0);
  await expect(app.editor).toBeFocused();
});
