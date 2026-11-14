// Moving documents and folders, by dragging and with the Move dialog, on the Files Sidebar and the Open screen. Everything runs in
// Chromium and in WebKit, the engine of the desktop shell's WKWebView: a card's drag once worked in only one of them. The shell's own
// part (dragDropEnabled, without which no drag reaches the page) can't run here: it is checked in client/test/desktopShell.test.ts.

import { expect, test, webkit, type Browser, type Locator, type Page } from '@playwright/test';
import { App, boxOf, dragOnto } from '../fixtures';
import { signInAs, uniqueEmail } from '../collab/helpers';
import { importFile, moveTo, text } from './helpers';

const VIEWPORT = { width: 1280, height: 800 };

const sidebar = (page: Page) => page.locator('.wm-files');
const row = (page: Page, name: string) => sidebar(page).locator('.wm-files-file', { hasText: name });
const folderRow = (page: Page, name: string) => sidebar(page).locator('.wm-files-folder', { hasText: name });
const screen = (page: Page) => page.locator('.wm-dashboard');
const card = (page: Page, name: string) => screen(page).locator('article.wm-card:not(.wm-folder)').filter({ hasText: name });
const folderCard = (page: Page, name: string) => screen(page).locator('article.wm-folder').filter({ hasText: name });

/** Closes what the running test opened, whether it passed or not. */
let closeBrowsers: (() => Promise<void>) | null = null;

test.afterEach(async () => {
  await closeBrowsers?.();
  closeBrowsers = null;
});

/** A new browser profile in `engine`, signed in to an account of its own, with the sidebar open and these documents in it. */
async function start(engine: 'chromium' | 'webkit', chromium: Browser, baseURL: string | undefined, docs: string[]): Promise<{ page: Page; app: App }> {
  let own: Browser | null = null;
  if (engine === 'webkit') {
    try {
      // The project's Chromium options (its channel and GPU flags) are not WebKit's.
      own = await webkit.launch({ channel: undefined, args: [] });
    } catch {
      test.skip(true, 'WebKit is not installed (pnpm exec playwright install webkit)');
    }
  }
  // No permissions: the project's clipboard ones are Chromium's.
  const context = await (own ?? chromium).newContext({ viewport: VIEWPORT, baseURL, permissions: [] });
  closeBrowsers = async () => {
    await context.close();
    await own?.close();
  };
  await signInAs(context, uniqueEmail('moving'));
  const page = await context.newPage();
  const app = new App(page);
  await app.goto('?doc=welcome');
  if (!(await sidebar(page).isVisible())) await app.menu('View', 'Files Sidebar');
  await expect(sidebar(page)).toBeVisible();
  for (const name of docs) {
    await importFile(app, text(name, 'words'));
    await expect(row(page, name)).toHaveCount(1);
  }
  return { page, app };
}

async function newSidebarFolder(page: Page, name: string): Promise<void> {
  await sidebar(page).locator('.wm-files-tree').click({ button: 'right', position: { x: 100, y: 500 } });
  await page.getByRole('menuitem', { name: 'New folder' }).click();
  await page.locator('.wm-files-rename').fill(name);
  await page.keyboard.press('Enter');
  await expect(folderRow(page, name)).toHaveCount(1);
}

async function newScreenFolder(page: Page, name: string): Promise<void> {
  await screen(page).getByRole('button', { name: 'New folder', exact: true }).click();
  const field = screen(page).getByRole('textbox', { name: 'Folder name' });
  await field.fill(name);
  await field.press('Enter');
  await expect(folderCard(page, name)).toHaveCount(1);
}

/** Waits for every document to be in the account and the page to know it, as a reload during an upload would send the document twice. */
async function uploaded(page: Page, count: number): Promise<void> {
  await expect.poll(async () => ((await (await page.request.get('/api/documents')).json()) as unknown[]).length, { timeout: 20_000 }).toBe(count);
  await expect(page.getByRole('button', { name: 'Saving: Saved' })).toBeVisible({ timeout: 20_000 });
}

