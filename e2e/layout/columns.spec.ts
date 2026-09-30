import { expect, test } from '../fixtures';
import type { App } from '../fixtures';
import { attrs, caretOf, columns, count, dialog, docx, isMenuItemEnabled, pageCount } from './helpers';

/** Lines of one letter each (an Enter after each), long enough to fill a column and more. */
async function lines(app: App, n: number): Promise<void> {
  await app.press('Enter', n);
  await app.settle();
}

test.describe('Columns dialog', () => {
  test.beforeEach(async ({ app }) => {
    await app.blank();
  });

  test('opens from Format ▸ Columns and from the toolbar button, showing one column by default', async ({ app }) => {
    await app.menu('Format', 'Columns…');
    const dlg = dialog(app, 'Columns');
    await expect(dlg.getByRole('spinbutton', { name: 'Number of columns', exact: true })).toHaveValue('1');
    await expect(dlg.getByRole('spinbutton', { name: /Spacing between columns/ })).toHaveValue('0.5');
    await expect(dlg.getByRole('checkbox', { name: 'Line between' })).not.toBeChecked();
    await expect(dlg.getByText('6.5"')).toBeVisible();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg).toHaveCount(0);
    await app.toolbarButton('Columns').click();
    await expect(dialog(app, 'Columns')).toBeVisible();
    await dialog(app, 'Columns').getByRole('button', { name: 'Close' }).click();
  });

  test('the presets set the number of columns and the width readout follows', async ({ app }) => {
    await app.menu('Format', 'Columns…');
    const dlg = dialog(app, 'Columns');
    const count = dlg.getByRole('spinbutton', { name: 'Number of columns', exact: true });
    await dlg.getByRole('button', { name: 'Two', exact: true }).click();
    await expect(count).toHaveValue('2');
    await expect(dlg.getByText('3"')).toBeVisible(); // (6.5 - 0.5) / 2
    await dlg.getByRole('button', { name: 'Three', exact: true }).click();
    await expect(count).toHaveValue('3');
    await expect(dlg.getByText('1.83"')).toBeVisible(); // (6.5 - 1) / 3
    await dlg.getByRole('button', { name: 'One', exact: true }).click();
    await expect(count).toHaveValue('1');
    await dlg.getByRole('spinbutton', { name: /Spacing between columns/ }).fill('1');
    await dlg.getByRole('button', { name: 'Two', exact: true }).click();
    await expect(dlg.getByText('2.75"')).toBeVisible(); // (6.5 - 1) / 2
    await dlg.getByRole('button', { name: 'Cancel' }).click();
  });

  test('two columns, spacing and a line between are saved in the Word file and shown again', async ({ app }) => {
    await app.type('Hello');
    await columns(app, { preset: 'Two', spacing: 0.75, line: true });
    const { xml } = await docx(app);
    expect(attrs(xml, 'w:cols')).toMatchObject({ 'w:num': '2', 'w:space': '1080' });
    expect(attrs(xml, 'w:cols')['w:sep']).toMatch(/^(1|true|on)$/);
    await app.menu('Format', 'Columns…');
    const dlg = dialog(app, 'Columns');
    await expect(dlg.getByRole('spinbutton', { name: 'Number of columns', exact: true })).toHaveValue('2');
    await expect(dlg.getByRole('spinbutton', { name: /Spacing between columns/ })).toHaveValue('0.75');
    await expect(dlg.getByRole('checkbox', { name: 'Line between' })).toBeChecked();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
  });

  test('Cancel changes nothing', async ({ app }) => {
    await app.type('Hello');
    const dlg = await columns(app, { preset: 'Three', line: true }, false);
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg).toHaveCount(0);
    expect(attrs((await docx(app)).xml, 'w:cols')['w:num'] ?? '1').toBe('1');
  });

  test('a bad number of columns, or columns that would be too narrow, are refused with a message', async ({ app }) => {
    const dlg = await columns(app, { count: 13 }, false);
    await dlg.getByRole('button', { name: 'OK' }).click();
    // The browser's own validation may show first for out of range numbers; fall back to ours for a fraction.
    await dlg.getByRole('spinbutton', { name: 'Number of columns', exact: true }).fill('9');
    await dlg.getByRole('spinbutton', { name: /Spacing between columns/ }).fill('1');
    await dlg.getByRole('button', { name: 'OK' }).click();
    await expect(dlg.getByRole('alert')).toContainText('too narrow');
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
  });

  test('text fills the first column, then the second, before the next page', async ({ app }) => {
    await columns(app, { preset: 'Two' });
    await lines(app, 20);
    const first = (await caretOf(app.page))!;
    expect(first.x).toBeLessThan(200);
    await lines(app, 30);
    // Past the bottom of the first column: still on page one, now in the right-hand column.
    expect(await pageCount(app.page)).toBe(1);
    const second = (await caretOf(app.page))!;
    expect(second.x).toBeGreaterThan(300);
    await lines(app, 60);
    expect(await pageCount(app.page)).toBeGreaterThanOrEqual(2);
  });

  test('one column gives the same text more pages than two columns', async ({ app }) => {
    await lines(app, 60);
    const one = await pageCount(app.page);
    expect(one).toBeGreaterThanOrEqual(2);
    await columns(app, { preset: 'Two' });
    await expect.poll(() => pageCount(app.page)).toBeLessThan(one);
    await columns(app, { preset: 'One' });
    await expect.poll(() => pageCount(app.page)).toBe(one);
  });

  test('Insert ▸ Break ▸ Column Break jumps to the next column (and Backspace takes it out)', async ({ app }) => {
    await columns(app, { preset: 'Two' });
    await app.type('left');
    await app.menu('Insert', 'Break', 'Column Break');
    await app.type('right');
    await expect.poll(async () => (await caretOf(app.page))?.x).toBeGreaterThan(300);
    expect(await pageCount(app.page)).toBe(1);
    expect(await app.text()).toContain('right');
    const { xml } = await docx(app);
    expect(xml).toMatch(/<w:br w:type="column"\/>/);
    // Shortcut form.
    await app.press('ControlOrMeta+End');
    await app.press('Backspace', 5);
    await app.press('Backspace');
    await expect.poll(async () => (await caretOf(app.page))?.x).toBeLessThan(300);
    await app.press('ControlOrMeta+Shift+Enter');
    await expect.poll(async () => (await caretOf(app.page))?.x).toBeGreaterThan(300);
  });

  test('Apply to "This point forward" starts a continuous section at the caret', async ({ app }) => {
    await app.type('intro');
    await app.press('Enter');
    await app.type('body');
    await columns(app, { preset: 'Two', apply: 'forward' });
    const { xml } = await docx(app);
    expect(count(xml, 'w:sectPr')).toBe(2);
    expect(xml).toMatch(/w:type w:val="continuous"/);
    expect(attrs(xml, 'w:cols', 0)['w:num'] ?? '1').toBe('1');
    expect(attrs(xml, 'w:cols', 1)['w:num']).toBe('2');
    expect(await app.text()).toContain('intro');
  });

  test('Apply to "Whole document" sets every section and "This section" only the caret\'s', async ({ app }) => {
    await app.type('intro');
    await app.press('Enter');
    await app.type('body');
    await columns(app, { preset: 'Two', apply: 'forward' });
    await columns(app, { preset: 'Three', apply: 'document' });
    let { xml } = await docx(app);
    expect(attrs(xml, 'w:cols', 0)['w:num']).toBe('3');
    expect(attrs(xml, 'w:cols', 1)['w:num']).toBe('3');
    await columns(app, { preset: 'Two', apply: 'section' });
    ({ xml } = await docx(app));
    const nums = [attrs(xml, 'w:cols', 0)['w:num'], attrs(xml, 'w:cols', 1)['w:num']];
    expect(nums.filter((n) => n === '2')).toHaveLength(1);
    expect(nums.filter((n) => n === '3')).toHaveLength(1);
  });

  test('the change is one undo step', async ({ app }) => {
    await app.type('Hello');
    await columns(app, { preset: 'Two' });
    await app.menu('Edit', 'Undo');
    await expect.poll(async () => attrs((await docx(app)).xml, 'w:cols')['w:num'] ?? '1').toBe('1');
    expect(await app.text()).toBe('Hello');
    await app.menu('Edit', 'Redo');
    await expect.poll(async () => attrs((await docx(app)).xml, 'w:cols')['w:num']).toBe('2');
  });

  test('Insert ▸ Break offers Page, Column and Line Break', async ({ app }) => {
    expect(await isMenuItemEnabled(app, 'Insert', 'Break', 'Page Break')).toBe(true);
    expect(await isMenuItemEnabled(app, 'Insert', 'Break', 'Column Break')).toBe(true);
    expect(await isMenuItemEnabled(app, 'Insert', 'Break', 'Line Break')).toBe(true);
  });
});
