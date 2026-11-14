// Alt Text: a picture's description, written in a form over the document (Format › Alt Text…), kept in the Word file and
// read by screen readers in the picture's place.

import { expect, test, type App } from '../fixtures';
import { docx, makePng, screenPoint } from '../layout/helpers';

async function pickedPicture(app: App): Promise<void> {
  await app.blank();
  const [chooser] = await Promise.all([app.page.waitForEvent('filechooser'), app.menu('Insert', 'Picture…')]);
  await chooser.setFiles({ name: 'kite.png', mimeType: 'image/png', buffer: makePng(80, 40) });
  await expect.poll(() => app.page.evaluate(() => (window as unknown as { pages: { images: unknown[] }[] }).pages[0].images.length)).toBe(1);
  const box = await app.page.evaluate(() => (window as unknown as { pages: { images: { x: number; y: number; width: number; height: number }[] }[] }).pages[0].images[0]);
  const middle = await screenPoint(app.page, 0, box.x + box.width / 2, box.y + box.height / 2);
  await app.page.mouse.click(middle.x, middle.y);
  await expect(app.page.locator('.wm-picture-frame')).toBeVisible();
}

const form = (app: App) => app.page.getByRole('dialog', { name: 'Alt Text' });

test.describe('Alt Text', () => {
  test('is written in a form over the document, saved in the Word file, and read in the picture’s place', async ({ app }) => {
    await pickedPicture(app);
    await app.menu('Format', 'Alt Text');
    await expect(form(app)).toBeVisible();
    const field = form(app).getByRole('textbox', { name: 'Description of the picture' });
    await expect(field).toBeFocused();
    await field.fill('A red kite over the hills');
    await app.press('Enter');
    await expect(form(app)).toBeHidden();
    await expect.poll(async () => (await docx(app)).xml).toContain('descr="A red kite over the hills"');

    await app.menu('Tools', 'Screen Reader Mode');
    await expect(app.page.locator('.wm-reading [role="img"]')).toHaveAttribute('aria-label', 'A red kite over the hills');
  });

  test('Escape leaves it as it was', async ({ app }) => {
    await pickedPicture(app);
    await app.menu('Format', 'Alt Text');
    await form(app).getByRole('textbox').fill('Not this');
    await app.press('Escape');
    await expect(form(app)).toBeHidden();
    expect((await docx(app)).xml).not.toContain('Not this');
  });
});
