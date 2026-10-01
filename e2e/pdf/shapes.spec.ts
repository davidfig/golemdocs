import { expect, test } from '../fixtures';
import { clickOnPage, decodePdf, dragOnPage, editMode, finalObjects, makePdf, openPdf, readBack, showPage, tinyPng, tool } from './helpers';

type App = import('../fixtures').App;

// Two text lines, and a red rectangle of the file's own at x 50..150, y 50..90 (PDF space, from the bottom).
const sample = () =>
  makePdf({
    pages: [
      [
        { text: 'Hello PDF world', x: 40, y: 240, size: 18 },
        { text: 'Second line of text', x: 40, y: 200, size: 18 },
      ],
    ],
    extraContent: 'q 1 0 0 rg 50 50 100 40 re f Q',
  });

const frame = (app: App) => app.page.locator('.wm-pdftools-frame');
const save = async (app: App) => (await app.download(() => app.menu('File', 'Download'))).bytes;
const content = async (app: App) => decodePdf(await save(app));

/** Every `x y w h re` of a content stream. */
const rects = (c: string): number[][] => [...c.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re\b/g)].map((m) => m.slice(1, 5).map(Number));
const closeTo = (a: number[], b: number[], tol = 1) => {
  expect(a).toHaveLength(b.length);
  a.forEach((n, i) => expect(Math.abs(n - b[i])).toBeLessThanOrEqual(tol));
};

/** Clicks the rectangle of the file until it is picked (the page's own objects are scanned a moment after it opens). */
async function pickFileRect(app: App): Promise<void> {
  await expect(async () => {
    await clickOnPage(app.page, 0, 100, 300 - 70);
    await expect(frame(app)).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 15_000 });
}

async function ready(app: App): Promise<void> {
  await openPdf(app, sample());
  await showPage(app.page, 0);
  await editMode(app.page);
}

