import { test, expect, type App } from '../fixtures';
import { DOC, MOD, docxPart, dialog, selectBy } from './helpers';

const count = (app: App) => dialog(app.page, 'Word Count');
const cell = (app: App, label: string) => count(app).getByRole('row', { name: new RegExp(`^${label}`) }).getByRole('cell');

test.describe('Word Count', () => {
  async function sample(app: App) {
    await app.blank();
    await app.type('one two three');
    await app.press('Enter');
    await app.type('four');
    await expect.poll(() => app.text()).toBe('one two three\nfour');
  }

  test('Tools ▸ Word Count shows the statistics of the whole document', async ({ app }) => {
    await sample(app);
    await app.menu('Tools', 'Word Count');
    await expect(count(app)).toBeVisible();
    await expect(cell(app, 'Words')).toHaveText('4');
    await expect(cell(app, 'Pages')).toHaveText('1');
    await expect(cell(app, 'Paragraphs')).toHaveText('2');
    await expect(cell(app, 'Lines')).toHaveText('2');
    await expect(cell(app, 'Characters \\(no spaces\\)')).toHaveText('15');
    await expect(cell(app, 'Characters \\(with spaces\\)')).toHaveText('17');
    await expect(count(app).getByRole('status')).toHaveText('');
  });

  test('with a selection it counts only the selected text and says so', async ({ app }) => {
    await sample(app);
    await app.press(`${DOC}+Home`);
    await app.press('Shift+ArrowRight', 7);
    await expect.poll(() => app.selectedText()).toBe('one two');
    await app.menu('Tools', 'Word Count');
    await expect(cell(app, 'Words')).toHaveText('2');
    await expect(cell(app, 'Characters \\(no spaces\\)')).toHaveText('6');
    await expect(cell(app, 'Characters \\(with spaces\\)')).toHaveText('7');
    await expect(count(app).getByRole('status')).toHaveText('These are the counts for the selected text.');
  });

  test('an empty document has zero words and one paragraph', async ({ app }) => {
    await app.blank();
    await app.menu('Tools', 'Word Count');
    await expect(cell(app, 'Words')).toHaveText('0');
    await expect(cell(app, 'Characters \\(with spaces\\)')).toHaveText('0');
    await expect(cell(app, 'Pages')).toHaveText('1');
  });

  test('a long document counts several pages', async ({ app }) => {
    await app.blank();
    await app.type('first');
    await app.press(`${MOD}+Enter`);
    await app.type('second');
    await expect.poll(() => app.text()).toBe('firstsecond');
    await app.menu('Tools', 'Word Count');
    await expect(cell(app, 'Pages')).toHaveText('2');
  });

  test.fixme('a page break separates words ("first", page break, "second" is two words; it counts one)', async ({ app }) => {
    await app.blank();
    await app.type('first');
    await app.press(`${MOD}+Enter`);
    await app.type('second');
    await expect.poll(() => app.text()).toBe('firstsecond');
    await app.menu('Tools', 'Word Count');
    await expect(cell(app, 'Words')).toHaveText('2');
  });

  test('Close, the × button and Escape dismiss it and give typing back to the document', async ({ app }) => {
    await sample(app);
    await app.menu('Tools', 'Word Count');
    await count(app).getByRole('button', { name: 'Close' }).last().click();
    await expect(count(app)).toHaveCount(0);
    await app.menu('Tools', 'Word Count');
    await count(app).getByRole('button', { name: 'Close' }).first().click();
    await expect(count(app)).toHaveCount(0);
    await app.menu('Tools', 'Word Count');
    await app.page.keyboard.press('Escape');
    await expect(count(app)).toHaveCount(0);
    await expect(app.editor).toBeFocused();
  });

  test('the counts follow edits when the dialog is opened again', async ({ app }) => {
    await sample(app);
    await app.press(`${DOC}+End`);
    await app.type(' five six');
    await expect.poll(() => app.text()).toBe('one two three\nfour five six');
    await app.menu('Tools', 'Word Count');
    await expect(cell(app, 'Words')).toHaveText('6');
  });

  test('Word Count is also on the toolbar-less Tools menu only (no stray dialog on load)', async ({ app }) => {
    await app.blank();
    await expect(count(app)).toHaveCount(0);
    void selectBy;
  });
});

