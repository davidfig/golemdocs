import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { choose, seedStorage, stored } from './helpers';

const FLAGS = { status: false, edit: false, load: false, pages: false, cpu: false, fps: false, frameTimes: false };
const flags = (on: Partial<typeof FLAGS>) => JSON.stringify({ ...FLAGS, ...on });
const renderInfo = (page: Page) => page.locator('#renderInfo');
const statusPanels = (page: Page) => page.locator('#statusPanels .debug-panel');
const debugRow = (panel: ReturnType<Page['locator']>, name: string) => panel.locator('.debug-stats').getByText(name, { exact: true });

/** Signs the page in as an admin (the server's account lookup is answered locally), which unlocks the Admin menu. */
async function asAdmin(page: Page): Promise<void> {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { user: { id: 'e2e-admin', email: 'admin@example.com', name: 'Admin', isAdmin: true } } }),
  );
}

test.describe('debug overlays', () => {
  test('are all off by default', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await expect(renderInfo(page)).toBeHidden();
    await expect(statusPanels(page)).toHaveCount(0);
  });

  test('Status shows the Document panel with the status text', async ({ app, page }) => {
    await seedStorage(page, { 'golem.debug': flags({ status: true }) });
    await app.goto('?doc=welcome');
    const panel = statusPanels(page).filter({ has: page.getByRole('heading', { name: 'Document' }) });
    await expect(panel).toBeVisible();
    await expect(debugRow(panel, 'status')).toBeVisible();
    await expect(debugRow(panel, 'pages')).toBeVisible();
    await expect(debugRow(panel, 'glyphs')).toBeVisible();
    await expect(renderInfo(page)).toBeHidden();
  });

  test('Load times shows how long the document took to open, in parts', async ({ app, page }) => {
    await seedStorage(page, { 'golem.debug': flags({ load: true }) });
    await app.goto('?doc=welcome');
    const panel = statusPanels(page).filter({ has: page.getByRole('heading', { name: 'Load' }) });
    await expect(panel).toBeVisible();
    for (const row of ['first page', 'all', 'read', 'fonts', 'body', 'headers']) await expect(debugRow(panel, row)).toBeVisible();
    await expect(panel.locator('.debug-stats')).toContainText(/\d+ ms/);
  });

  test('Edit times appears once something has been edited', async ({ app, page }) => {
    await seedStorage(page, { 'golem.debug': flags({ edit: true }) });
    await app.blank();
    await app.type('typing');
    const panel = statusPanels(page).filter({ has: page.getByRole('heading', { name: 'Edit' }) });
    await expect(panel).toBeVisible();
    await expect(debugRow(panel, 'to screen')).toBeVisible();
    await expect(debugRow(panel, 'worker')).toBeVisible();
  });

  test('Pages and glyphs, CPU time and the frame-time rows all live in the Render panel', async ({ app, page }) => {
    await seedStorage(page, { 'golem.debug': flags({ pages: true, cpu: true, frameTimes: true }) });
    await app.goto('?doc=welcome');
    await expect(renderInfo(page)).toBeVisible();
    await expect(renderInfo(page).getByRole('heading', { name: /Render/ })).toBeVisible();
    for (const row of ['pages', 'glyphs', 'draws', 'cpu', 'slowest', 'gap', 'dropped']) await expect(debugRow(renderInfo(page), row)).toBeVisible();
    await expect(debugRow(renderInfo(page), 'fps')).toHaveCount(0);
    await expect(page.locator('#renderLight')).toBeHidden();
  });

  test('FPS shows the frame rate and the render light', async ({ app, page }) => {
    await seedStorage(page, { 'golem.debug': flags({ fps: true }) });
    await app.goto('?doc=welcome');
    await expect(renderInfo(page)).toBeVisible();
    await expect(debugRow(renderInfo(page), 'fps')).toBeVisible();
    await expect(page.locator('#renderLight')).toBeVisible();
    await expect(debugRow(renderInfo(page), 'cpu')).toHaveCount(0);
  });

  test('clicking the Render panel resets the frame times', { tag: '@heavy' }, async ({ app, page }) => {
    await seedStorage(page, { 'golem.debug': flags({ frameTimes: true }) });
    await app.goto('?doc=welcome');
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, 200);
    // Let the scroll animation finish: frames drawn after the reset, still part of it, can count as dropped.
    await page.waitForTimeout(1500);
    await renderInfo(page).click();
    await expect(renderInfo(page).locator('.debug-stats')).toContainText('dropped');
    await expect(renderInfo(page).locator('.debug-stats')).toContainText(/dropped\s*0/);
  });

  test('corrupt saved flags are ignored and everything stays off', async ({ app, page }) => {
    await seedStorage(page, { 'golem.debug': '{not json' });
    await app.goto('?doc=welcome');
    await expect(renderInfo(page)).toBeHidden();
    await expect(statusPanels(page)).toHaveCount(0);
  });
});

