import { expect, test } from '../fixtures';
import { clickOnPage, decodePdf, editMode, finalObjects, makePdf, modeButton, openPdf, readBack, showPage, tool } from './helpers';

// Two 18 pt lines: baselines 60 and 100 from the top of a 300 pt page.
const sample = () =>
  makePdf({
    pages: [
      [
        { text: 'Hello PDF world', x: 40, y: 240, size: 18 },
        { text: 'Second line of text', x: 40, y: 200, size: 18 },
      ],
    ],
  });

type App = import('../fixtures').App;
const editor = (app: App) => app.page.getByRole('textbox', { name: 'Edit text' });
const save = async (app: App) => (await app.download(() => app.menu('File', 'Download'))).bytes;
const LINE1: [number, number] = [60, 54];

/** Opens the sample in Edit PDF mode, with the first line picked and its editor focused. */
async function pick(app: App): Promise<void> {
  await openPdf(app, sample());
  await showPage(app.page, 0);
  await editMode(app.page);
  // The page's own text is scanned a moment after it opens, and a click before that picks nothing.
  await expect(async () => {
    await clickOnPage(app.page, 0, ...LINE1);
    await expect(editor(app)).toBeFocused({ timeout: 1500 });
  }).toPass({ timeout: 15_000 });
}

/** Saves the PDF and reads what text the saved file shows. */
const savedText = async (app: App): Promise<string> => readBack(app, await save(app));

test.describe('Edit PDF: text', () => {
  test('clicking a line of text opens it for editing with its own text and style', async ({ app }) => {
    await pick(app);
    await expect(editor(app)).toHaveText('Hello PDF world');
    await expect(app.page.getByRole('spinbutton', { name: 'Size' })).toHaveValue('18');
    await expect(app.page.getByRole('combobox', { name: 'Font' })).toHaveValue('Helvetica');
  });

  test('typing replaces the text, and the saved PDF shows the new text and keeps the rest', async ({ app }) => {
    await pick(app);
    await app.page.keyboard.press('ControlOrMeta+a');
    await app.page.keyboard.type('Changed heading');
    await app.page.keyboard.press('Escape');
    await expect(editor(app)).toBeHidden();
    const text = await savedText(app);
    expect(text).toContain('Changed heading');
    expect(text).not.toContain('Hello PDF world');
    expect(text).toContain('Second line of text');
  });

  test('inserting a word in the middle of a line keeps the characters around it', async ({ app }) => {
    await pick(app);
    await app.page.keyboard.press('End');
    await app.page.keyboard.press('ArrowLeft', { delay: 0 });
    for (let i = 1; i < 'PDF world'.length; i++) await app.page.keyboard.press('ArrowLeft');
    await app.page.keyboard.type('big ');
    await app.page.keyboard.press('Escape');
    expect(await savedText(app)).toContain('Hello big PDF world');
  });

  test.fixme('a click on an empty part of the page right after typing closes the editor and keeps the change', async ({ app }) => {
    await pick(app);
    await app.page.keyboard.press('ControlOrMeta+a');
    await app.page.keyboard.type('Kept');
    // FIXME (app bug): when this click comes within the typing's 250 ms send delay, the editor stays open until a second click.
    await clickOnPage(app.page, 0, 200, 250);
    await expect(editor(app)).toBeHidden();
    expect(await savedText(app)).toContain('Kept');
  });

  test('a click on an empty part of the page closes the editor and keeps the change made a moment ago', async ({ app }) => {
    await pick(app);
    await app.page.keyboard.press('ControlOrMeta+a');
    await app.page.keyboard.type('Kept');
    // Once the typing has reached the worker (250 ms after the last key), a click elsewhere puts the text down.
    await expect.poll(async () => decodePdf(await save(app))).toContain('Kept');
    await clickOnPage(app.page, 0, 200, 250);
    await expect(editor(app)).toBeHidden();
    expect(await savedText(app)).toContain('Kept');
  });

  test('Undo takes a text edit back, Redo does it again', async ({ app }) => {
    await pick(app);
    await app.page.keyboard.press('ControlOrMeta+a');
    await app.page.keyboard.type('Temporary');
    await app.page.keyboard.press('Escape');
    await expect(editor(app)).toBeHidden();
    // The typing reaches the worker a moment after the last key; wait for the edit to be there.
    await expect.poll(async () => decodePdf(await save(app))).toContain('Temporary');
    await app.menu('Edit', 'Undo');
    await expect.poll(async () => decodePdf(await save(app))).not.toContain('Temporary');
    await app.menu('Edit', 'Redo');
    await expect.poll(async () => decodePdf(await save(app))).toContain('Temporary');
  });

  test('font, size and color apply to the whole block in the saved PDF', async ({ app }) => {
    await pick(app);
    await app.page.getByRole('combobox', { name: 'Font' }).selectOption('Times');
    const size = app.page.getByRole('spinbutton', { name: 'Size' });
    await size.fill('30');
    await size.press('Enter');
    await app.page.locator('input[aria-label="Color"]').fill('#ff0000');
    await app.page.keyboard.press('Escape');
    const bytes = await save(app);
    const content = decodePdf(bytes);
    expect(content).toMatch(/\b1 0 0 rg\b/);
    expect(content).toMatch(/\/F\d+ 30 Tf/);
    expect([...finalObjects(bytes).values()].some((d) => /\/BaseFont\s*\/Times-Roman/.test(d))).toBe(true);
    // The second line was not touched.
    expect(content).toMatch(/\/F1 18 Tf[^]*\(Second line of text\) Tj/);
  });

  test('the Bold box switches the block to a bold face', async ({ app }) => {
    await pick(app);
    await app.page.getByRole('checkbox', { name: 'Bold' }).check();
    await app.page.keyboard.press('Escape');
    const bytes = await save(app);
    expect([...finalObjects(bytes).values()].some((d) => /\/BaseFont\s*\/(?:[A-Z]{6}\+)?[\w-]*Bold/.test(d))).toBe(true);
  });

  test('Escape closes the editor without changing anything', async ({ app }) => {
    await pick(app);
    await app.page.keyboard.press('Escape');
    await expect(editor(app)).toBeHidden();
    expect(await savedText(app)).toContain('Hello PDF world');
  });
});

