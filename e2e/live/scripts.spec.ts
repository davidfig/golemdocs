// Scripts (docs/live-blocks.md §8): a script in the vault's Scripts folder fills a live block (a producer) or changes documents
// (an action). It runs in a sandboxed frame and worker that cannot reach the network, storage or the app, and only with
// what the person allowed.

import type { Page } from '@playwright/test';
import { expect, test } from '../files/fixtures';
import { buildZip, status } from '../files/helpers';

const dashboard = (page: Page) => page.locator('.wm-dashboard');

/** Imports files at the top of the vault (`Scripts/...`, `Books/...`). */
async function importFiles(app: { goto(url: string): Promise<void>; menu(...path: string[]): Promise<void> }, page: Page, files: { name: string; data: string }[]): Promise<void> {
  await app.goto('?doc=welcome');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), app.menu('File', 'Import…')]);
  await chooser.setFiles({ name: 'vault.zip', mimeType: 'application/zip', buffer: buildZip(files) });
  await expect.poll(() => status(page)).toBe(`Imported documents: ${files.length}`);
}

/** Opens a document from File › Open, going into its folders. */
async function openFile(app: { menu(...path: string[]): Promise<void> }, page: Page, path: string): Promise<void> {
  await app.menu('File', 'Open…');
  const parts = path.split('/');
  const name = parts.pop()!;
  // From the top of the vault: the dashboard opens in the folder it showed last.
  const top = dashboard(page).getByRole('navigation').getByRole('button').first();
  if (await top.isVisible()) await top.click();
  for (const folder of parts) await dashboard(page).getByRole('button', { name: `Open folder ${folder}` }).click();
  await dashboard(page).getByRole('button', { name: `Open ${name}` }).click();
}

const allow = async (page: Page, choice = 'Always Allow') => {
  const dialog = page.getByRole('dialog', { name: 'Allow Script' });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: choice }).click();
};

test('a script cannot reach the network, storage, the app or the clock', async ({ app, page }) => {
  await importFiles(app, page, [
    {
      name: 'Scripts/escape.ts',
      data: `export const meta = { name: 'Escape', reads: [] };
export default async function ({ table }) {
  const tries: [string, string][] = [];
  const attempt = async (name: string, f: () => unknown) => {
    try {
      await f();
      tries.push([name, 'reached']);
    } catch {
      tries.push([name, 'blocked']);
    }
  };
  await attempt('fetch', () => fetch('/api/me'));
  // The engine's own fetch, past the one the runtime took away: the frame's policy stops it.
  await attempt('protofetch', () => (Object.getPrototypeOf(Object.getPrototypeOf(globalThis)).fetch as typeof fetch).call(globalThis, '/api/me'));
  await attempt('xhr', () => new XMLHttpRequest());
  await attempt('socket', () => new WebSocket('wss://example.com'));
  await attempt('indexeddb', () => indexedDB.open('golem'));
  await attempt('cookies', () => (globalThis as any).document.cookie);
  await attempt('parent', () => (globalThis as any).parent.document.body);
  // A computed address, which the linker cannot see: the frame's policy stops it.
  const away = ['https:', '', 'example.com', 'x.js'].join('/');
  await attempt('import', () => import(away));
  // The desktop and iOS shells' bridges to the app (Tauri's, and the web view's message handlers), which a frame of the page could see.
  await attempt('tauri', () => (globalThis as any).__TAURI_INTERNALS__.invoke('plugin:fs|read_dir', {}));
  await attempt('webview', () => (globalThis as any).webkit.messageHandlers.ipc.postMessage('{}'));
  await attempt('ipc', () => fetch('ipc://localhost/plugin%3Afs%7Cread_dir'));
  await attempt('clock', () => Date.now());
  await attempt('newdate', () => new Date());
  return table(['Try', 'Result'], tries);
}`,
    },
    { name: 'Escapes.md', data: 'Tries:\n\n![[Scripts/escape.ts]]\n' },
  ]);
  await openFile(app, page, 'Escapes.md');
  await allow(page);
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('newdate');
  const text = await app.text();
  for (const name of ['fetch', 'protofetch', 'xhr', 'socket', 'indexeddb', 'cookies', 'parent', 'import', 'tauri', 'webview', 'ipc', 'clock', 'newdate']) expect(text).toMatch(new RegExp(`${name}\\s+blocked`));
  expect(text).not.toContain('reached');
});

