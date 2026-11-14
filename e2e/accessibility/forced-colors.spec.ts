// Windows' contrast themes (forced-colors) reach what is drawn on canvases too (docs/architecture/accessibility.md): the
// page thumbnails and the plain text view are drawn in the system's colours, and turn back when the theme goes.

import { expect, test, type App } from '../fixtures';
import { importFile } from '../files/helpers';
import { pngPixels } from '../layout/helpers';

/** A dark contrast theme: under it, Chromium's Canvas colour is black. */
const DARK_FORCED = { forcedColors: 'active', colorScheme: 'dark' } as const;

/** Most of the picture is dark (an average under 128). */
function mostlyDark(data: Uint8Array | Uint8ClampedArray): boolean {
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) if ((data[i] + data[i + 1] + data[i + 2]) / 3 < 128) dark++;
  return dark > data.length / 8;
}

const thumbDark = (app: App) =>
  app.page.locator('.wm-pages-item canvas').first().evaluate((c: HTMLCanvasElement) => {
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if ((data[i] + data[i + 1] + data[i + 2]) / 3 < 128) dark++;
    return dark > data.length / 8;
  });

test.describe('Forced colours', () => {
  test.describe('Page Sidebar', () => {
    test.use({ sidebarDefault: true });

    test('the thumbnails are drawn in the contrast theme’s colours, and again when it goes', async ({ app }) => {
      await app.page.emulateMedia(DARK_FORCED);
      await app.goto('?doc=welcome');
      await expect(app.page.locator('.wm-pages')).toBeVisible();
      await expect.poll(() => thumbDark(app)).toBe(true);
      await app.page.emulateMedia({ forcedColors: 'none', colorScheme: 'light' });
      await expect.poll(() => thumbDark(app)).toBe(false);
    });
  });

  test('a plain text file is drawn in the contrast theme’s colours', async ({ app }) => {
    await app.page.emulateMedia({ forcedColors: 'none', colorScheme: 'light' });
    await app.blank();
    await importFile(app, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('first line\nsecond line\n') });
    await expect.poll(() => app.inTextEditor()).toBe(true);
    const shot = async () => pngPixels(await app.canvas.screenshot()).data;
    expect(mostlyDark(await shot())).toBe(false);
    await app.page.emulateMedia(DARK_FORCED);
    await expect.poll(async () => mostlyDark(await shot())).toBe(true);
  });
});