test.describe('Edit PDF: shapes', () => {
  test.beforeEach(async ({ app }) => ready(app));

  test('dragging with the Rectangle tool draws a rectangle of that size and selects it', async ({ app }) => {
    await tool(app.page, 'rect').click();
    await expect(app.page.getByText('Drag on a page to draw it')).toBeVisible();
    await dragOnPage(app.page, 0, [200, 120], [300, 180]);
    await expect(frame(app)).toBeVisible();
    await expect(app.page.locator('.wm-forms-kind')).toHaveText('Shape');
    // 100 x 60 at (200, 120) from the top is (200, 120) from the bottom of a 300 pt page, and already the last rectangle drawn.
    const all = rects(await content(app));
    closeTo(all[all.length - 1], [200, 120, 100, 60]);
  });

  test('a click without a drag places a default-sized shape', async ({ app }) => {
    await tool(app.page, 'ellipse').click();
    await clickOnPage(app.page, 0, 200, 100);
    await expect(frame(app)).toBeVisible();
    const box = (await frame(app).boundingBox())!;
    const { width } = await app.page.evaluate(() => ({ width: (window as unknown as { camera: { zoom: number } }).camera.zoom }));
    // 120 x 70 points.
    expect(box.width / (width * (96 / 72))).toBeCloseTo(120, 0);
    expect(box.height / (width * (96 / 72))).toBeCloseTo(70, 0);
  });

  test('ellipse and line tools draw curves and a straight segment', async ({ app }) => {
    await tool(app.page, 'ellipse').click();
    await dragOnPage(app.page, 0, [200, 120], [260, 160]);
    await tool(app.page, 'line').click();
    await dragOnPage(app.page, 0, [200, 200], [300, 260]);
    const c = await content(app);
    expect(c).toMatch(/ c\n/);
    // The line goes down and to the right on screen, so its end is lower in PDF space than its start.
    const m = /([\d.]+) ([\d.]+) m\n([\d.]+) ([\d.]+) l/.exec(c)!;
    expect(Number(m[3])).toBeGreaterThan(Number(m[1]));
    expect(Number(m[4])).toBeLessThan(Number(m[2]));
  });

  test('outline color, fill and width can be changed on a selected shape', async ({ app }) => {
    await tool(app.page, 'rect').click();
    await dragOnPage(app.page, 0, [200, 120], [300, 180]);
    await app.page.locator('input[type=checkbox][aria-label="Fill"]').check();
    await app.page.locator('input[type=color][aria-label="Fill"]').fill('#00ff00');
    await app.page.locator('input[type=color][aria-label="Outline"]').fill('#0000ff');
    const width = app.page.getByRole('spinbutton', { name: 'Width' });
    await width.fill('4');
    await width.press('Enter');
    const c = await content(app);
    expect(c).toMatch(/\b0 1 0 rg\b/);
    expect(c).toMatch(/\b0 0 1 RG\b/);
    expect(c).toMatch(/\b4 w\b/);
  });

  test('turning the fill off leaves just the outline', async ({ app }) => {
    await tool(app.page, 'rect').click();
    await dragOnPage(app.page, 0, [200, 120], [300, 180]);
    await app.page.locator('input[type=checkbox][aria-label="Fill"]').check();
    await app.page.locator('input[type=color][aria-label="Fill"]').fill('#00ff00');
    await expect.poll(async () => await content(app)).toMatch(/\b0 1 0 rg\b/);
    await app.page.locator('input[type=checkbox][aria-label="Fill"]').uncheck();
    await expect.poll(async () => await content(app)).not.toMatch(/\b0 1 0 rg\b/);
  });

  test('dragging the frame moves a shape, and the corner handle resizes it', async ({ app }) => {
    await tool(app.page, 'rect').click();
    await dragOnPage(app.page, 0, [200, 120], [300, 180]);
    await expect(frame(app)).toBeVisible();
    const scale = (await app.page.evaluate(() => (window as unknown as { camera: { zoom: number } }).camera.zoom)) * (96 / 72);
    const box = (await frame(app).boundingBox())!;
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await app.page.mouse.move(c.x, c.y);
    await app.page.mouse.down();
    await app.page.mouse.move(c.x - 20 * scale, c.y + 30 * scale, { steps: 5 });
    await app.page.mouse.up();
    let all: number[][] = [];
    await expect.poll(async () => (all = rects(await content(app))).length).toBeGreaterThan(1);
    closeTo(all[all.length - 1], [180, 90, 100, 60], 1.5);
    // Resize from the bottom right corner: 40 wider, 20 taller.
    const se = (await frame(app).locator('[data-handle="se"]').boundingBox())!;
    await app.page.mouse.move(se.x + se.width / 2, se.y + se.height / 2);
    await app.page.mouse.down();
    await app.page.mouse.move(se.x + se.width / 2 + 40 * scale, se.y + se.height / 2 + 20 * scale, { steps: 5 });
    await app.page.mouse.up();
    await expect
      .poll(async () => {
        const r = rects(await content(app));
        return Math.round(r[r.length - 1][2]);
      })
      .toBe(140);
    const r = rects(await content(app));
    expect(Math.round(Math.abs(r[r.length - 1][3]))).toBe(80);
  });

  test('Delete removes the selected shape, and Undo brings it back', async ({ app }) => {
    await tool(app.page, 'rect').click();
    await dragOnPage(app.page, 0, [200, 120], [300, 180]);
    const before = rects(await content(app)).length;
    await app.page.keyboard.press('Delete');
    await expect(frame(app)).toBeHidden();
    await expect.poll(async () => rects(await content(app)).length).toBe(before - 1);
    await app.menu('Edit', 'Undo');
    await expect.poll(async () => rects(await content(app)).length).toBe(before);
  });

  test('the Delete button in the palette removes the selected shape', async ({ app }) => {
    await tool(app.page, 'rect').click();
    await dragOnPage(app.page, 0, [200, 120], [300, 180]);
    const before = rects(await content(app)).length;
    await app.page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(async () => rects(await content(app)).length).toBe(before - 1);
  });

  test('Escape during drawing cancels the tool, and Escape afterwards deselects', async ({ app }) => {
    await tool(app.page, 'rect').click();
    await app.page.keyboard.press('Escape');
    await expect(tool(app.page, 'rect')).not.toHaveClass(/wm-pdftools-on/);
    await tool(app.page, 'rect').click();
    await dragOnPage(app.page, 0, [200, 120], [300, 180]);
    await expect(frame(app)).toBeVisible();
    await app.page.keyboard.press('Escape');
    await expect(frame(app)).toBeHidden();
  });
});

