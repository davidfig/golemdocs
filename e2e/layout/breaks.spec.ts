import { expect, test } from '../fixtures';
import { caretOf, choose, count, docx, isMenuItemEnabled, pageBoxes, pageCount } from './helpers';

test.describe('Insert ▸ Break', () => {
  test.beforeEach(async ({ app }) => {
    await app.blank();
  });

  test('Page Break starts a new page, and the text after it is on it', async ({ app }) => {
    await app.type('first');
    await app.menu('Insert', 'Break', 'Page Break');
    await app.type('second');
    await expect.poll(() => pageCount(app.page)).toBe(2);
    const caret = (await caretOf(app.page))!;
    expect(caret.y).toBeLessThan(100); // at the top of page two
    await expect.poll(() => app.text()).toContain('first');
    await expect.poll(() => app.text()).toContain('second');
    expect((await docx(app)).xml).toContain('<w:br w:type="page"/>');
  });

  test('Ctrl/Cmd+Enter is the same as the Page Break menu item, and each one adds a page', async ({ app }) => {
    await app.type('one');
    await app.press('ControlOrMeta+Enter');
    await app.type('two');
    await app.press('ControlOrMeta+Enter');
    await app.type('three');
    await expect.poll(() => pageCount(app.page)).toBe(3);
    expect(count((await docx(app)).xml, 'w:br')).toBe(2);
  });

  test('deleting the page break with Backspace puts the text back on one page', async ({ app }) => {
    await app.type('one');
    await app.press('ControlOrMeta+Enter');
    await app.type('two');
    await expect.poll(() => pageCount(app.page)).toBe(2);
    await app.press('ArrowLeft', 3);
    await app.press('Backspace');
    await expect.poll(() => pageCount(app.page)).toBe(1);
    await expect.poll(() => app.text()).toContain('one');
  });

  test('the page break is one undo step', async ({ app }) => {
    await app.type('one');
    await app.menu('Insert', 'Break', 'Page Break');
    await expect.poll(() => pageCount(app.page)).toBe(2);
    await app.menu('Edit', 'Undo');
    await expect.poll(() => pageCount(app.page)).toBe(1);
    await expect.poll(() => app.text()).toBe('one');
  });

  test('Line Break (menu and Shift+Enter) breaks the line without a new paragraph or page', async ({ app }) => {
    await app.type('top');
    await app.menu('Insert', 'Break', 'Line Break');
    await app.type('mid');
    await app.press('Shift+Enter');
    await app.type('end');
    expect(await pageCount(app.page)).toBe(1);
    await expect.poll(async () => (await caretOf(app.page))?.y).toBeGreaterThan(72 + 2 * 14);
    const { xml } = await docx(app);
    expect(count(xml, 'w:p')).toBe(1);
    expect(count(xml, 'w:br')).toBe(2);
    expect(xml).not.toContain('w:type="page"');
  });

  test('a page break after a long run of lines still gives one new page, not an empty extra', async ({ app }) => {
    await app.press('Enter', 10);
    await app.type('x');
    await app.press('ControlOrMeta+Enter');
    await app.type('y');
    await expect.poll(() => pageCount(app.page)).toBe(2);
  });

  test('Insert ▸ Break offers Page, Column and Line Break', async ({ app }) => {
    for (const name of ['Page Break', 'Column Break', 'Line Break']) expect(await isMenuItemEnabled(app, 'Insert', 'Break', name), name).toBe(true);
  });
});

test.describe('Normal and Print Layout views', () => {
  test.beforeEach(async ({ app }) => {
    await app.blank();
    await app.type('Some text');
  });

  test('Print Layout is the default and lays pages out at paper size', async ({ app }) => {
    expect(await pageBoxes(app.page)).toEqual([{ width: 612, height: 792 }]);
    await app.menubar.getByRole('menuitem', { name: /^View$/ }).click();
    await expect(app.page.getByRole('menuitemradio', { name: 'Print Layout' })).toHaveAttribute('aria-checked', 'true');
    await expect(app.page.getByRole('menuitemradio', { name: 'Normal' })).toHaveAttribute('aria-checked', 'false');
    await app.page.keyboard.press('Escape');
  });

  test('Normal view reflows the text to the window instead of the paper, and Print Layout restores the page', async ({ app }) => {
    await choose(app, 'View', 'Normal');
    await expect.poll(async () => (await pageBoxes(app.page))[0]?.width).not.toBe(612);
    // The text is the same either way.
    await expect.poll(() => app.text()).toBe('Some text');
    await app.menubar.getByRole('menuitem', { name: /^View$/ }).click();
    await expect(app.page.getByRole('menuitemradio', { name: 'Normal' })).toHaveAttribute('aria-checked', 'true');
    await app.page.keyboard.press('Escape');
    await choose(app, 'View', 'Print Layout');
    await expect.poll(() => pageBoxes(app.page)).toEqual([{ width: 612, height: 792 }]);
  });

  test('Normal view has slim margins: the text starts nearer the page edge', async ({ app }) => {
    const before = (await caretOf(app.page))!.x;
    expect(before).toBeGreaterThanOrEqual(72);
    await choose(app, 'View', 'Normal');
    await expect.poll(async () => (await caretOf(app.page))?.x).toBeLessThan(before);
  });

  test('the chosen view is remembered in this browser across a reload', async ({ app }) => {
    await choose(app, 'View', 'Normal');
    await expect.poll(async () => (await pageBoxes(app.page))[0]?.width).not.toBe(612);
    await app.page.reload();
    await app.ready();
    await expect.poll(async () => (await pageBoxes(app.page))[0]?.width).not.toBe(612);
    await app.menubar.getByRole('menuitem', { name: /^View$/ }).click();
    await expect(app.page.getByRole('menuitemradio', { name: 'Normal' })).toHaveAttribute('aria-checked', 'true');
    await app.page.keyboard.press('Escape');
  });
});