test.describe('Admin ▸ Debug dialog', () => {
  test('each checkbox turns its overlay on and off at once and is saved in golem.debug', async ({ app, page }) => {
    await asAdmin(page);
    await app.goto('?doc=welcome');
    await choose(app, 'Admin', 'Debug…');
    const dialog = page.locator('dialog', { hasText: 'Debug' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('group').or(dialog.locator('fieldset')).first()).toBeVisible();
    const boxes = ['Status', 'Edit times', 'Load times', 'Pages and glyphs', 'CPU time', 'FPS and render light', 'Slowest and dropped frames'];
    for (const label of boxes) await expect(dialog.getByLabel(label)).not.toBeChecked();

    await dialog.getByLabel('Status').check();
    await expect(statusPanels(page).first()).toBeVisible();
    expect(JSON.parse((await stored(page, 'golem.debug'))!)).toMatchObject({ status: true, fps: false });

    await dialog.getByLabel('FPS and render light').check();
    await expect(renderInfo(page)).toBeVisible();
    await expect(page.locator('#renderLight')).toBeVisible();
    await dialog.getByLabel('Pages and glyphs').check();
    await expect(debugRow(renderInfo(page), 'pages')).toBeVisible();
    await dialog.getByLabel('CPU time').check();
    await expect(debugRow(renderInfo(page), 'cpu')).toBeVisible();
    await dialog.getByLabel('Slowest and dropped frames').check();
    await expect(debugRow(renderInfo(page), 'slowest')).toBeVisible();
    await dialog.getByLabel('Load times').check();
    await expect(statusPanels(page).filter({ has: page.getByRole('heading', { name: 'Load' }) })).toBeVisible();
    await dialog.getByLabel('Edit times').check();

    await dialog.getByLabel('Status').uncheck();
    await dialog.getByLabel('Load times').uncheck();
    await expect(statusPanels(page).filter({ has: page.getByRole('heading', { name: 'Document' }) })).toHaveCount(0);
    for (const label of ['FPS and render light', 'Pages and glyphs', 'CPU time', 'Slowest and dropped frames']) await dialog.getByLabel(label).uncheck();
    await expect(renderInfo(page)).toBeHidden();
    expect(JSON.parse((await stored(page, 'golem.debug'))!)).toEqual({ ...FLAGS, edit: true });
  });

  test('the flags survive a reload', async ({ app, page }) => {
    await asAdmin(page);
    await app.goto('?doc=welcome');
    await choose(app, 'Admin', 'Debug…');
    await page.locator('dialog', { hasText: 'Debug' }).getByLabel('FPS and render light').check();
    await page.reload();
    await app.ready();
    await expect(renderInfo(page)).toBeVisible();
    await expect(debugRow(renderInfo(page), 'fps')).toBeVisible();
  });

  test('the dialog groups flags under Document and Render and closes with OK', async ({ app, page }) => {
    await asAdmin(page);
    await app.goto('?doc=welcome');
    await choose(app, 'Admin', 'Debug…');
    const dialog = page.locator('dialog', { hasText: 'Debug' });
    await expect(dialog.locator('legend')).toHaveText(['Document', 'Render']);
    await dialog.getByRole('button', { name: 'OK' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(app.editor).toBeFocused();
  });
});