test.describe('Edit PDF: objects already in the file', () => {
  test.beforeEach(async ({ app }) => ready(app));

  test('clicking a rectangle of the file selects it and offers to delete it', async ({ app }) => {
    await pickFileRect(app);
    await expect(app.page.locator('.wm-forms-kind')).toHaveText('Shape');
    await expect(app.page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  });

  // The frame follows the drag and Undo is enabled, but the saved page keeps drawing the file's own rectangle at its old place
  // (no `cm` is written around it), for content in one line or several, with or without q/Q.
  test.fixme('it can be moved, and is then drawn somewhere else', async ({ app }) => {
    await pickFileRect(app);
    const scale = (await app.page.evaluate(() => (window as unknown as { camera: { zoom: number } }).camera.zoom)) * (96 / 72);
    const box = (await frame(app).boundingBox())!;
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await app.page.mouse.move(c.x, c.y);
    await app.page.mouse.down();
    await app.page.mouse.move(c.x + 100 * scale, c.y - 50 * scale, { steps: 5 });
    await app.page.mouse.up();
    await expect
      .poll(async () => {
        // Moved 100 right and 50 up: a cm of the form 1 0 0 1 100 50 wraps the original rectangle.
        return /\b1 0 0 1 100(\.\d+)? 50(\.\d+)? cm\b/.test(await content(app));
      })
      .toBe(true);
  });

  test('Delete takes it out of the saved PDF', async ({ app }) => {
    expect(rects(await content(app)).length).toBe(1);
    await pickFileRect(app);
    await app.page.keyboard.press('Delete');
    await expect.poll(async () => rects(await content(app)).length).toBe(0);
  });
});

test.describe('Edit PDF: pictures', () => {
  test.beforeEach(async ({ app }) => ready(app));

  test('Picture adds an image in the middle of the page and selects it', async ({ app }) => {
    const chooser = app.page.waitForEvent('filechooser');
    await tool(app.page, 'picture').click();
    await (await chooser).setFiles({ name: 'red.png', mimeType: 'image/png', buffer: tinyPng() });
    await expect(frame(app)).toBeVisible();
    await expect(app.page.locator('.wm-forms-kind')).toHaveText('Picture');
    const images = [...finalObjects(await save(app)).values()].filter((d) => /\/Subtype\s*\/Image/.test(d));
    expect(images).toHaveLength(1);
    expect(images[0]).toMatch(/\/Width 40/);
  });

  test('a picture can be deleted again', async ({ app }) => {
    const chooser = app.page.waitForEvent('filechooser');
    await tool(app.page, 'picture').click();
    await (await chooser).setFiles({ name: 'red.png', mimeType: 'image/png', buffer: tinyPng() });
    await expect(frame(app)).toBeVisible();
    await app.page.keyboard.press('Delete');
    await expect(frame(app)).toBeHidden();
    await expect.poll(async () => /\bDo\b/.test(await content(app))).toBe(false);
  });

  test('a file that is not a picture is reported', async ({ app }) => {
    const chooser = app.page.waitForEvent('filechooser');
    await tool(app.page, 'picture').click();
    await (await chooser).setFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
    await expect.poll(() => app.page.evaluate(() => (window as unknown as { status: string }).status)).toContain('Couldn’t add that picture');
  });
});

test.describe('Edit PDF: redact and white out', () => {
  test.beforeEach(async ({ app }) => ready(app));

  test('Redact removes the text under the box from the saved file, and draws a black box', async ({ app }) => {
    await tool(app.page, 'redact').click();
    await dragOnPage(app.page, 0, [30, 36], [260, 68]);
    const bytes = await save(app);
    const c = decodePdf(bytes);
    expect(c).not.toContain('Hello PDF world');
    expect(c).toMatch(/\b0 0 0 rg\b/);
    const text = await readBack(app, bytes);
    expect(text).not.toContain('Hello');
    expect(text).toContain('Second line of text');
  });

  test('Redact over part of a line takes out only those characters', async ({ app }) => {
    await tool(app.page, 'redact').click();
    // "PDF" spans about x 86 to 122 of an 18 pt line starting at 40.
    await dragOnPage(app.page, 0, [88, 40], [120, 68]);
    const text = await readBack(app, await save(app));
    expect(text).not.toContain('PDF');
    expect(text).toContain('Hello');
    expect(text).toContain('world');
    expect(text).toContain('Second line of text');
  });

  test('White Out covers the page but leaves the text in the file, as its tip says', async ({ app }) => {
    await tool(app.page, 'whiteout').click();
    await dragOnPage(app.page, 0, [30, 36], [260, 68]);
    const bytes = await save(app);
    const c = decodePdf(bytes);
    expect(c).toMatch(/\b1 1 1 rg\b/);
    expect(c).toContain('Hello PDF world');
  });

  test('a redaction can be undone before saving', async ({ app }) => {
    await tool(app.page, 'redact').click();
    await dragOnPage(app.page, 0, [30, 36], [260, 68]);
    await expect.poll(async () => await content(app)).not.toContain('Hello PDF world');
    await app.menu('Edit', 'Undo');
    await expect.poll(async () => await content(app)).toContain('Hello PDF world');
  });
});
