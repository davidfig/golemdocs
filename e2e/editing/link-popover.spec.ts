// Resting the pointer on a link opens a form over the document with its text and address, to change or take off.

import { expect, test, type App } from '../fixtures';
import { MOD, caretClient, clickAt, dialog, docxPart, waitCaretSettled } from './helpers';

/** "click here" linked to example.com, with " end" after it and the caret at the end. Returns a window point on the link. */
async function linked(app: App): Promise<{ x: number; y: number }> {
  await app.blank();
  await app.type(' end');
  await app.press('Home');
  await app.type('click here');
  await app.press('Shift+Home');
  await app.press(`${MOD}+k`);
  const box = dialog(app.page, 'Insert Hyperlink');
  await box.getByRole('textbox', { name: 'Address' }).fill('https://example.com/page');
  await box.getByRole('button', { name: 'OK' }).click();
  await expect(box).toHaveCount(0);
  await app.press('Home');
  await waitCaretSettled(app);
  const start = await caretClient(app);
  return { x: start.x + 14, y: start.y };
}

const card = (app: App) => app.page.locator('.wm-link.wm-over');

async function links(app: App): Promise<string[]> {
  const file = await app.download(() => app.menu('File', 'Download'));
  const rels = (() => {
    try {
      return docxPart(file.bytes, 'word/_rels/document.xml.rels');
    } catch {
      return '';
    }
  })();
  return [...rels.matchAll(/Target="([^"]*)"[^>]*TargetMode="External"/g)].map((m) => m[1]);
}

test.describe('Link form', () => {
  test('opens over a link with its text and address, and goes when the pointer leaves', async ({ app }) => {
    const on = await linked(app);
    await app.page.mouse.move(on.x, on.y);
    await expect(card(app)).toBeVisible();
    await expect(card(app).getByRole('textbox', { name: 'Address' })).toHaveValue('https://example.com/page');
    await expect(card(app).getByRole('textbox', { name: 'Text to display' })).toHaveValue('click here');
    await app.page.mouse.move(on.x, on.y - 150);
    await expect(card(app)).toBeHidden();
  });

  test('changing the address and the text there changes the link', async ({ app }) => {
    const on = await linked(app);
    await app.page.mouse.move(on.x, on.y);
    const box = card(app);
    await box.getByRole('textbox', { name: 'Address' }).fill('https://example.org/');
    await box.getByRole('textbox', { name: 'Text to display' }).fill('over there');
    await app.page.mouse.move(on.x, on.y - 150); // moving away does not close a form in use
    await expect(box).toBeVisible();
    await box.getByRole('button', { name: 'OK' }).click();
    await expect(box).toBeHidden();
    await expect.poll(() => app.text()).toBe('over there end');
    expect(await links(app)).toContain('https://example.org/');
  });

  test('Remove Link takes the link off and keeps its text', async ({ app }) => {
    const on = await linked(app);
    await app.page.mouse.move(on.x, on.y);
    await card(app).getByRole('button', { name: 'Remove Link' }).click();
    await expect
      .poll(async () => {
        const file = await app.download(() => app.menu('File', 'Download'));
        return docxPart(file.bytes, 'word/document.xml').includes('<w:hyperlink');
      })
      .toBe(false);
    expect(await app.text()).toBe('click here end');
  });

  test('typing hides a form that only came with the pointer', async ({ app }) => {
    const on = await linked(app);
    await clickAt(app, { x: on.x, y: on.y });
    await app.page.mouse.move(on.x + 1, on.y);
    await expect(card(app)).toBeVisible();
    await app.press('ArrowRight');
    await expect(card(app)).toBeHidden();
  });

  test('Insert Hyperlink is a form over the document, not a modal dialog, and a press elsewhere closes it', async ({ app }) => {
    await app.blank();
    await app.type('see ');
    await app.press(`${MOD}+k`);
    await expect(card(app).getByRole('textbox', { name: 'Text to display' })).toBeFocused();
    await expect(app.page.locator('dialog[open]')).toHaveCount(0);
    await app.page.mouse.click(10, 300);
    await expect(card(app)).toBeHidden();
    expect(await links(app)).toEqual([]);
  });
});
