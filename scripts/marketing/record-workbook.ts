// pnpm record:workbook: re-records the clip in the home page's spreadsheet section: a workbook of a million orders
// (make-workbook.ts) opened in the app, zooming out from its cells until the whole width of the sheet shows, with its
// summary, charts and heat map, and back in. There are two, one in the app's light theme (client/public/home/workbook.webm)
// and one in its dark theme with dark pages (workbook-dark.webm), which the site plays in its own dark theme. Both are
// recorded each time, so they always match.
//
// Run it again whenever the app's look changes. It needs the dev server on :5173 (`pnpm dev`, started by you), and drives
// the real app in Chromium, so it uses the GPU through Metal on a Mac. The workbook (about 80 MB) is made the first time
// into .cache/marketing/orders.xlsx and kept there; delete it to make it again.
//
//   pnpm record:workbook                       writes both clips
//   pnpm record:workbook --theme dark          writes only the dark one (or --theme light)
//   pnpm record:workbook --url http://localhost:5174 --theme light --out /tmp/clip.webm
//
// See clip.ts for how a clip is recorded and encoded.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { VIEWPORT, hideAdminMenu, openApp, recordClips } from './clip.ts';
import { DEFAULT_WORKBOOK, makeWorkbook } from './make-workbook.ts';

/** How far out the clip zooms: the sheet's whole width (the orders, the summary and charts, the heat map) fills the frame. */
const ZOOM_OUT = 0.097;
/** The wheel per frame: a notch zooms by about 5%, so each way takes a second and a half. */
const STEP = 10;

if (!existsSync(DEFAULT_WORKBOOK)) {
  console.log(`Making ${path.basename(DEFAULT_WORKBOOK)}…`);
  await makeWorkbook(DEFAULT_WORKBOOK, 1_000_000);
}

await recordClips('workbook', async (frames, browser, theme) => {
  const page = await openApp(browser, '?doc=none', theme);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    (async () => {
      await page.getByRole('menubar').getByText('File', { exact: true }).click();
      await page.getByRole('menuitem', { name: 'Import…', exact: true }).click();
    })(),
  ]);
  await chooser.setFiles(DEFAULT_WORKBOOK);
  await page.waitForFunction(() => (window as unknown as { sheetEditor: { state(): { loaded: boolean } | null } }).sheetEditor.state()?.loaded === true, null, { timeout: 180_000 });
  await hideAdminMenu(page);
  type Editor = { sheetEditor: { pointOf(r: number, c: number): { x: number; y: number } | null } };
  const box = (await page.locator('#canvas').boundingBox())!;
  const point = async (row: number, col: number) => {
    const at = await page.evaluate(([r, c]) => (window as unknown as Editor).sheetEditor.pointOf(r, c), [row, col] as const);
    if (!at) throw new Error(`cell ${row}, ${col} is not on screen`);
    return { x: box.x + at.x, y: box.y + at.y };
  };
  // The revenue of the first order is picked, so the formula bar shows its formula.
  const j2 = await point(1, 9);
  await page.mouse.click(j2.x, j2.y);
  // The sheet stays scrolled to its top left while it zooms, so it grows out of its corner and comes back to just where it
  // was (zooming at the pointer drifts a little, and the clip must end as it starts to loop).
  // (A string, as tsx would name the functions in a function passed here with a helper the page lacks.)
  await page.evaluate(`for (const key of ['x', 'y']) Object.defineProperty(window.camera, key, { get() { return 0; }, set() {}, configurable: true })`);
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
  await page.waitForTimeout(2000);

  // A first time round unseen, so the overview and the cells' tiles are built before the frames are taken.
  const clip = frames(page);
  await page.keyboard.down('Control');
  let notches = 0;
  for (; notches < 300 && (await clip.zoom()) > ZOOM_OUT; notches++) {
    await page.mouse.wheel(0, STEP);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(3000);
  for (let i = 0; i < notches; i++) {
    await page.mouse.wheel(0, -STEP);
    await page.waitForTimeout(120);
  }
  await page.keyboard.up('Control');
  await page.waitForTimeout(3000);

  // Out and back by the same number of notches, so the clip ends where it started and loops without a jump.
  clip.hold(await clip.shot(), 1.5);
  const out = await clip.sweep(STEP, (zoom) => zoom <= ZOOM_OUT);
  clip.hold(await clip.shot(), 2);
  await clip.sweep(-STEP, (_, n) => n >= out);
  clip.hold(await clip.shot(), 1);
  return clip.count;
});
