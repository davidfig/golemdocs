// A picture in a room is edited by one session at a time (another person, or another device of the same account): whoever opened it
// first holds it and edits it with every tool, the picture itself too (rotate, crop...); the others watch it, read-only, and see it
// again each time it is saved; and a watcher can take it over.

import { test, expect, App } from '../fixtures';
import { currentPicture, makePng, openPicture, pictureToScreen } from '../layout/helpers';
import { newPerson, secondDevice } from './helpers';

const W = 400;
const H = 300;
const CANVAS = () => makePng(W, H, () => [255, 255, 255, 255]);

const shapesOf = (app: App) => app.page.evaluate(() => (window as unknown as { pictureShapes: { tool: string }[] }).pictureShapes.filter((s) => s.tool !== 'group').map((s) => s.tool).sort());
const banner = (app: App) => app.page.locator('.wm-watch');
const status = (app: App) => app.page.evaluate(() => (window as unknown as { status: string }).status);

async function drag(app: App, from: [number, number], to: [number, number], width = W): Promise<void> {
  const a = await pictureToScreen(app.page, width, ...from);
  const b = await pictureToScreen(app.page, width, ...to);
  await app.page.mouse.move(a.x, a.y);
  await app.page.mouse.down();
  await app.page.mouse.move(b.x, b.y, { steps: 6 });
  await app.page.mouse.up();
}

/** Two devices on one picture of the account: `a` opened it (and holds it), `b` joined (and watches). */
async function picturePair(browser: import('@playwright/test').Browser) {
  const person = await newPerson(browser, 'picture');
  await person.page.goto('/?doc=welcome');
  await openPicture(person.app, CANVAS());
  const { context, a, b } = await secondDevice(browser, person);
  await expect(b.page.getByRole('combobox', { name: 'Document format' })).toHaveValue(/PNG/);
  await expect(banner(b)).toBeVisible();
  return { context, a, b };
}

test('what the holder draws over the picture reaches the watcher when it is saved, and the watcher cannot draw', async ({ browser }) => {
  const { context, a, b } = await picturePair(browser);
  await a.toolbarButton(/^Line$/).click();
  await drag(a, [40, 40], [240, 40]);
  await expect.poll(() => shapesOf(b), { timeout: 30_000 }).toEqual(['line']);
  await b.toolbarButton(/^Rectangle$/).click();
  await expect.poll(() => status(b)).toContain('Take over to make changes');
  expect(await shapesOf(b)).toEqual(['line']);
  await context.close();
});

test('the holder can change the picture itself while someone watches, and the watcher sees it after the save', async ({ browser }) => {
  const { context, a, b } = await picturePair(browser);
  await a.menu('Picture', 'Rotate Right');
  await expect.poll(async () => (await currentPicture(a)).width).toBe(H);
  await expect.poll(async () => (await currentPicture(b)).width, { timeout: 30_000 }).toBe(H);
  await context.close();
});

test('taking over: the watcher holds the picture and can draw, and the one who held it watches and sees it', async ({ browser }) => {
  const { context, a, b } = await picturePair(browser);
  await a.toolbarButton(/^Line$/).click();
  await drag(a, [40, 40], [240, 40]);
  await b.page.getByRole('button', { name: 'Take over', exact: true }).click();
  await expect(banner(b)).toBeHidden({ timeout: 30_000 });
  await expect(banner(a)).toBeVisible();
  // What the holder had was saved before it let go.
  await expect.poll(() => shapesOf(b), { timeout: 30_000 }).toEqual(['line']);
  await b.toolbarButton(/^Rectangle$/).click();
  await drag(b, [40, 150], [240, 250]);
  await expect.poll(() => shapesOf(a), { timeout: 30_000 }).toEqual(['line', 'rectangle']);
  await context.close();
});
