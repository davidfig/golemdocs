// A PDF in a room: each person's annotations reach the other, undo undoes only one's own, and page operations (which make a new file)
// are not shared yet.

import { test, expect, App } from '../fixtures';
import { annotations, editMode, makePdf, openPdf, pageCount, selectBetween, showPage } from '../pdf/helpers';
import { getRoomLink } from './helpers';

const sample = () =>
  makePdf({
    pages: [
      [
        { text: 'Hello PDF world', x: 40, y: 240, size: 18 },
        { text: 'Second line of text', x: 40, y: 200, size: 18 },
      ],
    ],
  });

const FIRST: [[number, number], [number, number]] = [[41, 54], [120, 54]];
const SECOND: [[number, number], [number, number]] = [[41, 94], [120, 94]];

const btn = (app: App, name: string) => app.page.getByRole('button', { name, exact: true });
const save = async (app: App) => (await app.download(() => app.menu('File', 'Download'))).bytes;
/** Waits until the PDF the person has now holds `count` annotations of a kind. */
const expectAnnotations = (app: App, subtype: string, count: number) => expect.poll(async () => annotations(await save(app), subtype).length, { timeout: 30_000 }).toBe(count);

/** Two people in one PDF: `a` opened it and shared it, `b` joined. */
async function pdfPair(browser: import('@playwright/test').Browser) {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const a = new App(await context.newPage());
  await openPdf(a, sample());
  const url = await getRoomLink(a);
  await showPage(a.page, 0);
  const b = new App(await context.newPage());
  await b.page.goto(url);
  await b.ready();
  await showPage(b.page, 0);
  return { context, a, b };
}

test('a PDF can be shared: the one who joins opens the same PDF, as a PDF', async ({ browser }) => {
  const { context, b } = await pdfPair(browser);
  await expect(b.page.getByRole('combobox', { name: 'Document format' })).toHaveValue(/PDF/);
  await expect(btn(b, 'Highlight')).toBeVisible();
  await context.close();
});

test('markup made by either person reaches the other, and the PDF each has is the same', async ({ browser }) => {
  const { context, a, b } = await pdfPair(browser);
  await selectBetween(a.page, 0, ...FIRST);
  await btn(a, 'Highlight').click();
  await expectAnnotations(a, 'Highlight', 1);
  await expectAnnotations(b, 'Highlight', 1);
  await selectBetween(b.page, 0, ...SECOND);
  await btn(b, 'Underline').click();
  await expectAnnotations(b, 'Underline', 1);
  await expectAnnotations(a, 'Underline', 1);
  await expectAnnotations(a, 'Highlight', 1);
  await context.close();
});

test('undo takes back only what the person did themselves', async ({ browser }) => {
  const { context, a, b } = await pdfPair(browser);
  await selectBetween(a.page, 0, ...FIRST);
  await btn(a, 'Highlight').click();
  await expectAnnotations(b, 'Highlight', 1);
  await selectBetween(b.page, 0, ...SECOND);
  await btn(b, 'Underline').click();
  await expectAnnotations(a, 'Underline', 1);
  // b undoes: its own underline goes, a's highlight stays.
  await b.menu('Edit', 'Undo');
  await expectAnnotations(b, 'Underline', 0);
  await expectAnnotations(a, 'Underline', 0);
  await expectAnnotations(a, 'Highlight', 1);
  await expectAnnotations(b, 'Highlight', 1);
  // And redo puts it back, for both.
  await b.menu('Edit', 'Redo');
  await expectAnnotations(a, 'Underline', 1);
  await context.close();
});

test('pages cannot be moved while others are here, and the person is told', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const a = new App(await context.newPage());
  await openPdf(a, makePdf({ pages: [[{ text: 'Alpha page', x: 40, y: 240, size: 18 }], [{ text: 'Bravo page', x: 40, y: 240, size: 18 }]] }));
  const url = await getRoomLink(a);
  const b = new App(await context.newPage());
  await b.page.goto(url);
  await b.ready();
  await editMode(a.page);
  await showPage(a.page, 1);
  await a.page.locator('.wm-pdftools-pages button[data-op="delete"]').click();
  await expect.poll(() => a.page.evaluate(() => (window as unknown as { status: string }).status)).toContain('Pages can’t be moved, deleted or rotated while others are editing this PDF yet.');
  expect(await pageCount(a.page)).toBe(2);
  expect(await pageCount(b.page)).toBe(2);
  await context.close();
});
