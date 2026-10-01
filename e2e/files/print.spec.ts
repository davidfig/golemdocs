// File ▸ Print and Print Preview: the document is exported as a PDF and printed from a hidden
// frame, or opened in a new tab. Both the browser's window.open and the frame's print() are
// stubbed, so the test sees what would be printed without a print dialog.

import type { Page } from '@playwright/test';
import { MOD, expect, test } from './fixtures';
import { blankWith, importFile, text } from './helpers';

declare global {
  interface Window {
    __opened: { url: string; target?: string }[];
    __printed: string[];
    __openResult: 'window' | 'blocked';
  }
}

async function stubPrinting(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__opened = [];
    window.__printed = [];
    window.__openResult = 'window';
    window.open = ((url?: string | URL, target?: string) => {
      window.__opened.push({ url: String(url), target });
      return window.__openResult === 'window' ? ({} as Window) : null;
    }) as typeof window.open;
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      get(this: HTMLIFrameElement) {
        return { focus() {}, print: () => window.__printed.push(this.src) };
      },
    });
  });
}

/** The bytes behind a blob: URL the app made. */
async function blobBytes(page: Page, url: string): Promise<Buffer> {
  const base64 = await page.evaluate(async (u) => {
    const bytes = new Uint8Array(await (await fetch(u)).arrayBuffer());
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }, url);
  return Buffer.from(base64, 'base64');
}

/**
 * The app prints from a hidden frame holding the PDF, once the frame has loaded. Headless Chromium
 * may have no PDF viewer, so the frame never reports loading: wait for the frame, then report it ourselves.
 * Resolves with the frame's blob: URL, after print() was called on it.
 */
async function finishLoading(page: Page): Promise<string> {
  const frame = page.locator('iframe[src^="blob:"]');
  await frame.waitFor({ state: 'attached' });
  await frame.dispatchEvent('load');
  // Where the browser does have a PDF viewer the frame also loads for real, so print() may run twice.
  await expect.poll(() => page.evaluate(() => window.__printed.length)).toBeGreaterThanOrEqual(1);
  return (await page.evaluate(() => window.__printed))[0]!;
}

test('Print sends the document, as a PDF, to the frame that prints it', async ({ app, page }) => {
  await stubPrinting(page);
  await blankWith(app, 'Print this page');
  await app.menu('File', 'Print…');
  const url = await finishLoading(page);
  expect(url).toMatch(/^blob:/);
  const pdf = await blobBytes(page, url);
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.subarray(-16).toString()).toContain('%%EOF');
});

test('Ctrl+P prints too', async ({ app, page }) => {
  await stubPrinting(page);
  await blankWith(app, 'Shortcut print');
  await page.keyboard.press(`${MOD}+p`);
  await finishLoading(page);
});

test('Print Preview opens the PDF in a new tab', async ({ app, page }) => {
  await stubPrinting(page);
  await blankWith(app, 'Preview this page');
  await app.menu('File', 'Print Preview');
  await expect.poll(() => page.evaluate(() => window.__opened.length)).toBe(1);
  const [opened] = await page.evaluate(() => window.__opened);
  expect(opened!.target).toBe('_blank');
  expect(opened!.url).toMatch(/^blob:/);
  expect((await blobBytes(page, opened!.url)).subarray(0, 5).toString()).toBe('%PDF-');
  // Nothing was printed.
  expect(await page.evaluate(() => window.__printed.length)).toBe(0);
});

test('Print Preview says to allow pop-ups when the browser blocks the new tab', async ({ app, page }) => {
  await stubPrinting(page);
  await blankWith(app, 'Blocked');
  await page.evaluate(() => (window.__openResult = 'blocked'));
  await app.menu('File', 'Print Preview');
  await expect(page.getByRole('alert')).toHaveText('Allow pop-ups to see the print preview');
});

test('a Markdown document prints as a PDF as well', async ({ app, page }) => {
  await stubPrinting(page);
  await app.goto('?doc=welcome');
  await importFile(app, text('print.md', '# Title\n\nSome body text.'));
  await app.menu('File', 'Print Preview');
  await expect.poll(() => page.evaluate(() => window.__opened.length)).toBe(1);
  const [opened] = await page.evaluate(() => window.__opened);
  expect((await blobBytes(page, opened!.url)).subarray(0, 5).toString()).toBe('%PDF-');
});
