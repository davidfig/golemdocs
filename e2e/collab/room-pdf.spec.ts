// A PDF in a room is edited by one session at a time (another person, or another device of the same account): whoever opened it first
// holds it and edits it with every tool, page operations too; the others watch it, read-only, and see it again each time it is saved;
// and a watcher can take it over.

import { test, expect, App } from '../fixtures';
import { annotations, editMode, makePdf, openPdf, pageCount, selectBetween, showPage } from '../pdf/helpers';
import { newPerson, secondDevice } from './helpers';

const sample = () =>
  makePdf({
    pages: [
      [
        { text: 'Hello PDF world', x: 40, y: 240, size: 18 },
        { text: 'Second line of text', x: 40, y: 200, size: 18 },
      ],
      [{ text: 'Bravo page', x: 40, y: 240, size: 18 }],
    ],
  });

const FIRST: [[number, number], [number, number]] = [[41, 54], [120, 54]];
const SECOND: [[number, number], [number, number]] = [[41, 94], [120, 94]];

const btn = (app: App, name: string) => app.page.getByRole('button', { name, exact: true });
const banner = (app: App) => app.page.locator('.wm-watch');
const status = (app: App) => app.page.evaluate(() => (window as unknown as { status: string }).status);
const save = async (app: App) => (await app.download(() => app.menu('File', 'Download'))).bytes;
/** Waits until the PDF the person has now holds `count` annotations of a kind. */
const expectAnnotations = (app: App, subtype: string, count: number) => expect.poll(async () => annotations(await save(app), subtype).length, { timeout: 30_000 }).toBe(count);

/** Two devices in one PDF of the account: `a` opened it (and holds it), `b` joined (and watches). */
async function pdfPair(browser: import('@playwright/test').Browser) {
  const person = await newPerson(browser, 'pdf');
  await person.page.goto('/?doc=welcome');
  await openPdf(person.app, sample());
  const { context, a, b } = await secondDevice(browser, person);
  await showPage(a.page, 0);
  await showPage(b.page, 0);
  return { context, a, b };
}

test('the one who joins opens the same PDF, as a PDF, and watches: told it is being edited on another device, with Take over', async ({ browser }) => {
  const { context, a, b } = await pdfPair(browser);
  await expect(b.page.getByRole('combobox', { name: 'Document format' })).toHaveValue(/PDF/);
  await expect(banner(b)).toBeVisible();
  await expect(banner(b)).toContainText('editing this on another device');
  await expect(btn(b, 'Take over')).toBeVisible();
  await expect(banner(a)).toBeHidden();
  await context.close();
});

test('what the holder marks up reaches the watcher when it is saved, and the watcher cannot change it', async ({ browser }) => {
  const { context, a, b } = await pdfPair(browser);
  await selectBetween(a.page, 0, ...FIRST);
  await btn(a, 'Highlight').click();
  await expectAnnotations(b, 'Highlight', 1);
  await selectBetween(b.page, 0, ...SECOND);
  await btn(b, 'Underline').click();
  await expect.poll(() => status(b)).toContain('Take over to make changes');
  await expectAnnotations(b, 'Underline', 0);
  await expectAnnotations(a, 'Underline', 0);
  await context.close();
});

test('the holder can move and delete pages while someone watches, and the watcher sees it after the save', async ({ browser }) => {
  const { context, a, b } = await pdfPair(browser);
  await editMode(a.page);
  await showPage(a.page, 1);
  await a.page.locator('.wm-pdftools-pages button[data-op="delete"]').click();
  await expect.poll(() => pageCount(a.page)).toBe(1);
  await expect.poll(() => pageCount(b.page), { timeout: 30_000 }).toBe(1);
  await context.close();
});

test('taking over: the watcher holds the PDF and can mark it up, and the one who held it watches and sees it', async ({ browser }) => {
  const { context, a, b } = await pdfPair(browser);
  await selectBetween(a.page, 0, ...FIRST);
  await btn(a, 'Highlight').click();
  await btn(b, 'Take over').click();
  await expect(banner(b)).toBeHidden({ timeout: 30_000 });
  await expect(banner(a)).toBeVisible();
  // What the holder had was saved before it let go.
  await expectAnnotations(b, 'Highlight', 1);
  await showPage(b.page, 0);
  await selectBetween(b.page, 0, ...SECOND);
  await btn(b, 'Underline').click();
  await expectAnnotations(a, 'Underline', 1);
  await expectAnnotations(a, 'Highlight', 1);
  await context.close();
});