test('a script that loops, sends back too much or reads outside what it asked for fails, and its block says why', async ({ app, page }) => {
  await importFiles(app, page, [
    { name: 'Scripts/loop.ts', data: 'export const meta = { reads: [] };\nexport default () => { for (;;) {} };' },
    { name: 'Scripts/huge.ts', data: "export const meta = { reads: [] };\nexport default ({ value }) => value('x'.repeat(3_000_000));" },
    { name: 'Scripts/snoop.ts', data: "export const meta = { reads: ['Books/'] };\nexport default async ({ read, value }) => value((await read('Diary/secret.md'))?.text);" },
    { name: 'Diary/secret.md', data: 'Nobody reads this.\n' },
    { name: 'Loop.md', data: 'Loop:\n\n![[Scripts/loop.ts]]\n' },
    { name: 'Huge.md', data: 'Huge:\n\n![[Scripts/huge.ts]]\n' },
    { name: 'Snoop.md', data: 'Snoop:\n\n![[Scripts/snoop.ts]]\n' },
  ]);
  // Each fails with its reason, which the status bar tells when its note is opened.
  for (const [note, reason] of [
    ['Loop.md', /took longer than 5 seconds/],
    ['Huge.md', /more than the 2 MB a run may/],
    ['Snoop.md', /did not ask to read Diary\/secret\.md/],
  ] as const) {
    await openFile(app, page, note);
    await allow(page);
    await expect.poll(() => status(page), { timeout: 20_000 }).toMatch(reason);
  }
  expect(await app.text()).not.toContain('Nobody reads this');
});

test('a note showing a script’s result is updated when a note the script reads changes', async ({ app, page }) => {
  test.setTimeout(120_000);
  await importFiles(app, page, [
    { name: 'Scripts/lib/first.ts', data: 'export const firstLine = (text: string): string => text.split("\\n").find((l) => l.trim()) ?? "";' },
    {
      name: 'Scripts/books.ts',
      data: "import { firstLine } from './lib/first.ts';\nexport const meta = { name: 'Books', reads: ['Books/'] };\nexport default async ({ notes, table }) => table(['Book', 'Opening'], (await notes('Books/')).map((n) => [n.title, firstLine(n.text)]));",
    },
    { name: 'Books/Dune.md', data: 'A desert planet.\n' },
    { name: 'Reading.md', data: 'My books:\n\n![[Scripts/books.ts]]\n' },
  ]);
  await openFile(app, page, 'Reading.md');
  await allow(page);
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('A desert planet.');
  // The book changes; the reading list follows once editing pauses.
  await openFile(app, page, 'Books/Dune.md');
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('A desert planet.');
  await app.focus();
  await app.press('ControlOrMeta+Home');
  await app.type('Spice. ');
  await expect.poll(async () => {
    await openFile(app, page, 'Reading.md');
    return app.text();
  }, { timeout: 60_000, intervals: [3_000] }).toContain('Spice. A desert planet.');
});

test('an action run from Tools › Run Script changes a note, and Undo This Run puts it back', async ({ app, page }) => {
  await importFiles(app, page, [
    {
      name: 'Scripts/inbox.ts',
      data: "export const meta = { name: 'Tidy inbox', writes: ['Inbox/'] };\nexport default async ({ open }) => { const doc = await open('Inbox/Todo.md'); doc.appendToSection('Later', '- water the plants'); doc.setField('tidied', 'yes'); return 'tidied'; };",
    },
    { name: 'Inbox/Todo.md', data: '# Todo\n\n## Now\n\n- write\n\n## Later\n\n- read\n' },
  ]);
  await app.menu('Tools', 'Run Script…');
  const picker = page.getByRole('dialog', { name: 'Run Script' });
  await picker.getByText('Tidy inbox (Scripts/inbox.ts)').click();
  await picker.getByRole('button', { name: 'Run', exact: true }).click();
  await allow(page, 'Allow Once');
  await expect.poll(() => status(page), { timeout: 20_000 }).toBe('Tidy inbox: tidied');
  await openFile(app, page, 'Inbox/Todo.md');
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('water the plants');

  await app.menu('Tools', 'Scripts…');
  const scripts = page.getByRole('dialog', { name: 'Scripts' });
  await scripts.getByText(/Tidy inbox: tidied/).click();
  await scripts.getByRole('button', { name: 'Undo This Run' }).click();
  await expect(scripts.getByText(/Tidy inbox: undone/)).toBeVisible({ timeout: 20_000 });
  await scripts.getByRole('button', { name: 'OK' }).click();
  await expect.poll(() => app.text(), { timeout: 20_000 }).not.toContain('water the plants');
  expect(await app.text()).toContain('read');
});

test('a button block shows its action’s name, and its card runs it', async ({ app, page }) => {
  await importFiles(app, page, [
    { name: 'Scripts/stamp.ts', data: "export const meta = { name: 'Stamp the log', writes: ['Log/'] };\nexport default async ({ open }) => { (await open('Log/Log.md', { create: true })).append('- stamped'); };" },
    { name: 'Desk.md', data: 'Buttons:\n\n![[@run:Scripts/stamp.ts]]\n\nEnd.\n' },
  ]);
  await openFile(app, page, 'Desk.md');
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('Stamp the log');
  await app.focus();
  await app.press('ControlOrMeta+Home');
  await app.press('ArrowDown');
  const card = page.getByRole('dialog', { name: 'Live Block' });
  await card.getByRole('button', { name: 'Run', exact: true }).click();
  await allow(page);
  await expect.poll(() => status(page), { timeout: 20_000 }).toBe('Stamp the log ran. Documents changed: 1');
  await openFile(app, page, 'Log/Log.md');
  await expect.poll(() => app.text(), { timeout: 20_000 }).toContain('stamped');
});