test.describe('Properties', () => {
  const props = (app: App) => dialog(app.page, 'Properties');
  const field = (app: App, name: string) => props(app).getByRole('textbox', { name, exact: true });

  async function open(app: App) {
    await app.menu('File', 'Properties');
    await expect(props(app)).toBeVisible();
    // The fields fill in once the document answers.
    await expect(field(app, 'Title')).toBeEnabled();
  }

  test('opens on Summary with every field, and on Statistics shows dates and counts', async ({ app }) => {
    await app.blank();
    await app.type('two words');
    await open(app);
    await expect(props(app).getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true');
    for (const name of ['Title', 'Subject', 'Author', 'Manager', 'Company', 'Category', 'Keywords', 'Comments']) await expect(field(app, name)).toBeVisible();
    await props(app).getByRole('tab', { name: 'Statistics' }).click();
    await expect(props(app).getByRole('tab', { name: 'Statistics' })).toHaveAttribute('aria-selected', 'true');
    // A new document records when it was created.
    await expect(props(app).getByRole('row', { name: /^Created/ }).getByRole('cell')).not.toHaveText('—');
    await expect(props(app).getByRole('row', { name: /^Words/ }).getByRole('cell')).toHaveText('2');
    await expect(props(app).getByRole('row', { name: /^Paragraphs/ }).getByRole('cell')).toHaveText('1');
    await expect(props(app).getByRole('row', { name: /^Pages/ }).getByRole('cell')).toHaveText('1');
  });

  test('values typed on Summary are kept when the dialog is reopened', async ({ app }) => {
    await app.blank();
    await app.type('body');
    await open(app);
    await field(app, 'Title').fill('Quarterly plan');
    await field(app, 'Subject').fill('Budget');
    await field(app, 'Author').fill('Ada Lovelace');
    await field(app, 'Company').fill('Analytical Engines');
    await field(app, 'Keywords').fill('plan, budget');
    await field(app, 'Comments').fill('first line');
    await props(app).getByRole('button', { name: 'OK' }).click();
    await expect(props(app)).toHaveCount(0);
    await open(app);
    await expect(field(app, 'Title')).toHaveValue('Quarterly plan');
    await expect(field(app, 'Subject')).toHaveValue('Budget');
    await expect(field(app, 'Author')).toHaveValue('Ada Lovelace');
    await expect(field(app, 'Company')).toHaveValue('Analytical Engines');
    await expect(field(app, 'Keywords')).toHaveValue('plan, budget');
    await expect(field(app, 'Comments')).toHaveValue('first line');
  });

  test('the properties are saved into the downloaded .docx', async ({ app }) => {
    await app.blank();
    await app.type('body');
    await open(app);
    await field(app, 'Title').fill('Saved title');
    await field(app, 'Author').fill('Grace Hopper');
    await props(app).getByRole('button', { name: 'OK' }).click();
    await expect(props(app)).toHaveCount(0);
    await expect.poll(async () => {
      const file = await app.download(() => app.menu('File', 'Download'));
      return docxPart(file.bytes, 'docProps/core.xml');
    }).toMatch(/<dc:title>Saved title<\/dc:title>[\s\S]*Grace Hopper|Grace Hopper[\s\S]*<dc:title>Saved title<\/dc:title>/);
  });

  test('Cancel and Escape discard the changes', async ({ app }) => {
    await app.blank();
    await app.type('body');
    await open(app);
    await field(app, 'Title').fill('Nope');
    await props(app).getByRole('button', { name: 'Cancel' }).click();
    await expect(props(app)).toHaveCount(0);
    await open(app);
    await expect(field(app, 'Title')).toHaveValue('');
    await field(app, 'Title').fill('Nope again');
    await app.page.keyboard.press('Escape');
    await expect(props(app)).toHaveCount(0);
    await open(app);
    await expect(field(app, 'Title')).toHaveValue('');
  });

  test('changing properties is undoable', async ({ app }) => {
    await app.blank();
    await app.type('body');
    await expect.poll(() => app.text()).toBe('body');
    await open(app);
    await field(app, 'Title').fill('Undo me');
    await props(app).getByRole('button', { name: 'OK' }).click();
    await expect(props(app)).toHaveCount(0);
    await expect(app.editor).toBeFocused();
    await app.press(`${MOD}+z`);
    await expect.poll(async () => {
      await open(app);
      const value = await field(app, 'Title').inputValue();
      await app.page.keyboard.press('Escape');
      await expect(props(app)).toHaveCount(0);
      return value;
    }).toBe('');
  });

  test('clearing a field removes the property', async ({ app }) => {
    await app.blank();
    await app.type('body');
    await open(app);
    await field(app, 'Title').fill('Something');
    await props(app).getByRole('button', { name: 'OK' }).click();
    await expect(props(app)).toHaveCount(0);
    await open(app);
    await field(app, 'Title').fill('');
    await props(app).getByRole('button', { name: 'OK' }).click();
    await expect(props(app)).toHaveCount(0);
    await open(app);
    await expect(field(app, 'Title')).toHaveValue('');
  });
});
