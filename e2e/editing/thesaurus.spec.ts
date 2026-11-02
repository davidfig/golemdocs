import { test, expect, type App } from '../fixtures';
import { DOC, clickAt, dialog, lineGaps } from './helpers';

const thesaurus = (app: App) => dialog(app.page, 'Thesaurus');
const btn = (app: App, name: string) => thesaurus(app).getByRole('button', { name, exact: true }).last();
const list = (app: App, name: string) => thesaurus(app).getByRole('listbox', { name });

async function withText(app: App, text: string) {
  await app.blank();
  await app.editor.focus();
  await app.page.keyboard.insertText(text);
  await expect.poll(() => app.text()).toBe(text);
  await app.press(`${DOC}+Home`);
}

test.describe('Thesaurus', () => {
  test('Shift+F7 looks up the word at the caret, and Replace puts the synonym in its place', async ({ app }) => {
    await withText(app, 'Happy days are here.');
    await app.press('ArrowRight', 2); // inside "Happy"
    await app.press('Shift+F7');
    await expect(thesaurus(app)).toBeVisible();
    await expect.poll(() => app.selectedText()).toBe('Happy');
    await expect(thesaurus(app).getByRole('textbox', { name: 'Looked up' })).toHaveValue('Happy');
    await expect(list(app, 'Meanings').getByRole('option').first()).toBeVisible();
    await list(app, 'Synonyms').getByRole('option', { name: 'glad', exact: true }).click();
    // The synonym takes the capital of the word it replaces.
    await expect(thesaurus(app).getByRole('textbox', { name: 'Replace with' })).toHaveValue('Glad');
    await btn(app, 'Replace').click();
    await expect(thesaurus(app)).toBeHidden();
    await expect.poll(() => app.text()).toBe('Glad days are here.');
  });

  test('a double click looks a synonym up, and Previous goes back', async ({ app }) => {
    await withText(app, 'big');
    await app.press('Shift+F7');
    const lookedUp = thesaurus(app).getByRole('textbox', { name: 'Looked up' });
    await expect(lookedUp).toHaveValue('big');
    await list(app, 'Synonyms').getByRole('option', { name: 'large', exact: true }).dblclick();
    await expect(lookedUp).toHaveValue('large');
    await btn(app, 'Previous').click();
    await expect(lookedUp).toHaveValue('big');
  });

  test('a word it does not know says so', async ({ app }) => {
    await withText(app, 'zqxwv');
    await app.press('Shift+F7');
    await expect(thesaurus(app).getByText('No synonyms found for “zqxwv”.')).toBeVisible();
    await expect(btn(app, 'Replace')).toBeDisabled();
    await app.press('Escape');
    await expect(thesaurus(app)).toBeHidden();
  });

  test('right-clicking a word offers its synonyms', async ({ app }) => {
    const text = 'The quick fox is in the garden.';
    await withText(app, text);
    const gaps = await lineGaps(app, text.length);
    await clickAt(app, { x: (gaps[4].x + gaps[9].x) / 2, y: gaps[0].y }, { button: 'right' });
    const popup = app.page.getByRole('menu', { name: 'Synonyms' }).first();
    await popup.getByRole('menuitem', { name: 'Synonyms', exact: true }).hover();
    await app.page.getByRole('menuitem', { name: 'speedy', exact: true }).click();
    await expect.poll(() => app.text()).toBe('The speedy fox is in the garden.');
  });

  test('the menu opens at once while the thesaurus is still downloading, and the synonyms fill in when it arrives', async ({ app }) => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await app.page.context().route('**/dictionaries/th_en_US.txt', async (route) => {
      await held;
      await route.continue();
    });
    const text = 'The quick fox is in the garden.';
    await withText(app, text);
    const gaps = await lineGaps(app, text.length);
    await clickAt(app, { x: (gaps[4].x + gaps[9].x) / 2, y: gaps[0].y }, { button: 'right' });
    const popup = app.page.getByRole('menu', { name: 'Synonyms' }).first();
    await expect(popup.getByRole('menuitem', { name: 'Thesaurus', exact: true })).toBeVisible();
    await popup.getByRole('menuitem', { name: 'Synonyms', exact: true }).hover();
    await expect(app.page.getByRole('menuitem', { name: 'Loading…', exact: true })).toBeVisible();
    release();
    await app.page.getByRole('menuitem', { name: 'speedy', exact: true }).click();
    await expect.poll(() => app.text()).toBe('The speedy fox is in the garden.');
  });
});
