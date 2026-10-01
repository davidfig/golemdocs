import { expect, test } from '../fixtures';
import { attrs, caretOf, count, dialog, docx, pageBoxes, pageCount, pageSetup, readPageSetup, setField } from './helpers';

test.describe('Page Setup dialog', () => {
  test.beforeEach(async ({ app }) => {
    await app.blank();
  });

  test('a new document shows Letter, portrait, one inch margins and half inch header/footer, in inches', async ({ app }) => {
    expect(await readPageSetup(app)).toEqual({ top: 1, bottom: 1, left: 1, right: 1, gutter: 0, header: 0.5, footer: 0.5, orientation: 'portrait', width: 8.5, height: 11, paper: 'Letter' });
    await app.menu('File', 'Page Setup…');
    await expect(dialog(app, 'Page Setup').getByText('in', { exact: true }).first()).toBeVisible();
  });

  test('OK applies the margins and they persist when the dialog is reopened and in the saved Word file', async ({ app }) => {
    await app.type('Hello');
    await pageSetup(app, { top: 1.5, bottom: 1.25, left: 2, right: 1.75, gutter: 0.5, header: 0.4, footer: 0.6 });
    const values = await readPageSetup(app);
    expect(values).toMatchObject({ top: 1.5, bottom: 1.25, left: 2, right: 1.75, gutter: 0.5, header: 0.4, footer: 0.6 });
    const { xml } = await docx(app);
    expect(attrs(xml, 'w:pgMar')).toMatchObject({ 'w:top': '2160', 'w:bottom': '1800', 'w:left': '2880', 'w:right': '2520', 'w:gutter': '720', 'w:header': '576', 'w:footer': '864' });
  });

  test('the left margin moves where text starts on the page', async ({ app }) => {
    await pageSetup(app, { left: 2, top: 2 });
    await app.type('x');
    await expect.poll(async () => (await caretOf(app.page))?.x).toBeGreaterThan(144);
    const caret = (await caretOf(app.page))!;
    expect(caret.x).toBeLessThan(160);
    expect(caret.y).toBeGreaterThanOrEqual(144);
    expect(caret.y).toBeLessThan(160);
  });

  test('bigger top and bottom margins push lines onto more pages', async ({ app }) => {
    await app.press('Enter', 25);
    await app.settle();
    await expect.poll(() => pageCount(app.page)).toBe(1);
    await pageSetup(app, { top: 4, bottom: 4 });
    await expect.poll(() => pageCount(app.page)).toBeGreaterThanOrEqual(3);
  });

  test('Cancel and the close button leave the page as it was', async ({ app }) => {
    const dlg = await pageSetup(app, { left: 3, orientation: 'landscape' }, false);
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg).toHaveCount(0);
    expect(await pageBoxes(app.page)).toEqual([{ width: 612, height: 792 }]);
    await app.menu('File', 'Page Setup…');
    await dialog(app, 'Page Setup').getByRole('button', { name: 'Close' }).click();
    await expect(dialog(app, 'Page Setup')).toHaveCount(0);
    expect((await readPageSetup(app)).left).toBe(1);
  });

  test('Landscape swaps the paper width and height and turns the page on its side', async ({ app }) => {
    await pageSetup(app, { orientation: 'landscape' });
    await expect.poll(() => pageBoxes(app.page)).toEqual([{ width: 792, height: 612 }]);
    expect(await readPageSetup(app)).toMatchObject({ orientation: 'landscape', width: 11, height: 8.5, paper: 'Letter' });
    const { xml } = await docx(app);
    expect(attrs(xml, 'w:pgSz')).toMatchObject({ 'w:w': '15840', 'w:h': '12240', 'w:orient': 'landscape' });
    // And back again.
    await pageSetup(app, { orientation: 'portrait' });
    await expect.poll(() => pageBoxes(app.page)).toEqual([{ width: 612, height: 792 }]);
  });

  test('picking a paper size fills in its width and height, and editing them makes it custom', async ({ app }) => {
    await app.menu('File', 'Page Setup…');
    const dlg = dialog(app, 'Page Setup');
    await dlg.getByRole('tab', { name: 'Paper' }).click();
    await dlg.getByRole('combobox', { name: /Paper size/ }).selectOption('A4');
    await expect(dlg.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('8.27');
    await expect(dlg.getByRole('spinbutton', { name: 'Height', exact: true })).toHaveValue('11.69');
    await dlg.getByRole('combobox', { name: /Paper size/ }).selectOption('Legal');
    await expect(dlg.getByRole('spinbutton', { name: 'Height', exact: true })).toHaveValue('14');
    await setField(dlg, 'Width', 5);
    await expect(dlg.getByRole('combobox', { name: /Paper size/ })).toHaveValue('custom');
    // Typing a known size back selects it.
    await setField(dlg, 'Width', 8.5);
    await setField(dlg, 'Height', 11);
    await expect(dlg.getByRole('combobox', { name: /Paper size/ })).toHaveValue('Letter');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
  });

  // Bug: the size fields are <input type=number step=0.05>, so A4's 8.27 x 11.69 in fail the browser's step validation
  // ("the two nearest valid values are 8.25 and 8.3") and OK never closes the dialog. Same for A3 and A5.
  test.fixme('A4 paper sets the page and the Word file, in portrait and in landscape', async ({ app }) => {
    await pageSetup(app, { paper: 'A4' });
    await expect.poll(async () => (await pageBoxes(app.page))[0]?.height).toBeCloseTo(841.9, 0);
    expect((await pageBoxes(app.page))[0].width).toBeCloseTo(595.3, 0);
    const size = attrs((await docx(app)).xml, 'w:pgSz');
    expect(Math.abs(Number(size['w:w']) - 11906)).toBeLessThan(10);
    expect(Math.abs(Number(size['w:h']) - 16838)).toBeLessThan(10);
    await pageSetup(app, { orientation: 'landscape' });
    await expect.poll(async () => (await pageBoxes(app.page))[0]?.width).toBeCloseTo(841.9, 0);
    expect(await readPageSetup(app)).toMatchObject({ paper: 'A4', orientation: 'landscape' });
  });

  test('a custom paper size is laid out and saved as typed', async ({ app }) => {
    await pageSetup(app, { width: 5, height: 7, left: 0.5, right: 0.5, top: 0.5, bottom: 0.5 });
    await expect.poll(() => pageBoxes(app.page)).toEqual([{ width: 360, height: 504 }]);
    expect(await readPageSetup(app)).toMatchObject({ paper: 'custom', width: 5, height: 7 });
    expect(attrs((await docx(app)).xml, 'w:pgSz')).toMatchObject({ 'w:w': '7200', 'w:h': '10080' });
  });

  test('a page under an inch, or margins that leave no room for text, are refused with a message', async ({ app }) => {
    const dlg = await pageSetup(app, { width: 0.5 }, false);
    await dlg.getByRole('button', { name: 'OK' }).click();
    await expect(dlg.getByRole('alert')).toContainText('at least 1 inch');
    await expect(dlg).toBeVisible();
    await setField(dlg, 'Width', 8.5);
    await dlg.getByRole('tab', { name: 'Margins' }).click();
    await setField(dlg, 'Left', 4.5);
    await setField(dlg, 'Right', 4);
    await dlg.getByRole('button', { name: 'OK' }).click();
    await expect(dlg.getByRole('alert')).toContainText('room for text');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    expect(await pageBoxes(app.page)).toEqual([{ width: 612, height: 792 }]);
  });

  test('the change is one undo step', async ({ app }) => {
    await app.type('Hello');
    await pageSetup(app, { orientation: 'landscape' });
    await expect.poll(async () => (await pageBoxes(app.page))[0]?.width).toBe(792);
    await app.focus();
    await app.press('ControlOrMeta+z');
    await expect.poll(async () => (await pageBoxes(app.page))[0]?.width).toBe(612);
    expect(await app.text()).toBe('Hello');
  });
});

