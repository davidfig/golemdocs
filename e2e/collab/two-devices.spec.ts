// Two devices of one account in the same cloud text document: what typing, formatting, tables and pictures do to the other's copy,
// and how each sees the other's caret. (The status line, avatars, undo and comments are in cloud-room.spec.ts.)

import { test, expect, App, MOD } from '../fixtures';
import { docx, makePng } from '../layout/helpers';
import { expectText, others, roomPair, statusLine } from './helpers';

test('Done and Escape close the Share dialog', async ({ app, page }) => {
  await app.blank();
  await app.menu('File', 'Share');
  const dialog = page.locator('dialog.wm-share');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);
  await app.menu('File', 'Share');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test.describe('two devices in one document', () => {
  test('a late joiner gets the whole document', async ({ browser }) => {
    const { a, b, context, url } = await roomPair(browser, 'first line');
    await a.press('Enter');
    await a.type('second line');
    await expectText(a, 'first line\nsecond line');
    // Someone else arrives later still.
    const c = new App(await context.newPage());
    await c.page.goto(url);
    await c.ready();
    await expectText(c, 'first line\nsecond line');
    await expectText(b, 'first line\nsecond line');
    await context.close();
  });

  test('a picture added in one page reaches the other, bytes and all', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'Hello');
    await expectText(b, 'Hello');
    const picture = makePng(50, 30);
    const [chooser] = await Promise.all([a.page.waitForEvent('filechooser'), a.menu('Insert', 'Picture…')]);
    await chooser.setFiles({ name: 'p.png', mimeType: 'image/png', buffer: picture });
    const images = (app: App) => app.page.evaluate(() => (window as unknown as { pages: { images: unknown[] }[] }).pages.reduce((n, pg) => n + pg.images.length, 0));
    await expect.poll(() => images(a)).toBe(1);
    await expect.poll(() => images(b)).toBe(1);
    // The other page's document holds the bytes under the name they hash to.
    const { files } = await docx(b);
    const media = [...files.keys()].filter((k) => /^word\/media\/h-[0-9a-f]{64}\.png$/.test(k));
    expect(media).toHaveLength(1);
    expect(files.get(media[0]!)!.equals(picture)).toBe(true);
    await context.close();
  });

  test('a drawing inserted in one page, and drawn in, is the same drawing in the other', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'Hello');
    await expectText(b, 'Hello');
    await a.menu('Insert', 'Drawing');
    await expect(a.page.getByRole('tree', { name: 'Layers' })).toBeVisible({ timeout: 30_000 });
    const drawingOf = (app: App) =>
      app.page.evaluate(() => (window as unknown as { pages: { images: { svg?: string }[] }[] }).pages.flatMap((p) => p.images).find((i) => i.svg)?.svg ?? null);
    await expect.poll(() => drawingOf(b), { timeout: 30_000 }).toMatch(/^word\/media\/h-[0-9a-f]{64}\.svg$/);
    const before = await drawingOf(b);
    // Draw a rectangle and leave: the drawing is replaced everywhere, by the one with the rectangle in it.
    await a.toolbarButton('Rectangle').click();
    const box = await a.page.locator('.wm-vector-canvas').boundingBox();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    await a.page.mouse.move(x - 60, y - 40);
    await a.page.mouse.down();
    await a.page.mouse.move(x, y);
    await a.page.mouse.move(x + 60, y + 40);
    await a.page.mouse.up();
    await a.press('Escape');
    await a.press('Escape');
    await expect(a.page.getByRole('tree', { name: 'Layers' })).toBeHidden();
    await expect.poll(() => drawingOf(b), { timeout: 30_000 }).not.toBe(before);
    expect(await drawingOf(a)).toBe(await drawingOf(b));
    await context.close();
  });

  test('typing at the same spot at once keeps every character and ends up identical', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'base');
    await expectText(b, 'base');
    await a.focus();
    await b.focus();
    await Promise.all([a.page.keyboard.type('1111', { delay: 15 }), b.page.keyboard.type('2222', { delay: 15 })]);
    await expect.poll(async () => (await a.text()) === (await b.text())).toBe(true);
    const text = await a.text();
    expect(text.replace(/[^1]/g, '')).toBe('1111');
    expect(text.replace(/[^2]/g, '')).toBe('2222');
    expect(text).toContain('base');
    await context.close();
  });

  test('deleting text propagates, including a selection replaced by typing', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'one two three');
    await expectText(b, 'one two three');
    await a.press('Home');
    await a.press('Shift+ArrowRight', 4); // "one "
    await a.press('Delete');
    await expectText(b, 'two three');
    await b.press(`${MOD}+a`);
    await b.type('replaced');
    await expectText(a, 'replaced');
    await context.close();
  });

  test('formatting travels: bold made in one page shows in the other', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'Hello world');
    await expectText(b, 'Hello world');
    await a.press('Home');
    await a.press('Shift+ArrowRight', 5);
    await a.page.keyboard.press(`${MOD}+b`);
    await b.focus();
    await b.press(`${MOD}+Home`);
    await b.press('ArrowRight');
    await expect(b.toolbarButton('Bold')).toHaveAttribute('aria-pressed', 'true');
    await b.press(`${MOD}+End`);
    await expect(b.toolbarButton('Bold')).toHaveAttribute('aria-pressed', 'false');
    await context.close();
  });

  test('a table inserted in one page appears in the other', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'above');
    await expectText(b, 'above');
    await a.press('Enter');
    await a.menu('Insert', 'Table');
    const dialog = a.page.getByRole('dialog', { name: 'Insert Table' });
    await dialog.getByLabel('Number of columns').first().fill('2');
    await dialog.getByLabel('Number of rows').first().fill('2');
    await dialog.getByRole('button', { name: 'OK' }).click();
    await a.focus();
    await a.type('cell one');
    await expect.poll(async () => (await b.text()).includes('cell one')).toBe(true);
    await expect.poll(async () => (await b.text()) === (await a.text()), { message: 'both pages hold the same text' }).toBe(true);
    // The table's cells are separate paragraphs: more lines than the two we typed.
    expect((await b.text()).split('\n').length).toBeGreaterThan(3);
    await context.close();
  });

});

