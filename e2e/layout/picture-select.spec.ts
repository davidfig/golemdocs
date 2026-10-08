// A picture in the text is picked with a click: it gets a frame, can be deleted, dragged, resized, and opened in the image editor.

import { expect, test } from '../fixtures';
import type { App } from '../fixtures';
import { count, docx, makePng, pngPixels, pngSize, screenPoint } from './helpers';

const EMU = 9525;
/** Red on the left half, blue on the right: a turn shows in which side is on top. */
const SPLIT = makePng(120, 60, (x) => (x < 60 ? [255, 0, 0, 255] : [0, 0, 255, 255]));

async function insertPicture(app: App): Promise<void> {
  const [chooser] = await Promise.all([app.page.waitForEvent('filechooser'), app.menu('Insert', 'Picture…')]);
  await chooser.setFiles({ name: 'split.png', mimeType: 'image/png', buffer: SPLIT });
  await expect.poll(() => app.page.evaluate(() => (window as unknown as { pages: { images: unknown[] }[] }).pages[0].images.length)).toBe(1);
}

/** The picture as laid out (points on its page) and its middle on screen. */
async function picture(app: App): Promise<{ x: number; y: number; width: number; height: number; middle: { x: number; y: number } }> {
  const box = await app.page.evaluate(() => (window as unknown as { pages: { images: { x: number; y: number; width: number; height: number }[] }[] }).pages[0].images[0]);
  return { ...box, middle: await screenPoint(app.page, 0, box.x + box.width / 2, box.y + box.height / 2) };
}

const frame = (app: App) => app.page.locator('.wm-picture-frame');

/** A document with a line of text, a picture on a line of its own, and another line. */
async function setUp(app: App): Promise<void> {
  await app.blank();
  await app.type('First line');
  await app.press('Enter');
  await insertPicture(app);
  await app.press('Enter');
  await app.type('Last line');
  await app.settle();
}