/** Holds a drag from `from` over `to`, has a listing come in, then lets go. */
async function dropWithListingMidDrag(page: Page, from: Locator, to: Locator): Promise<void> {
  const a = await boxOf(from);
  const b = await boxOf(to);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 });
  await page.evaluate(() => {
    const { library } = window as unknown as { library: { update(change: { entries: unknown }): void; entries: unknown[] } };
    library.update({ entries: [...library.entries] });
  });
  await page.mouse.move(b.x + b.width / 2 + 1, b.y + b.height / 2 + 1, { steps: 2 });
  await page.mouse.up();
}

for (const engine of ['chromium', 'webkit'] as const) {
  test.describe(engine, () => {
    test('sidebar: a document and a folder dragged onto a folder go in it, stay after a reload, and a drag to the empty part takes one back to the top level', async ({ browser, baseURL }) => {
      const { page, app } = await start(engine, browser, baseURL, ['alpha.txt', 'beta.txt']);
      await newSidebarFolder(page, 'Target');
      await newSidebarFolder(page, 'Inner');

      await dragOnto(row(page, 'alpha'), folderRow(page, 'Target'));
      await expect(folderRow(page, 'Target')).toHaveAttribute('aria-expanded', 'true');
      await expect(row(page, 'alpha')).toHaveAttribute('aria-level', '2');

      await dragOnto(folderRow(page, 'Inner'), folderRow(page, 'Target'));
      await expect(folderRow(page, 'Inner')).toHaveAttribute('aria-level', '2');

      // Dropped on a document, it goes in the folder that document is in.
      await dragOnto(row(page, 'beta'), row(page, 'alpha'));
      await expect(row(page, 'beta')).toHaveAttribute('aria-level', '2');

      await uploaded(page, 2);
      await page.reload();
      await app.ready();
      await expect(row(page, 'alpha')).toHaveAttribute('aria-level', '2');
      await expect(folderRow(page, 'Inner')).toHaveAttribute('aria-level', '2');

      await dragOnto(row(page, 'alpha'), sidebar(page).locator('.wm-files-tree'), { x: 100, y: 500 });
      await expect(row(page, 'alpha')).toHaveAttribute('aria-level', '1');
    });

    test('sidebar: a folder can\'t be dragged into itself or into a folder inside it', async ({ browser, baseURL }) => {
      const { page } = await start(engine, browser, baseURL, []);
      await newSidebarFolder(page, 'Outer');
      await newSidebarFolder(page, 'Inner');
      await dragOnto(folderRow(page, 'Inner'), folderRow(page, 'Outer'));
      await expect(folderRow(page, 'Inner')).toHaveAttribute('aria-level', '2');

      await dragOnto(folderRow(page, 'Outer'), folderRow(page, 'Inner'));
      await page.waitForTimeout(300);
      await expect(folderRow(page, 'Outer')).toHaveAttribute('aria-level', '1');
      await expect(folderRow(page, 'Inner')).toHaveAttribute('aria-level', '2');
    });

    test('sidebar: a listing that comes in mid-drag doesn\'t cancel the drag', async ({ browser, baseURL }) => {
      const { page } = await start(engine, browser, baseURL, ['alpha.txt']);
      await newSidebarFolder(page, 'Target');
      await dropWithListingMidDrag(page, row(page, 'alpha'), folderRow(page, 'Target'));
      await expect(row(page, 'alpha')).toHaveAttribute('aria-level', '2');
    });

    test('sidebar: a document moved while it is still uploading stays moved, in the account too', async ({ browser, baseURL }) => {
      const { page, app } = await start(engine, browser, baseURL, []);
      await newSidebarFolder(page, 'Target');
      let uploadStarted = false;
      await page.route('**/api/documents**', async (route) => {
        if (route.request().method() === 'POST') {
          uploadStarted = true;
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
        await route.continue();
      });
      await importFile(app, text('alpha.txt', 'words'));
      await expect(row(page, 'alpha')).toHaveCount(1);
      await expect.poll(() => uploadStarted, { timeout: 20_000 }).toBe(true);

      await dragOnto(row(page, 'alpha'), folderRow(page, 'Target'));
      await expect(row(page, 'alpha')).toHaveAttribute('aria-level', '2');

      const inFolder = async () => ((await (await page.request.get('/api/documents')).json()) as { name: string; folderId: string | null }[]).find((d) => d.name === 'alpha.txt')?.folderId;
      await expect.poll(inFolder, { timeout: 20_000 }).toEqual(expect.any(String));
      await uploaded(page, 1);
      await page.reload();
      await app.ready();
      await expect(row(page, 'alpha')).toHaveAttribute('aria-level', '2');
    });

    test('sidebar: the menu\'s Move… shows the dialog on screen, for a document and a folder, and Escape closes it', async ({ browser, baseURL }) => {
      const { page } = await start(engine, browser, baseURL, ['alpha.txt']);
      await newSidebarFolder(page, 'Target');
      await newSidebarFolder(page, 'Inner');

      await row(page, 'alpha').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Move…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Move “alpha.txt” to…' });
      await expect(dialog).toBeInViewport({ ratio: 1 });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(row(page, 'alpha')).toHaveAttribute('aria-level', '1');

      await row(page, 'alpha').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Move…' }).click();
      await moveTo(page, 'Target', dialog);
      await expect(dialog).toHaveCount(0);
      await expect(row(page, 'alpha')).toHaveAttribute('aria-level', '2');

      await folderRow(page, 'Inner').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Move…' }).click();
      const folderDialog = page.getByRole('dialog', { name: 'Move “Inner” to…' });
      await expect(folderDialog).toBeInViewport({ ratio: 1 });
      await moveTo(page, 'Target', folderDialog);
      await expect(folderRow(page, 'Inner')).toHaveAttribute('aria-level', '2');
    });

    test('Open screen: a document and a folder dragged onto a folder go in it, and stay after a reload', async ({ browser, baseURL }) => {
      const { page, app } = await start(engine, browser, baseURL, ['alpha.txt']);
      await app.menu('File', 'Open…');
      await newScreenFolder(page, 'Target');
      await newScreenFolder(page, 'Inner');

      await dragOnto(card(page, 'alpha'), folderCard(page, 'Target'));
      await expect(card(page, 'alpha')).toHaveCount(0);
      await expect(folderCard(page, 'Target').locator('.wm-card-meta')).toHaveText('1 item');

      await dragOnto(folderCard(page, 'Inner'), folderCard(page, 'Target'));
      await expect(folderCard(page, 'Inner')).toHaveCount(0);
      await expect(folderCard(page, 'Target').locator('.wm-card-meta')).toHaveText('2 items');

      await uploaded(page, 1);
      await page.reload();
      await app.ready();
      await app.menu('File', 'Open…');
      // The screen opens on the folder the open document is in, which is now this one.
      await expect(screen(page).locator('.wm-dash-crumbs')).toContainText('Target');
      await expect(card(page, 'alpha')).toHaveCount(1);
      await expect(folderCard(page, 'Inner')).toHaveCount(1);
    });

    test('Open screen: a drag from inside a folder onto the path above it takes the document out', async ({ browser, baseURL }) => {
      const { page, app } = await start(engine, browser, baseURL, ['alpha.txt']);
      await app.menu('File', 'Open…');
      await newScreenFolder(page, 'Target');
      await dragOnto(card(page, 'alpha'), folderCard(page, 'Target'));
      await expect(card(page, 'alpha')).toHaveCount(0);

      await folderCard(page, 'Target').getByRole('button', { name: 'Open folder Target' }).click();
      await expect(card(page, 'alpha')).toHaveCount(1);
      await dragOnto(card(page, 'alpha'), screen(page).locator('.wm-dash-crumbs').getByRole('button').first());
      await expect(card(page, 'alpha')).toHaveCount(0);
    });

    test('a document whose upload has not answered yet shows once, and moving it meanwhile keeps it where it was put', async ({ browser, baseURL }) => {
      const { page, app } = await start(engine, browser, baseURL, []);
      // The account has the document, and the answer saying so is still on its way.
      let answer = () => {};
      const held = new Promise<void>((resolve) => (answer = resolve));
      let sent = () => {};
      const sending = new Promise<void>((resolve) => (sent = resolve));
      await page.route(/\/api\/documents(\?.*)?$/, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch();
        sent();
        await held;
        await route.fulfill({ response });
      });
      await importFile(app, text('alpha.txt', 'words'));
      await sending;

      await app.menu('File', 'Open…');
      // Making a folder lists the account, which by now has the document.
      const listed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/documents' && r.request().method() === 'GET');
      await newScreenFolder(page, 'Target');
      await listed;
      await expect.poll(async () => ((await (await page.request.get('/api/documents')).json()) as unknown[]).length).toBe(1);
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 100))));
      await expect(card(page, 'alpha')).toHaveCount(1);
      await expect(row(page, 'alpha')).toHaveCount(1);

      await card(page, 'alpha').hover();
      await card(page, 'alpha').getByRole('button', { name: 'Move…' }).click();
      await moveTo(page, 'Target', page.getByRole('dialog', { name: 'Move “alpha.txt” to…' }));
      await expect(card(page, 'alpha')).toHaveCount(0);

      answer();
      await uploaded(page, 1);
      await expect(folderCard(page, 'Target').locator('.wm-card-meta')).toHaveText('1 item');
      await expect.poll(async () => ((await (await page.request.get('/api/documents')).json()) as { folderId: string | null }[])[0]!.folderId).not.toBeNull();
      await page.unrouteAll();
      await page.reload();
      await app.ready();
      await expect(row(page, 'alpha')).toHaveCount(1);
      await expect(row(page, 'alpha')).toHaveAttribute('aria-level', '2');
    });

    test('Open screen: a listing that comes in mid-drag doesn\'t cancel the drag', async ({ browser, baseURL }) => {
      const { page, app } = await start(engine, browser, baseURL, ['alpha.txt']);
      await app.menu('File', 'Open…');
      await newScreenFolder(page, 'Target');
      await dropWithListingMidDrag(page, card(page, 'alpha'), folderCard(page, 'Target'));
      await expect(card(page, 'alpha')).toHaveCount(0);
      await expect(folderCard(page, 'Target').locator('.wm-card-meta')).toHaveText('1 item');
    });

    test('Open screen: Move… shows the dialog on screen, for a document and a folder', async ({ browser, baseURL }) => {
      const { page, app } = await start(engine, browser, baseURL, ['alpha.txt']);
      await app.menu('File', 'Open…');
      await newScreenFolder(page, 'Target');
      await newScreenFolder(page, 'Inner');

      await card(page, 'alpha').hover();
      await card(page, 'alpha').getByRole('button', { name: 'Move…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Move “alpha.txt” to…' });
      await expect(dialog).toBeInViewport({ ratio: 1 });
      await moveTo(page, 'Target', dialog);
      await expect(card(page, 'alpha')).toHaveCount(0);
      await expect(folderCard(page, 'Target').locator('.wm-card-meta')).toHaveText('1 item');

      await folderCard(page, 'Inner').hover();
      await folderCard(page, 'Inner').getByRole('button', { name: 'Move…' }).click();
      const folderDialog = page.getByRole('dialog', { name: 'Move “Inner” to…' });
      await expect(folderDialog).toBeInViewport({ ratio: 1 });
      await moveTo(page, 'Target', folderDialog);
      await expect(folderCard(page, 'Inner')).toHaveCount(0);
    });

    test('Open screen: Move… moves everything ticked', async ({ browser, baseURL }) => {
      const { page, app } = await start(engine, browser, baseURL, ['alpha.txt', 'beta.txt']);
      await app.menu('File', 'Open…');
      await newScreenFolder(page, 'Target');
      for (const name of ['alpha', 'beta']) {
        await card(page, name).hover();
        await card(page, name).getByRole('checkbox').check();
      }
      await screen(page).locator('.wm-dash-selection').getByRole('button', { name: 'Move…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Move 2 items to…' });
      await expect(dialog).toBeInViewport({ ratio: 1 });
      await moveTo(page, 'Target', dialog);
      await expect(screen(page).locator('article.wm-card:not(.wm-folder)')).toHaveCount(0);
      await expect(folderCard(page, 'Target').locator('.wm-card-meta')).toHaveText('2 items');
    });
  });
}
