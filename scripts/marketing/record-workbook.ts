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

/** The wheel per frame, about: a notch zooms by about 5%, so each way takes a second and a half. The clip's own is a little less, so a whole number of notches lands just on the sheet's width. */
const STEP = 10;
/** How much a wheel unit zooms, as a log, before it is measured: a notch of STEP is about 5%. */
const RATE = 0.005;
/** CSS pixels per point at 100% (view/camera.ts). */
const PER_POINT = 96 / 72;

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
  // How far out the clip zooms: until the sheet's whole width (the orders, the summary and charts, the heat map) just fills
  // the scrolling pane, its last column at the canvas's right edge. A wheel notch of `dy` zooms by exp(-dy * rate), with the
  // rate measured on the way (the browser scales the wheel), so `notches` notches of `dy` land on it exactly, and the same
  // back come home exactly.
  type Measure = { right: number; width: number; middle: number; zoom: number };
  const measure = (): Promise<Measure> =>
    page.evaluate(`(() => {
      const sheet = window.sheetEditor, camera = window.camera;
      const canvas = camera.width / camera.dpr;
      const origin = sheet.screenOf(0, 0).x;
      const left = sheet.screenOf(camera.x, 0).x;
      const edge = sheet.columnEdge(sheet.state().info.cols - 1).x;
      return { right: (edge - origin) / (camera.zoom * ${PER_POINT}), width: canvas - left, middle: canvas / 2, zoom: camera.zoom };
    })()`);
  const plan = (m: Measure, from: number, rate: number) => {
    const target = m.width / (m.right * PER_POINT);
    const notches = Math.ceil(Math.log(from / target) / (rate * STEP));
    return { target, notches, dy: Math.log(from / target) / (rate * notches) };
  };
  // The sheet zooms about the middle of the canvas, kept at its top, so it reads as a zoom into one place: the point under
  // the middle is the one that, fully zoomed out, puts the sheet's top-left corner at the canvas's (where the app's own
  // clamp would leave it), so the clip starts scrolled that far to the right. The camera's x is worked out from the zoom and
  // the app's own writes to it (its clamp, zooming at the pointer, which drifts a little) are ignored, so it comes back to
  // just where it was and the clip loops.
  const setAnchor = (m: Measure, target: number) => page.evaluate(`window.clipAnchor = ${m.middle / (target * PER_POINT)}`);
  const first = await measure();
  let zoom = plan(first, first.zoom, RATE);
  await setAnchor(first, zoom.target);
  // (A string, as tsx would name the functions in a function passed here with a helper the page lacks.)
  await page.evaluate(`{
    const camera = window.camera;
    const middle = ${first.middle};
    Object.defineProperty(camera, 'x', { get() { return Math.max(0, window.clipAnchor - middle / (this.zoom * ${PER_POINT})); }, set() {}, configurable: true });
    Object.defineProperty(camera, 'y', { get() { return 0; }, set() {}, configurable: true });
  }`);
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
  await page.waitForTimeout(2000);

  // A first time round unseen, so the overview and the cells' tiles are built before the frames are taken. Zoomed out, the
  // row numbers are narrower or wider than at the start, so the pane and the wheel's rate are measured there and the zoom
  // planned again from them.
  const clip = frames(page);
  const wheel = async (dy: number, notches: number) => {
    await page.keyboard.down('Control');
    for (let i = 0; i < notches; i++) {
      await page.mouse.wheel(0, dy);
      await page.waitForTimeout(120);
    }
    await page.keyboard.up('Control');
    await page.waitForTimeout(3000);
  };
  await wheel(zoom.dy, zoom.notches);
  const out = await measure();
  await wheel(-zoom.dy, zoom.notches);
  zoom = plan(out, first.zoom, Math.log(first.zoom / out.zoom) / (zoom.dy * zoom.notches));
  await setAnchor(first, zoom.target);
  await wheel(zoom.dy, zoom.notches);
  const fit = await measure();
  console.log(`Zooms out to ${(fit.zoom * 100).toFixed(2)}% (the sheet's width fits at ${(zoom.target * 100).toFixed(2)}%) in ${zoom.notches} notches.`);
  await wheel(-zoom.dy, zoom.notches);

  // Out and back by the same notches, so the clip ends where it started and loops without a jump.
  clip.hold(await clip.shot(), 1.5);
  await clip.sweep(zoom.dy, (_, n) => n >= zoom.notches);
  clip.hold(await clip.shot(), 2);
  await clip.sweep(-zoom.dy, (_, n) => n >= zoom.notches);
  clip.hold(await clip.shot(), 1);
  return clip.count;
});