test.describe('presence', () => {
  test('a remote caret follows the other person moving through the text', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'one two three');
    await expectText(b, 'one two three');
    await b.press('Home');
    const atStart = await expect.poll(async () => (await others(a.page))[0]?.x).toBeDefined();
    void atStart;
    const x0 = (await others(a.page))[0]!.x;
    await b.press('End');
    await expect.poll(async () => (await others(a.page))[0]?.x ?? 0).toBeGreaterThan(x0 + 20);
    await b.press('Enter');
    const y0 = (await others(a.page))[0]!.y;
    await b.type('next line');
    await expect.poll(async () => (await others(a.page))[0]?.y ?? 0).toBeGreaterThanOrEqual(y0);
    await context.close();
  });

  test('the caret of someone who leaves is removed', async ({ browser }) => {
    const { a, b, context } = await roomPair(browser, 'Hello');
    await expect.poll(async () => (await others(a.page)).length).toBe(1);
    await b.page.close();
    await expect.poll(async () => (await others(a.page)).length).toBe(0);
    await context.close();
  });

  test('a newcomer appears, and the third person is seen by both', async ({ browser }) => {
    const { a, b, context, url } = await roomPair(browser, 'Hello');
    const c = new App(await context.newPage());
    await c.page.goto(url);
    await c.ready();
    // Carets are what people see of each other, so the newcomer puts theirs in the text.
    await c.focus();
    await c.press('ControlOrMeta+End');
    await expect.poll(async () => (await others(a.page)).length).toBe(2);
    await expect.poll(async () => (await others(b.page)).length).toBe(2);
    await expect.poll(() => statusLine(c.page)).toContain('3 people here');
    await context.close();
  });
});
