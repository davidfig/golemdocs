// The shared controls from the keyboard and to a screen reader (docs/architecture/accessibility.md): colour swatches by
// name, segmented choices as radio groups, and the layers panel as a tree.

import { expect, test, type App } from '../fixtures';
import { importFile } from '../files/helpers';

const DRAWING = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">
  <rect id="red" x="20" y="20" width="120" height="80" fill="#e53935"/>
  <circle id="green" cx="300" cy="100" r="60" fill="#43a047"/>
</svg>`;

async function openDrawing(app: App): Promise<void> {
  await app.blank();
  await importFile(app, { name: 'drawing.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(DRAWING) });
  await expect(app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem')).toHaveCount(2, { timeout: 30_000 });
}

test.describe('Shared controls', () => {
  test('a palette’s swatches are named as colours, and the colour in use is marked as current', async ({ app }) => {
    await app.blank();
    await app.page.getByRole('toolbar').getByRole('button', { name: 'Font Color options' }).click();
    const palette = app.page.getByRole('dialog', { name: 'Font Color' });
    await expect(palette.locator('.wm-swatch[title="#FF0000"]')).toHaveAttribute('aria-label', 'Red');
    await expect(palette.locator('.wm-swatch[title="#008000"]')).toHaveAttribute('aria-label', 'Dark Green');
    await palette.locator('.wm-swatch[title="#008000"]').click();
    await app.page.getByRole('toolbar').getByRole('button', { name: 'Font Color options' }).click();
    await expect(palette.locator('.wm-swatch[aria-current="true"]')).toHaveAttribute('title', '#008000');
  });

  test('a segmented choice is a radio group: one Tab stop, and the arrow keys choose', async ({ app }) => {
    await app.blank();
    await app.menu('Tools', 'Options');
    const widths = app.page.getByRole('radiogroup', { name: 'Caret width' });
    const thin = widths.getByRole('radio', { name: 'Thin' });
    await expect(thin).toHaveAttribute('aria-checked', 'true');
    await expect(widths.locator('[tabindex="0"]')).toHaveCount(1);
    await thin.focus();
    await app.press('ArrowRight');
    await expect(widths.getByRole('radio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'true');
    await expect(widths.getByRole('radio', { name: 'Medium' })).toBeFocused();
    await app.press('ArrowLeft');
    await expect(thin).toHaveAttribute('aria-checked', 'true');
  });

  test('the layers panel is a tree the keyboard can move through and pick from', async ({ app }) => {
    await openDrawing(app);
    const tree = app.page.getByRole('tree', { name: 'Layers' });
    const rows = tree.getByRole('treeitem');
    await expect(rows.first()).toHaveAttribute('aria-level', '1');
    await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
    await tree.locator('[role="treeitem"][tabindex="0"]').focus();
    const first = await app.page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    await app.press('ArrowDown');
    const second = await app.page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    expect(second).not.toBe(first);
    await app.press('Enter');
    await expect(tree.getByRole('treeitem', { name: second!, exact: true })).toHaveAttribute('aria-selected', 'true');
    // Picking redraws the list, and the keyboard stays on the row.
    await expect.poll(() => app.page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(second);
    await app.press('Home');
    await expect.poll(() => app.page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(first);
  });

  test('a picked shape moves with the arrow keys and resizes with Alt, and Screen Reader Mode says where it is', async ({ app }) => {
    await openDrawing(app);
    await app.menu('Tools', 'Screen Reader Mode');
    const tree = app.page.getByRole('tree', { name: 'Layers' });
    await tree.getByRole('treeitem', { name: /red/ }).click();
    await expect(tree.getByRole('treeitem', { name: /red/ })).toHaveAttribute('aria-selected', 'true');
    await app.focus();
    const said = app.page.locator('.wm-sr-only[aria-live]');
    await app.press('Alt+Shift+ArrowRight');
    await expect(said).toContainText(['Left 20, top 20, 130 by 80']);
    await app.press('Alt+ArrowUp');
    await expect(said).toContainText(['Left 20, top 20, 130 by 79']);
    await app.press('Shift+ArrowDown');
    await expect(said).toContainText(['Left 20, top 30, 130 by 79']);
  });
});
