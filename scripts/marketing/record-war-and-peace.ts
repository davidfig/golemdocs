// pnpm record:home: re-records the clip on the home page's performance section: War and Peace in Page Grid,
// zooming from the whole book down to readable text and back. There are two, one in the app's light theme
// (client/public/home/war-and-peace.webm) and one in its dark theme with dark pages (war-and-peace-dark.webm),
// which the site plays in its own dark theme. Both are recorded each time, so they always match.
//
// Run it again whenever the app's look changes. It needs the dev server on :5173 (`pnpm dev`, started
// by you), and drives the real app in Chromium, so it uses the GPU through Metal on a Mac.
//
//   pnpm record:home                       writes both clips
//   pnpm record:home --theme dark          writes only the dark one (or --theme light)
//   pnpm record:home --url http://localhost:5174 --theme light --out /tmp/clip.webm
//
// See clip.ts for how a clip is recorded and encoded.

import { Frames, hideAdminMenu, openApp, recordClips } from './clip.ts';

/** The zoom the clip ends its zoom-in at (1 = 100%) and the one it zooms back out to. */
const ZOOM_IN = 1.3;
const ZOOM_OUT = 0.03;
/** Where the zoom is anchored, a point on a page of text. */
const ANCHOR = { x: 652, y: 395 };

await recordClips('war-and-peace', async (frames, browser, theme) => {
  const page = await openApp(browser, '?doc=war-and-peace', theme);
  await page.waitForTimeout(1500);
  await page.getByRole('menubar').getByText('View', { exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^Page Grid/ }).click();
  await hideAdminMenu(page);
  await page.mouse.move(ANCHOR.x, ANCHOR.y);
  await page.waitForTimeout(2500);

  const clip: Frames = frames(page);
  clip.hold(await clip.shot(), 1.5);
  await clip.sweep(-25, (z) => z >= ZOOM_IN);
  clip.hold(await clip.shot(), 2);
  await clip.sweep(25, (z) => z <= ZOOM_OUT);
  clip.hold(await clip.shot(), 1);
  return clip.count;
});
