import { expect, test } from '../fixtures';
import { clickOnPage, editMode, fieldDicts, makePdf, openPdf, rectIn, showPage } from './helpers';

const form = () =>
  makePdf({
    pages: [[{ text: 'Sign up', x: 40, y: 270, size: 16 }]],
    fields: [
      { kind: 'text', name: 'FullName', rect: [40, 220, 240, 240] },
      { kind: 'choice', name: 'Country', rect: [40, 160, 200, 180], options: ['Norway', 'Peru'] },
    ],
  });

type P = import('@playwright/test').Page;
const box = (page: P, name: string) => page.locator(`.wm-field-box[title$=": ${name}"]`);
/** The fields of the PDF the app downloads now, by name. */
const dl = async (app: import('../fixtures').App) => fieldDicts((await app.download(() => app.menu('File', 'Download'))).bytes);
const rounded = (r: number[]) => r.map((n) => Math.round(n * 10) / 10);

test.describe('Edit PDF: form fields', () => {
  test.beforeEach(async ({ app }) => {
    await openPdf(app, form());
    await showPage(app.page, 0);
    await editMode(app.page);
  });

  test('fields show as labelled boxes, and selecting one shows its name in the palette', async ({ app }) => {
    await expect(box(app.page, 'FullName')).toBeVisible();
    await expect(box(app.page, 'FullName')).toContainText('FullName');
    await box(app.page, 'FullName').click();
    await expect(app.page.getByRole('textbox', { name: 'Field name' })).toHaveValue('FullName');
  });

  test('renaming a field changes its name in the downloaded PDF', async ({ app }) => {
    await box(app.page, 'FullName').click();
    const name = app.page.getByRole('textbox', { name: 'Field name' });
    await name.fill('Applicant');
    await name.press('Enter');
    await expect(box(app.page, 'Applicant')).toBeVisible();
    const fields = await dl(app);
    expect(Object.keys(fields)).toContain('Applicant');
    expect(Object.keys(fields)).not.toContain('FullName');
  });

  test('a name another field already has is refused', async ({ app }) => {
    await box(app.page, 'FullName').click();
    const name = app.page.getByRole('textbox', { name: 'Field name' });
    await name.fill('Country');
    await name.press('Enter');
    await expect(box(app.page, 'FullName')).toBeVisible();
    expect(await app.page.evaluate(() => (window as unknown as { status: string }).status)).toContain('already a field named');
  });

  test('the arrow keys nudge the selected field by a point, Shift by ten', async ({ app }) => {
    await box(app.page, 'FullName').click();
    await app.page.keyboard.press('ArrowRight');
    await app.page.keyboard.press('Shift+ArrowRight');
    await app.page.keyboard.press('ArrowUp');
    // Was [40 220 240 240]; right 11, up 1 (PDF y grows upward).
    expect(rounded(rectIn((await dl(app)).FullName))).toEqual([51, 221, 251, 241]);
  });

  test('dragging a field moves it', async ({ app }) => {
    const before = (await box(app.page, 'FullName').boundingBox())!;
    const from = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
    await app.page.mouse.move(from.x, from.y);
    await app.page.mouse.down();
    await app.page.mouse.move(from.x + 40, from.y + 60, { steps: 5 });
    await app.page.mouse.up();
    const after = (await box(app.page, 'FullName').boundingBox())!;
    expect(after.x - before.x).toBeCloseTo(40, 0);
    expect(after.y - before.y).toBeCloseTo(60, 0);
    const rect = rectIn((await dl(app)).FullName);
    expect(rect[0]).toBeGreaterThan(40);
    expect(rect[1]).toBeLessThan(220);
  });

  test('dragging the corner resizes a field', async ({ app }) => {
    await box(app.page, 'FullName').click();
    const before = (await box(app.page, 'FullName').boundingBox())!;
    const handle = (await box(app.page, 'FullName').locator('.wm-field-handle').boundingBox())!;
    await app.page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await app.page.mouse.down();
    await app.page.mouse.move(handle.x + 60, handle.y + 30, { steps: 5 });
    await app.page.mouse.up();
    const after = (await box(app.page, 'FullName').boundingBox())!;
    expect(after.width).toBeGreaterThan(before.width + 40);
    expect(after.height).toBeGreaterThan(before.height + 15);
    expect(after.x).toBeCloseTo(before.x, 0);
  });

  test('Delete removes the selected field, and Undo brings it back', async ({ app }) => {
    await box(app.page, 'FullName').click();
    await app.page.keyboard.press('Delete');
    await expect(box(app.page, 'FullName')).toHaveCount(0);
    await app.menu('Edit', 'Undo');
    await expect(box(app.page, 'FullName')).toBeVisible();
    await box(app.page, 'FullName').click();
    await app.page.getByRole('button', { name: 'Delete field' }).click();
    await expect(box(app.page, 'FullName')).toHaveCount(0);
    const fields = Object.keys(await dl(app));
    expect(fields).not.toContain('FullName');
    expect(fields).toContain('Country');
  });

  test('a new text box, check box and drop-down are placed where the page is clicked', async ({ app }) => {
    const kinds = [
      ['text', 'Text1', 100, 160],
      ['checkbox', 'Check Box1', 100, 200],
      ['choice', 'Dropdown1', 100, 240],
    ] as const;
    for (const [kind, name, x, y] of kinds) {
      await app.page.locator(`.wm-forms-add[data-kind="${kind}"]`).click();
      await clickOnPage(app.page, 0, x, y);
      await expect(box(app.page, name)).toBeVisible();
    }
    const fields = await dl(app);
    for (const [, name] of kinds) expect(Object.keys(fields)).toContain(name);
    // The text box was dropped at (100, 160) from the top, so its top edge is 140 from the bottom of a 300 pt page.
    const rect = rectIn(fields.Text1);
    expect(rect[0]).toBeCloseTo(100, 0);
    expect(rect[3]).toBeCloseTo(300 - 160, 0);
  });

  test('a new drop-down takes its options from the palette', async ({ app }) => {
    await app.page.locator('.wm-forms-add[data-kind="choice"]').click();
    await clickOnPage(app.page, 0, 100, 240);
    await app.page.getByRole('textbox', { name: 'Options, one per line' }).fill('Red\nGreen\nBlue');
    await app.page.getByRole('textbox', { name: 'Field name' }).focus();
    const dict = (await dl(app)).Dropdown1;
    expect(dict).toMatch(/\/Opt/);
    for (const o of ['Red', 'Green', 'Blue']) expect(dict).toContain(`(${o})`);
  });

  test('a field added in Edit PDF can be filled in under Fill In', async ({ app }) => {
    await app.page.locator('.wm-forms-add[data-kind="text"]').click();
    await clickOnPage(app.page, 0, 100, 160);
    await app.page.getByRole('button', { name: 'Fill In', exact: true }).click();
    const input = app.page.locator('.wm-field[aria-label="Text1"]');
    await input.fill('typed here');
    await expect(input).toHaveValue('typed here');
    expect((await dl(app)).Text1).toMatch(/\/V\s*\(typed here\)/);
  });

  test('Escape cancels placing a field', async ({ app }) => {
    await app.page.locator('.wm-forms-add[data-kind="text"]').click();
    await expect(app.page.getByText('Click on a page to place the text box')).toBeVisible();
    await app.page.keyboard.press('Escape');
    await clickOnPage(app.page, 0, 100, 160);
    await expect(app.page.locator('.wm-field-box')).toHaveCount(2);
  });
});
