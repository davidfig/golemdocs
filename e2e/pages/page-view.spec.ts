// HTML pages (docs/html-pages.md): an HTML file with a script, an embed or a golem meta opens as the page it makes, in a sandboxed frame
// under a bar. A page that came from elsewhere (dropped from the computer, here) can't read the person's documents; marked as theirs,
// it reads and changes them and follows what it read; allowed to read, a foreign page shows its embeds but runs no scripts.

import type { Page } from '@playwright/test';
import { expect, test } from '../files/fixtures';
import { dropFile, text, waitForOpen } from '../files/helpers';

interface PageState {
  active: boolean;
  name: string | null;
  trust: 'own' | 'foreign' | null;
  scripts: boolean;
  allowed: boolean;
  embeds: Record<string, string>;
  read: string[];
}

const state = (page: Page): Promise<PageState> => page.evaluate(() => (window as unknown as { pageViewer: { state(): PageState } }).pageViewer.state());

async function waitForPage(page: Page, name: string): Promise<void> {
  await expect.poll(async () => (await state(page)).name, { timeout: 30_000 }).toBe(name);
}

const frame = (page: Page) => page.frameLocator('iframe.wm-page-frame');

const PLAN = '# Plan\n\n## Goals\n\nShip pages.\n\n## Later\n\nNothing yet.\n';

const DASHBOARD = `<!doctype html><html><head><title>Dashboard</title><link rel="stylesheet" href="style.css"></head><body>
<h1>Dashboard</h1>
<golem-embed src="Plan.md#Goals"></golem-embed>
<p id="out">waiting</p>
<button id="add" type="button">Add</button>
<script>
  document.body.dataset.ran = 'yes';
  golem.notes('').then(
    (notes) => { document.getElementById('out').textContent = 'notes: ' + notes.map((n) => n.title).sort().join(', '); },
    (e) => { document.getElementById('out').textContent = 'refused: ' + e.message; },
  );
  document.getElementById('add').addEventListener('click', () => golem.appendToSection('Plan.md', 'Goals', 'Share pages.'));
  golem.on('change', () => { document.body.dataset.changed = 'yes'; });
</script>
</body></html>`;

test('a dropped page shows as a page from elsewhere: its script runs but reads nothing, and its embed is left out', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, text('Plan.md', PLAN));
  await waitForOpen(app, 'Plan.md');
  await dropFile(page, text('style.css', 'h1 { color: rgb(200, 0, 0); }'));
  await waitForOpen(app, 'style.css');
  await dropFile(page, text('Dashboard.html', DASHBOARD));
  await waitForPage(page, 'Dashboard.html');
  const s = await state(page);
  expect(s.trust).toBe('foreign');
  expect(s.scripts).toBe(true);
  const region = page.getByRole('region', { name: 'Dashboard.html' });
  await expect(region.getByRole('toolbar', { name: 'Page' })).toBeVisible();
  await expect(region.getByText('From elsewhere', { exact: true })).toBeVisible();
  await expect(frame(page).locator('body[data-ran="yes"]')).toHaveCount(1);
  await expect(frame(page).locator('#out')).toHaveText(/^refused: /);
  await expect(frame(page).locator('golem-embed .golem-embed-error')).toBeVisible();
  // Not even a file beside it: its script could send it away.
  await expect(frame(page).locator('link[rel="stylesheet"]')).toHaveAttribute('href', 'style.css');
  // Its frame has no origin of its own: nothing of the app's is in reach.
  const reach = await page.frameLocator('iframe.wm-page-frame').locator('body').evaluate(() => {
    let parentDocument = 'blocked';
    try {
      parentDocument = String(window.parent.document.title);
    } catch {
      /* cross-origin */
    }
    let storage = 'blocked';
    try {
      storage = String(window.localStorage.length);
    } catch {
      /* opaque origin */
    }
    return { parentDocument, storage, origin: window.origin };
  });
  expect(reach).toEqual({ parentDocument: 'blocked', storage: 'blocked', origin: 'null' });
});

test('marked as mine, a page reads the vault, fills its embed, changes a note and follows the change', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, text('Plan.md', PLAN));
  await waitForOpen(app, 'Plan.md');
  await dropFile(page, text('style.css', 'h1 { color: rgb(200, 0, 0); }'));
  await waitForOpen(app, 'style.css');
  await dropFile(page, text('Dashboard.html', DASHBOARD));
  await waitForPage(page, 'Dashboard.html');
  await page.getByRole('button', { name: 'Mark as Mine…' }).click();
  const ask = page.getByRole('alertdialog', { name: 'Mark This Page as Yours?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Mark as Mine' }).click();
  await expect.poll(async () => (await state(page)).trust).toBe('own');
  await expect(page.getByRole('region', { name: 'Dashboard.html' }).getByText('Yours', { exact: true })).toBeVisible();
  await expect(frame(page).locator('#out')).toHaveText(/notes: .*Plan/);
  await expect(frame(page).locator('golem-embed')).toContainText('Ship pages.');
  await expect(frame(page).locator('golem-embed')).not.toContainText('Nothing yet.');
  // Its stylesheet beside it is read from the vault.
  await expect(frame(page).locator('h1')).toHaveCSS('color', 'rgb(200, 0, 0)');
  // A change through the page is saved to the note, and the page, which read it, is told and shows it.
  await frame(page).getByRole('button', { name: 'Add' }).click();
  await expect(frame(page).locator('body[data-changed="yes"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(frame(page).locator('golem-embed')).toContainText('Share pages.');
  expect((await state(page)).read).toContain('Plan.md');
});

test('View › HTML as Document and Source show the same file, and HTML as Page goes back', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, text('Dashboard.html', DASHBOARD));
  await waitForPage(page, 'Dashboard.html');
  await page.getByRole('radio', { name: 'Document' }).click();
  await expect.poll(async () => (await state(page)).active).toBe(false);
  await app.ready();
  expect(await app.text()).toContain('Dashboard');
  await app.menu('View', 'HTML Source');
  await expect.poll(() => app.inTextEditor()).toBe(true);
  await app.menu('View', 'HTML as Page');
  await waitForPage(page, 'Dashboard.html');
  await expect(frame(page).locator('body[data-ran="yes"]')).toHaveCount(1);
});

test('a foreign page allowed to read shows its embeds and runs none of its scripts', async ({ app, page }) => {
  await app.goto('?doc=welcome');
  await dropFile(page, text('Plan.md', PLAN));
  await waitForOpen(app, 'Plan.md');
  const asking = DASHBOARD.replace('<title>', '<meta name="golem-reads" content="/"><title>');
  await dropFile(page, text('Asking.html', asking));
  await waitForPage(page, 'Asking.html');
  await expect(page.getByRole('status').filter({ hasText: 'asks to read' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow Reading…' }).click();
  const ask = page.getByRole('dialog', { name: 'Let This Page Read Your Documents?' });
  await ask.getByRole('button', { name: 'Allow Once' }).click();
  await expect.poll(async () => (await state(page)).allowed).toBe(true);
  const s = await state(page);
  expect(s.trust).toBe('foreign');
  expect(s.scripts).toBe(false);
  await expect(frame(page).locator('golem-embed')).toContainText('Ship pages.');
  await expect(frame(page).locator('#out')).toHaveText('waiting');
  await expect(frame(page).locator('body[data-ran="yes"]')).toHaveCount(0);
});