test.describe('a picture in the text', () => {
  test('a click picks it and frames it; a click on the text lets go', async ({ app }) => {
    await setUp(app);
    await expect(frame(app)).toBeHidden();
    const pic = await picture(app);
    await app.page.mouse.click(pic.middle.x, pic.middle.y);
    await expect(frame(app)).toBeVisible();
    const box = (await frame(app).boundingBox())!;
    expect(box.width).toBeGreaterThan(20);
    await expect(frame(app).locator('.wm-picture-handle')).toHaveCount(4);
    // The picture is what is selected.
    const first = await screenPoint(app.page, 0, 80, 100);
    await app.page.mouse.click(first.x, pic.middle.y + 400);
    await expect(frame(app)).toBeHidden();
  });

  test('Delete takes the picked picture out of the document, and Undo brings it back', async ({ app }) => {
    await setUp(app);
    const pic = await picture(app);
    await app.page.mouse.click(pic.middle.x, pic.middle.y);
    await expect(frame(app)).toBeVisible();
    await app.press('Delete');
    await expect(frame(app)).toBeHidden();
    await expect.poll(async () => count((await docx(app)).xml, 'w:drawing')).toBe(0);
    await app.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`);
    await expect.poll(async () => count((await docx(app)).xml, 'w:drawing')).toBe(1);
  });

  test('dragging it to another line moves it there', async ({ app }) => {
    await setUp(app);
    const pic = await picture(app);
    await app.page.mouse.click(pic.middle.x, pic.middle.y);
    await expect(frame(app)).toBeVisible();
    // A press soon after a click would be a double click.
    await app.page.waitForTimeout(700);
    const last = await screenPoint(app.page, 0, pic.x + 10, pic.y + pic.height + 18);
    await app.page.mouse.move(pic.middle.x, pic.middle.y);
    await app.page.mouse.down();
    await app.page.mouse.move(pic.middle.x + 10, pic.middle.y + 30, { steps: 4 });
    await app.page.mouse.move(last.x, last.y, { steps: 6 });
    await app.page.mouse.up();
    await expect.poll(async () => (await docx(app)).xml.indexOf('<w:drawing>')).toBeGreaterThan((await docx(app)).xml.indexOf('Last line') - 1);
    // Still one picture, and still picked.
    expect(count((await docx(app)).xml, 'w:drawing')).toBe(1);
    await expect(frame(app)).toBeVisible();
  });

  test('a corner handle resizes it, keeping its shape', async ({ app }) => {
    await setUp(app);
    const pic = await picture(app);
    await app.page.mouse.click(pic.middle.x, pic.middle.y);
    await expect(frame(app)).toBeVisible();
    const handle = (await app.page.locator('.wm-picture-handle[data-handle="se"]').boundingBox())!;
    const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
    await app.page.mouse.move(from.x, from.y);
    await app.page.mouse.down();
    await app.page.mouse.move(from.x - 40, from.y - 20, { steps: 5 });
    await app.page.mouse.up();
    await expect.poll(async () => (await picture(app)).width).toBeLessThan(pic.width - 10);
    const after = await picture(app);
    expect(after.width / after.height).toBeCloseTo(2, 1);
    const extent = (await docx(app)).xml.match(/<wp:extent cx="(\d+)" cy="(\d+)"/)!;
    expect(Number(extent[1]) / EMU).toBeCloseTo(after.width * (96 / 72), 0);
  });

  test('a double click opens it in the image editor, and Done puts the edited picture back', async ({ app }) => {
    await setUp(app);
    const pic = await picture(app);
    await app.page.mouse.dblclick(pic.middle.x, pic.middle.y);
    await app.menubar.getByRole('menuitem', { name: 'Picture' }).waitFor();
    await expect(app.page.locator('.wm-watch').getByRole('button', { name: 'Done' })).toBeVisible();
    await app.menu('Picture', 'Rotate Right');
    await expect.poll(async () => (await app.page.evaluate(() => (window as unknown as { pages: { width: number; height: number }[] }).pages[0])).height).toBeGreaterThan(0);
    await app.page.locator('.wm-watch').getByRole('button', { name: 'Done' }).click();
    // The document is back, with the turned picture in place of the old one.
    await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('Last line');
    await expect(app.menubar.getByRole('menuitem', { name: 'Picture' })).toBeHidden();
    await expect.poll(async () => count((await docx(app)).xml, 'w:drawing'), { timeout: 20_000 }).toBe(1);
    const { xml, files } = await docx(app);
    const media = [...files.keys()].filter((k) => k.startsWith('word/media/'));
    const turned = media.map((m) => files.get(m)!).find((b) => pngSize(b).width === 60);
    expect(turned, 'the picture turned a quarter: 60 wide, 120 tall').toBeTruthy();
    const pixels = pngPixels(turned!);
    // Rotated right, the red left half is the top.
    expect(pixels.data[0]).toBeGreaterThan(200);
    expect(pixels.data[2]).toBeLessThan(60);
    // Its width stays; the shape follows the new picture.
    const extent = xml.match(/<wp:extent cx="(\d+)" cy="(\d+)"/)!;
    expect(Number(extent[2]) / Number(extent[1])).toBeCloseTo(2, 1);
  });

  test('Cancel leaves the document as it was', async ({ app }) => {
    await setUp(app);
    const pic = await picture(app);
    await app.page.mouse.dblclick(pic.middle.x, pic.middle.y);
    await app.menubar.getByRole('menuitem', { name: 'Picture' }).waitFor();
    await app.menu('Picture', 'Grayscale');
    await app.page.locator('.wm-watch').getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('Last line');
    const { files } = await docx(app);
    const media = [...files.keys()].filter((k) => k.startsWith('word/media/'));
    expect(media).toHaveLength(1);
    expect(files.get(media[0])!.equals(SPLIT)).toBe(true);
  });

  test('a right click picks it and offers Cut, Copy, Delete and Edit Picture', async ({ app }) => {
    await setUp(app);
    const pic = await picture(app);
    await app.page.mouse.click(pic.middle.x, pic.middle.y + 400);
    await app.page.mouse.click(pic.middle.x, pic.middle.y, { button: 'right' });
    const menu = app.page.getByRole('menu', { name: 'Picture' });
    await expect(menu).toBeVisible();
    await expect(frame(app)).toBeVisible();
    for (const name of ['Cut', 'Copy', 'Delete', 'Edit Picture…']) await expect(menu.getByRole('menuitem', { name })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Delete' }).click();
    await expect.poll(async () => count((await docx(app)).xml, 'w:drawing')).toBe(0);
  });

  test('right click, Edit Picture opens the image editor', async ({ app }) => {
    await setUp(app);
    const pic = await picture(app);
    await app.page.mouse.click(pic.middle.x, pic.middle.y, { button: 'right' });
    await app.page.getByRole('menu', { name: 'Picture' }).getByRole('menuitem', { name: 'Edit Picture…' }).click();
    await expect(app.page.locator('.wm-watch').getByRole('button', { name: 'Done' })).toBeVisible();
  });

  test('Cut puts the picture on the clipboard and takes it out of the document', async ({ app, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setUp(app);
    const pic = await picture(app);
    await app.page.mouse.click(pic.middle.x, pic.middle.y);
    await expect(frame(app)).toBeVisible();
    await app.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+x`);
    await expect.poll(async () => count((await docx(app)).xml, 'w:drawing')).toBe(0);
    const types = await app.page.evaluate(async () => (await navigator.clipboard.read()).flatMap((i) => i.types));
    expect(types).toContain('image/png');
  });
});