test.describe('Edit PDF: adding text', () => {
  test('the Text tool puts a new text box where the page is clicked', async ({ app }) => {
    await openPdf(app, sample());
    await showPage(app.page, 0);
    await editMode(app.page);
    await tool(app.page, 'text').click();
    await expect(app.page.getByText('Click on a page to add text')).toBeVisible();
    await clickOnPage(app.page, 0, 100, 160);
    await expect(editor(app)).toBeFocused();
    await app.page.keyboard.type('Added note');
    await app.page.keyboard.press('Escape');
    const text = await savedText(app);
    expect(text).toContain('Added note');
    expect(text).toContain('Hello PDF world');
  });

  test('Fill In mode can also put text and a date on the page', async ({ app }) => {
    await openPdf(app, sample());
    await showPage(app.page, 0);
    await tool(app.page, 'text').click();
    await clickOnPage(app.page, 0, 100, 160);
    await expect(editor(app)).toBeFocused();
    await app.page.keyboard.type('Signed here');
    await app.page.keyboard.press('Escape');
    await tool(app.page, 'date').click();
    await clickOnPage(app.page, 0, 100, 230);
    await app.page.keyboard.press('Escape');
    const today = await app.page.evaluate(() => new Date().toLocaleDateString());
    const text = await savedText(app);
    expect(text).toContain('Signed here');
    expect(text).toContain(today);
  });

  test('Escape cancels the Text tool', async ({ app }) => {
    await openPdf(app, sample());
    await showPage(app.page, 0);
    await editMode(app.page);
    await tool(app.page, 'text').click();
    await app.page.keyboard.press('Escape');
    await clickOnPage(app.page, 0, 100, 160);
    await expect(editor(app)).toBeHidden();
  });

  test('check mark and cross tools draw a mark at the click in Fill In mode', async ({ app }) => {
    await openPdf(app, sample());
    await showPage(app.page, 0);
    await tool(app.page, 'check').click();
    await clickOnPage(app.page, 0, 100, 160);
    await tool(app.page, 'cross').click();
    await clickOnPage(app.page, 0, 200, 160);
    // Both are now selectable objects: the palette offers to delete the selected one.
    await expect(app.page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
    await modeButton(app.page, 'Fill In').click();
    const before = decodePdf(await save(app));
    // Two drawn marks: each is a stroked path in the page content.
    expect(before.match(/\bS\b/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test('an added text box can be deleted with the Delete button', async ({ app }) => {
    await openPdf(app, sample());
    await showPage(app.page, 0);
    await editMode(app.page);
    await tool(app.page, 'text').click();
    await clickOnPage(app.page, 0, 100, 160);
    await expect(editor(app)).toBeFocused();
    await app.page.keyboard.type('Remove me');
    await app.page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(editor(app)).toBeHidden();
    expect(await savedText(app)).not.toContain('Remove me');
  });
});