test.describe('Page Setup: Apply to', () => {
  /** Two pages: "one", a page break, "two", with the caret at the end of "two". */
  async function twoPages(app: import('../fixtures').App): Promise<void> {
    await app.blank();
    await app.type('one');
    await app.press('ControlOrMeta+Enter');
    await app.type('two');
    await expect.poll(() => pageCount(app.page)).toBe(2);
  }

  test('This section changes every page of a one-section document', async ({ app }) => {
    await twoPages(app);
    await pageSetup(app, { orientation: 'landscape', apply: 'section' });
    await expect.poll(() => pageBoxes(app.page)).toEqual([
      { width: 792, height: 612 },
      { width: 792, height: 612 },
    ]);
    expect(count((await docx(app)).xml, 'w:sectPr')).toBe(1);
  });

  test('This point forward starts a new section at the caret, leaving the pages before it alone', async ({ app }) => {
    await twoPages(app);
    await app.press('ArrowLeft', 3);
    await pageSetup(app, { orientation: 'landscape', apply: 'forward' });
    await expect.poll(async () => (await pageBoxes(app.page)).at(-1)).toEqual({ width: 792, height: 612 });
    expect((await pageBoxes(app.page))[0]).toEqual({ width: 612, height: 792 });
    const { xml } = await docx(app);
    expect(count(xml, 'w:sectPr')).toBe(2);
    expect(attrs(xml, 'w:pgSz', 0)).toMatchObject({ 'w:w': '12240', 'w:h': '15840' });
    expect(attrs(xml, 'w:pgSz', 1)).toMatchObject({ 'w:w': '15840', 'w:h': '12240' });
    expect(await app.text()).toContain('two');
  });

  test('Whole document changes all sections, even after a section was split off', async ({ app }) => {
    await twoPages(app);
    await app.press('ArrowLeft', 3);
    await pageSetup(app, { orientation: 'landscape', apply: 'forward' });
    await expect.poll(async () => (await pageBoxes(app.page)).some((b) => b.width === 792)).toBe(true);
    await pageSetup(app, { paper: 'Executive', apply: 'document' });
    await expect.poll(async () => (await pageBoxes(app.page)).every((b) => Math.min(b.width, b.height) === 522)).toBe(true);
    const { xml } = await docx(app);
    expect(attrs(xml, 'w:pgSz', 0)['w:w']).toMatch(/^(10440|15120)$/);
    expect(attrs(xml, 'w:pgSz', 1)['w:w']).toMatch(/^(10440|15120)$/);
  });

  test('This section changes only the section the caret is in', async ({ app }) => {
    await twoPages(app);
    await app.press('ArrowLeft', 3);
    await pageSetup(app, { orientation: 'landscape', apply: 'forward' });
    await expect.poll(async () => (await pageBoxes(app.page)).some((b) => b.width === 792)).toBe(true);
    // The caret is now in the landscape section; make that one Legal, the first stays Letter.
    await pageSetup(app, { paper: 'Legal', apply: 'section' });
    await expect.poll(async () => (await pageBoxes(app.page)).some((b) => b.width === 1008)).toBe(true);
    const boxes = await pageBoxes(app.page);
    expect(boxes[0]).toEqual({ width: 612, height: 792 });
  });
});
