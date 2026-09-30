import { expect, test } from '../fixtures';
import { makePdf, modeButton, openPdf, pageBoxes, pageCount, settle, zoomOf } from './helpers';

const threePages = () =>
  makePdf({
    pages: [
      [{ text: 'First page heading', x: 40, y: 240, size: 18 }],
      [{ text: 'Second page heading', x: 40, y: 240, size: 18 }],
      [{ text: 'Third page heading', x: 40, y: 240, size: 18 }],
    ],
  });

test.describe('opening a PDF', () => {
  test('a three page PDF opens as three pages, in the PDF format, in Fill In mode', async ({ app }) => {
    await openPdf(app, threePages());
    expect(await pageCount(app.page)).toBe(3);
    await expect(app.page.locator('.wm-format-field input')).toHaveValue('PDF');
    await expect(modeButton(app.page, 'Fill In')).toHaveAttribute('aria-pressed', 'true');
    await expect(modeButton(app.page, 'Edit PDF')).toHaveAttribute('aria-pressed', 'false');
  });

  test('pages are stacked top to bottom at their own size', async ({ app }) => {
    await openPdf(app, makePdf({ width: 300, height: 500, pages: [[{ text: 'A', x: 40, y: 400 }], [{ text: 'B', x: 40, y: 400 }]] }));
    const [a, b] = await pageBoxes(app.page);
    expect([a.width, a.height]).toEqual([300, 500]);
    expect([b.width, b.height]).toEqual([300, 500]);
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
  });

  test('scrolling with the wheel moves down the document', async ({ app }) => {
    await openPdf(app, threePages());
    const y0 = await app.page.evaluate(() => (window as unknown as { camera: { y: number } }).camera.y);
    await app.canvas.hover();
    await app.page.mouse.wheel(0, 400);
    await expect.poll(() => app.page.evaluate(() => (window as unknown as { camera: { y: number } }).camera.y)).toBeGreaterThan(y0);
  });

  test('View ▸ Zoom ▸ Zoom In and Zoom Out change the zoom, Actual Size resets it', async ({ app }) => {
    await openPdf(app, threePages());
    await app.menu('View', 'Zoom', 'Actual Size');
    await settle(app.page);
    expect(await zoomOf(app.page)).toBeCloseTo(1, 2);
    await app.menu('View', 'Zoom', 'Zoom In');
    await settle(app.page);
    const bigger = await zoomOf(app.page);
    expect(bigger).toBeGreaterThan(1);
    await app.menu('View', 'Zoom', 'Zoom Out');
    await app.menu('View', 'Zoom', 'Zoom Out');
    await settle(app.page);
    expect(await zoomOf(app.page)).toBeLessThan(bigger);
  });

  test('the file name is the document name and the status says it is ready', async ({ app }) => {
    await openPdf(app, threePages(), 'Quarterly report.pdf');
    expect(await app.page.evaluate(() => (window as unknown as { status: string }).status)).toContain('Quarterly report.pdf');
  });

  test('a file that is not a PDF is reported instead of opening', async ({ app }) => {
    await app.goto('?doc=welcome');
    const chooser = app.page.waitForEvent('filechooser');
    await app.menu('File', 'Import…');
    await (await chooser).setFiles({ name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('this is not a pdf at all') });
    await expect(app.page.getByRole('alert')).toContainText('broken.pdf: not a PDF file');
    expect(await app.page.evaluate(() => (window as unknown as { status: string }).status)).toContain('not a PDF file');
  });

  test('a truncated PDF is reported instead of opening', async ({ app }) => {
    const whole = threePages();
    await app.goto('?doc=welcome');
    const chooser = app.page.waitForEvent('filechooser');
    await app.menu('File', 'Import…');
    await (await chooser).setFiles({ name: 'cut.pdf', mimeType: 'application/pdf', buffer: whole.subarray(0, 40) });
    await expect(app.page.getByRole('alert')).toContainText('cut.pdf:');
  });
});

test.describe('the menus and toolbars of a PDF', () => {
  test('the toolbar offers markup buttons and no character formatting', async ({ app }) => {
    await openPdf(app, threePages());
    for (const name of ['Underline', 'Strikethrough', 'Highlight', 'Undo', 'Redo', 'Print']) {
      await expect(app.page.getByRole('toolbar').getByRole('button', { name, exact: true })).toBeVisible();
    }
    for (const name of ['Bold', 'Italic', 'Bullets', 'Align Left', 'Insert Table']) {
      await expect(app.page.getByRole('toolbar').getByRole('button', { name })).toHaveCount(0);
    }
  });

  test('there is no Table menu, and Insert holds only Date and Time, Symbol and Comment', async ({ app }) => {
    await openPdf(app, threePages());
    await expect(app.menubar.getByRole('menuitem', { name: 'Table', exact: true })).toHaveCount(0);
    await app.menubar.getByRole('menuitem', { name: 'Insert', exact: true }).click();
    const items = await app.page.getByRole('menu').first().getByRole('menuitem').allInnerTexts();
    expect(items.join('|')).toContain('Comment');
    expect(items.join('|')).not.toMatch(/Picture|Table|Page Break/);
  });

  test('Edit has no Cut, Copy or Paste for a PDF', async ({ app }) => {
    await openPdf(app, threePages());
    await app.menubar.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    const items = (await app.page.getByRole('menu').first().getByRole('menuitem').allInnerTexts()).join('|');
    expect(items).toContain('Find');
    expect(items).not.toMatch(/Cut|Paste/);
  });
});
