// The word history (client/src/wordHistory.ts): Tools › Word Count's Progress, and the status bar counting the words written
// today, this week, this month or this year (chosen there or in Tools › Options).

import { test, expect, pickChoice, type App } from '../fixtures';
import { dialog } from './helpers';

const count = (app: App) => dialog(app.page, 'Word Count');
const row = (app: App, label: string) => count(app).getByRole('row', { name: new RegExp(`^${label}`) }).getByRole('cell');
const history = (app: App) => app.page.evaluate(() => (window as unknown as { golem: { doc: { wordHistory(): Promise<{ today: string; days: { day: string; words: number; start: number | null }[] } | null> } } }).golem.doc.wordHistory());

test.describe('Word history', () => {
  test.use({ statusBarDefault: true });

  test('the words written today are kept, and Progress shows them', async ({ app }) => {
    await app.blank();
    await app.type('one two three four');
    await expect.poll(async () => (await history(app))?.days.at(-1)?.words).toBe(4);
    const kept = (await history(app))!;
    expect(kept.days).toEqual([{ day: kept.today, words: 4, start: 0 }]);
    await app.menu('Tools', 'Word Count');
    await expect(count(app).getByRole('heading', { name: 'Progress' })).toBeVisible();
    await expect(row(app, 'Written today')).toHaveText('+4');
    await expect(row(app, 'Written this week')).toHaveText('+4');
    await expect(count(app).getByRole('img', { name: /^Words written each day/ })).toBeVisible();
  });

  test('the progress can be shown as a table, by day or by month', async ({ app }) => {
    await app.blank();
    await app.type('one two');
    await expect.poll(async () => (await history(app))?.days.length).toBe(1);
    await app.menu('Tools', 'Word Count');
    await count(app).getByRole('radio', { name: 'Table' }).click();
    const table = count(app).locator('.wm-writing-table');
    await expect(table.getByRole('columnheader', { name: 'Day' })).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table.getByRole('row').last().getByRole('cell')).toHaveText('+2');
    await count(app).getByRole('radio', { name: 'Year' }).click();
    await expect(table.getByRole('columnheader', { name: 'Month' })).toBeVisible();
    await expect(count(app).getByRole('radio', { name: 'Table' })).toHaveAttribute('aria-checked', 'true');
  });

  test('the status bar counts what the dialog says: the words written today, then the whole document again', async ({ app, page }) => {
    await app.blank();
    await app.type('one two three');
    await expect(page.locator('#footer')).toContainText('3 words');
    await app.menu('Tools', 'Word Count');
    await pickChoice(count(app).getByRole('button', { name: 'Status bar shows:' }), 'Words written today');
    await count(app).getByRole('button', { name: 'Close' }).last().click();
    await expect(page.locator('#footer')).toContainText('3 words today');
    await app.type(' four');
    await expect(page.locator('#footer')).toContainText('4 words today');
    // A click on it opens Word Count.
    await page.locator('#footer').getByRole('button', { name: '4 words today' }).click();
    await expect(count(app)).toBeVisible();
    await pickChoice(count(app).getByRole('button', { name: 'Status bar shows:' }), 'Words in the document');
    await page.keyboard.press('Escape');
    await expect(page.locator('#footer')).toContainText('4 words');
    await expect(page.locator('#footer')).not.toContainText('today');
  });

  test('Tools › Options sets the same choice', async ({ app, page }) => {
    await app.blank();
    await app.type('one two');
    await app.menu('Tools', 'Options');
    const options = dialog(page, 'Options');
    await pickChoice(options.getByRole('button', { name: 'Status bar shows:' }), 'Words written this month');
    await page.keyboard.press('Escape');
    await expect(page.locator('#footer')).toContainText('2 words this month');
  });

  test('typing and taking it back keeps the day, with nothing written', async ({ app }) => {
    await app.blank();
    await app.type('hello');
    await expect.poll(async () => (await history(app))?.days.at(-1)?.words).toBe(1);
    await app.press('Backspace', 5);
    await expect.poll(() => app.text()).toBe('');
    await expect.poll(async () => (await history(app))?.days.at(-1)?.words).toBe(0);
    expect((await history(app))!.days.map((d) => d.words - (d.start ?? 0))).toEqual([0]);
    await app.menu('Tools', 'Word Count');
    await expect(row(app, 'Written today')).toHaveText('0');
  });

  test('moving around the document is not writing', async ({ app }) => {
    await app.blank();
    await app.type('one two');
    await expect.poll(async () => (await history(app))?.days.length).toBe(1);
    await app.press('ArrowLeft', 3);
    await app.menu('Tools', 'Word Count');
    await expect(row(app, 'Written today')).toHaveText('+2');
  });
});
