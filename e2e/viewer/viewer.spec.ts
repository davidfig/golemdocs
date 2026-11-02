// The embeddable viewer's page (viewer.html, docs/architecture/viewer.md), framed by a host page that sends it files as a host app
// would: it opens them read-only, moves between pages, zooms, finds, selects and copies, hands clicked links to the host, and
// fetches nothing but its own code and fonts. (The sandboxed, built viewer is in sandbox.spec.ts.)

import { expect, test } from '@playwright/test';
import { CLIENT_ORIGIN } from '../ports';
import { docxFile, emlFile, epubFile, hostPage, htmlFile, markdownFile, mhtmlFile, ViewerHost } from './helpers';

const MOD = 'ControlOrMeta';

async function host(page: import('@playwright/test').Page): Promise<ViewerHost> {
  await page.route(`${CLIENT_ORIGIN}/viewer-host.html`, (route) => route.fulfill({ contentType: 'text/html', body: hostPage('/viewer.html') }));
  const viewer = new ViewerHost(page);
  await page.goto('/viewer-host.html');
  return viewer;
}

/** Where a point of the first page is, in the host page's CSS px (the first page is placed at 100%, 24 px below the bar). */
async function onFirstPage(viewer: ViewerHost, xPt: number, yPt: number): Promise<{ x: number; y: number }> {
  const box = (await viewer.frame.locator('canvas').boundingBox())!;
  const scale = 96 / 72;
  const pageLeft = box.x + (box.width - 612 * scale) / 2;
  return { x: pageLeft + xPt * scale, y: box.y + 24 + yPt * scale };
}

