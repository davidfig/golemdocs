import { expect, test } from '../fixtures';
import { decodePdf, editMode, makePdf, modeButton, openPdf, showPage } from './helpers';

const form = () =>
  makePdf({
    pages: [[{ text: 'Application form', x: 40, y: 270, size: 16 }]],
    fields: [
      { kind: 'text', name: 'FullName', rect: [40, 220, 240, 240] },
      { kind: 'checkbox', name: 'Agree', rect: [40, 190, 52, 202] },
      { kind: 'radio', name: 'Size', rect: [[40, 160, 52, 172], [80, 160, 92, 172], [120, 160, 132, 172]], states: ['Small', 'Medium', 'Large'], value: 'Small' },
      { kind: 'choice', name: 'Country', rect: [40, 120, 200, 140], options: ['Norway', 'Peru', 'Japan'] },
    ],
  });

const field = (app: { page: import('@playwright/test').Page }, name: string) => app.page.locator(`.wm-field[aria-label="${name}"]`);

async function download(app: import('../fixtures').App): Promise<string> {
  return decodePdf((await app.download(() => app.menu('File', 'Download'))).bytes);
}

test.describe('Fill In mode', () => {
  test.beforeEach(async ({ app }) => {
    await openPdf(app, form());
    await showPage(app.page, 0);
  });

  test('every field of the form appears as a real input over the page', async ({ app }) => {
    await expect(app.page.locator('.wm-field')).toHaveCount(6);
    await expect(field(app, 'FullName')).toBeVisible();
    await expect(field(app, 'Agree')).toHaveAttribute('role', 'checkbox');
    await expect(app.page.getByRole('radio')).toHaveCount(3);
    await expect(app.page.getByRole('combobox', { name: 'Country' })).toBeVisible();
  });

  test('typing in a text field shows the text, and the downloaded PDF holds it', async ({ app }) => {
    await field(app, 'FullName').fill('Alice Example');
    await expect(field(app, 'FullName')).toHaveValue('Alice Example');
    expect(await download(app)).toMatch(/\/V\s*\(Alice Example\)/);
  });

  test('ticking a check box turns it on, clicking again turns it off', async ({ app }) => {
    const box = field(app, 'Agree');
    await expect(box).toHaveAttribute('aria-checked', 'false');
    await box.click();
    await expect(box).toHaveAttribute('aria-checked', 'true');
    expect(await download(app)).toMatch(/\/T\s*\(Agree\)[^>]*\/V\s*\/Yes|\/V\s*\/Yes[^>]*\/T\s*\(Agree\)/);
    await box.click();
    await expect(box).toHaveAttribute('aria-checked', 'false');
  });

  test('choosing a radio button turns the others off, and clicking the chosen one keeps it on', async ({ app }) => {
    const radios = app.page.getByRole('radio');
    await expect(radios.nth(0)).toHaveAttribute('aria-checked', 'true');
    await radios.nth(2).click();
    await expect(radios.nth(2)).toHaveAttribute('aria-checked', 'true');
    await expect(radios.nth(0)).toHaveAttribute('aria-checked', 'false');
    await expect(radios.nth(1)).toHaveAttribute('aria-checked', 'false');
    await radios.nth(2).click();
    await expect(radios.nth(2)).toHaveAttribute('aria-checked', 'true');
    expect(await download(app)).toMatch(/\/V\s*\/Large/);
  });

  test('picking from a drop-down sets its value in the downloaded PDF', async ({ app }) => {
    const choice = app.page.getByRole('combobox', { name: 'Country' });
    await choice.selectOption('Peru');
    await expect(choice).toHaveValue('Peru');
    expect(await download(app)).toMatch(/\/V\s*\(Peru\)/);
  });

  test('a filled-in form, downloaded and opened again, still holds what was filled in', { tag: '@heavy' }, async ({ app }) => {
    await field(app, 'FullName').fill('Bob');
    await field(app, 'Agree').click();
    await app.page.getByRole('radio').nth(1).click();
    await app.page.getByRole('combobox', { name: 'Country' }).selectOption('Japan');
    const { bytes } = await app.download(() => app.menu('File', 'Download'));
    await openPdf(app, bytes, 'filled.pdf');
    await expect(field(app, 'FullName')).toHaveValue('Bob');
    await expect(field(app, 'Agree')).toHaveAttribute('aria-checked', 'true');
    await expect(app.page.getByRole('radio').nth(1)).toHaveAttribute('aria-checked', 'true');
    await expect(app.page.getByRole('combobox', { name: 'Country' })).toHaveValue('Japan');
  });

  test('Undo takes a filled-in value back', async ({ app }) => {
    await field(app, 'Agree').click();
    await expect(field(app, 'Agree')).toHaveAttribute('aria-checked', 'true');
    await app.menu('Edit', 'Undo');
    await expect(field(app, 'Agree')).toHaveAttribute('aria-checked', 'false');
    await app.menu('Edit', 'Redo');
    await expect(field(app, 'Agree')).toHaveAttribute('aria-checked', 'true');
  });

  test('clicking the page text in Fill In mode does not open it for editing', async ({ app }) => {
    const p = await showPage(app.page, 0);
    const at = await p(60, 300 - 270 - 6);
    await app.page.mouse.click(at.x, at.y);
    await expect(app.page.getByRole('textbox', { name: 'Edit text' })).toBeHidden();
  });

  test('Fill In hides the Edit PDF tools, leaving only text, check mark, cross and date', async ({ app }) => {
    for (const name of ['text', 'check', 'cross', 'date']) await expect(app.page.locator(`.wm-pdftools-section button[data-tool="${name}"]`)).toBeVisible();
    for (const name of ['rect', 'ellipse', 'line', 'whiteout', 'redact', 'picture']) await expect(app.page.locator(`.wm-pdftools-section button[data-tool="${name}"]`)).toBeHidden();
  });

  test('switching to Edit PDF turns the inputs into boxes to arrange, and back again restores them', { tag: '@heavy' }, async ({ app }) => {
    await editMode(app.page);
    await expect(app.page.locator('.wm-field-box')).toHaveCount(6);
    await expect(app.page.locator('.wm-field')).toHaveCount(0);
    await modeButton(app.page, 'Fill In').click();
    await expect(app.page.locator('.wm-field')).toHaveCount(6);
  });
});