test('opens a Word document, and moves between its pages with the buttons, the page box and the keys', async ({ page }) => {
  const viewer = await host(page);
  const opened = await viewer.open('Report.docx', await docxFile(3));
  expect(opened).toMatchObject({ type: 'golemdocs:opened', name: 'Report.docx', format: 'docx', pages: 3 });
  const field = viewer.frame.getByRole('textbox', { name: 'Page number' });
  await expect(field).toHaveValue('1');
  await expect(viewer.frame.getByText('of 3')).toBeVisible();
  await viewer.frame.getByRole('button', { name: 'Next Page' }).click();
  await expect(field).toHaveValue('2');
  await viewer.frame.locator('canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('End');
  await expect(field).toHaveValue('3');
  await page.keyboard.press('Home');
  await expect(field).toHaveValue('1');
  await field.fill('3');
  await field.press('Enter');
  await expect(field).toHaveValue('3');
  await viewer.frame.getByRole('button', { name: 'Previous Page' }).click();
  await expect(field).toHaveValue('2');
});

test('zooms with Ctrl/⌘ + and −, the buttons, and back to 100%', async ({ page }) => {
  const viewer = await host(page);
  await viewer.open('Notes.md', markdownFile());
  const zoom = viewer.frame.locator('.wm-viewer-zoom');
  await expect(zoom).toHaveAttribute('title', 'Actual Size');
  await expect(zoom).toHaveText('100%');
  await viewer.frame.locator('canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press(`${MOD}+=`);
  await expect(zoom).toHaveText('110%');
  await page.keyboard.press(`${MOD}+=`);
  await expect(zoom).toHaveText('125%');
  await page.keyboard.press(`${MOD}+-`);
  await expect(zoom).toHaveText('110%');
  await viewer.frame.getByRole('button', { name: 'Zoom Out' }).click();
  await viewer.frame.getByRole('button', { name: 'Zoom Out' }).click();
  await expect(zoom).toHaveText('90%');
  await viewer.frame.getByRole('button', { name: 'Zoom In' }).click();
  await expect(zoom).toHaveText('100%');
  await page.keyboard.press(`${MOD}+=`);
  await page.keyboard.press(`${MOD}+0`);
  await expect(zoom).toHaveText('100%');
});

test('finds text, and says when there is none', async ({ page }) => {
  const viewer = await host(page);
  await viewer.open('Notes.md', markdownFile());
  await viewer.frame.locator('canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press(`${MOD}+f`);
  const query = viewer.frame.getByRole('searchbox', { name: 'Find what' });
  await expect(query).toBeFocused();
  await query.fill('lazy');
  await query.press('Enter');
  const message = viewer.frame.locator('.wm-viewer-find .wm-find-message');
  await page.waitForTimeout(300);
  await expect(message).toHaveText('');
  await query.fill('zebra');
  await query.press('Enter');
  await expect(message).toHaveText('No matches');
  await query.press('Escape');
  await expect(query).toBeHidden();
});

test('selects and copies text, and typing changes nothing', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const viewer = await host(page);
  await viewer.open('Notes.md', markdownFile());
  await viewer.frame.locator('canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.type('typed here');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await page.keyboard.press(`${MOD}+a`);
  await page.waitForTimeout(300);
  await page.keyboard.press(`${MOD}+c`);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Notes\nThe quick brown fox jumps over the lazy dog.\nSecond paragraph with a link.');
  // A drag over the first line selects just it.
  const from = await onFirstPage(viewer, 72, 82);
  const to = await onFirstPage(viewer, 300, 82);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.keyboard.press(`${MOD}+c`);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Notes');
});

test('a click on a link is handed to the host, not followed', async ({ page }) => {
  const viewer = await host(page);
  await viewer.open('Links.md', new TextEncoder().encode('[Open the example site](https://example.com/clicked)\n'));
  const before = (await viewer.messages()).length;
  const at = await onFirstPage(viewer, 90, 80);
  await page.mouse.click(at.x, at.y);
  const link = await viewer.waitFor('golemdocs:link', before);
  expect(link.url).toBe('https://example.com/clicked');
  expect(page.url()).toContain('/viewer-host.html');
  expect(viewer.elsewhere(CLIENT_ORIGIN)).toEqual([]);
});

test('web pages, emails, saved pages and e-books with remote pictures fetch nothing from elsewhere', async ({ page }) => {
  const viewer = await host(page);
  for (const [name, bytes] of [
    ['page.html', htmlFile()],
    ['message.eml', emlFile()],
    ['saved.mhtml', mhtmlFile()],
    ['book.epub', await epubFile()],
  ] as const) {
    const opened = await viewer.open(name, bytes);
    expect(opened, name).toMatchObject({ type: 'golemdocs:opened' });
    expect(opened.pages as number, name).toBeGreaterThan(0);
  }
  await page.waitForTimeout(1000);
  expect(viewer.elsewhere(CLIENT_ORIGIN)).toEqual([]);
  // Of the site, only its code and the fonts: no dictionaries, no API.
  const own = viewer.requests.filter((url) => url.startsWith(CLIENT_ORIGIN));
  expect(own.filter((url) => /\/(api|dictionaries|ui-fonts)\//.test(url))).toEqual([]);
  expect(own.some((url) => url.includes('/fonts/manifest.json'))).toBe(true);
});

test('a file it can\'t open is reported to the host', async ({ page }) => {
  const viewer = await host(page);
  const result = await viewer.open('archive.xyz', new Uint8Array([1, 2, 3]));
  expect(result).toMatchObject({ type: 'golemdocs:error' });
  await expect(viewer.frame.getByRole('status').first()).toContainText('archive.xyz');
});

test('opens the other kinds of file too: PDF, Word 97, Rich Text, CSV, SVG, PNG and plain text', async ({ page }) => {
  const { readFileSync } = await import('node:fs');
  const fixture = (path: string) => new Uint8Array(readFileSync(new URL(`../../${path}`, import.meta.url)));
  const viewer = await host(page);
  const text = (s: string) => new TextEncoder().encode(s);
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  for (const [name, bytes, format] of [
    ['paper.pdf', fixture('pdf/test/fixtures/libreoffice.pdf'), 'pdf'],
    ['old.doc', fixture('client/test/fixtures/word97.doc'), 'docx'],
    ['letter.rtf', text('{\\rtf1\\ansi{\\fonttbl\\f0 Times New Roman;}\\f0 Dear reader,\\par Rich text.}'), 'rtf'],
    ['table.csv', text('name,count\napples,3\npears,5\n'), 'csv'],
    ['drawing.svg', text('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#4cc38a"/><image href="https://remote.example/x.png" width="10" height="10"/></svg>'), 'svg'],
    ['dot.png', png, 'png'],
    ['readme.txt', text('Plain text\nsecond line\n'), 'txt'],
  ] as const) {
    const opened = await viewer.open(name, bytes);
    expect(opened, name).toMatchObject({ type: 'golemdocs:opened', format });
  }
  // A PDF's own pages can't be searched yet: the find bar says so.
  await viewer.open('paper.pdf', fixture('pdf/test/fixtures/libreoffice.pdf'));
  await viewer.frame.locator('canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press(`${MOD}+f`);
  await expect(viewer.frame.locator('.wm-viewer-find .wm-find-message')).toHaveText("Find isn't available in a PDF's own pages yet.");
  expect(viewer.elsewhere(CLIENT_ORIGIN)).toEqual([]);
});
