import { expect, test } from '../fixtures';
import type { App } from '../fixtures';
import { currentPicture, expectPicture, isReddish, isWhite, makePng, openPicture, penEraser, penStroke, pictureToScreen, pixelAt, pngSize } from './helpers';

const W = 400;
const H = 300;
/** A white picture to draw on: anything drawn shows against it. */
const CANVAS = makePng(W, H, () => [255, 255, 255, 255]);
/** Black and white stripes 4 pixels wide, to see a redaction average. */
const STRIPES = makePng(W, H, (x) => (Math.floor(x / 4) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));

async function start(app: App, tool: string, png = CANVAS): Promise<void> {
  await openPicture(app, png);
  await pickTool(app, tool);
}

/** Picks a Draw tool from the toolbar (they stay picked until Done). */
async function pickTool(app: App, tool: string): Promise<void> {
  await app.toolbarButton(new RegExp(`^${tool}$`)).click();
  await expect(app.toolbarButton(new RegExp(`^${tool}$`))).toHaveAttribute('aria-pressed', 'true');
  await expect(app.page.locator('.wm-draw')).toBeVisible();
}

async function drag(app: App, from: [number, number], to: [number, number], via: [number, number][] = []): Promise<void> {
  const a = await pictureToScreen(app.page, W, ...from);
  await app.page.mouse.move(a.x, a.y);
  await app.page.mouse.down();
  for (const p of [...via, to]) {
    const s = await pictureToScreen(app.page, W, ...p);
    await app.page.mouse.move(s.x, s.y, { steps: 6 });
  }
  await app.page.mouse.up();
}

async function click(app: App, at: [number, number]): Promise<void> {
  const s = await pictureToScreen(app.page, W, ...at);
  await app.page.mouse.click(s.x, s.y);
}

/** Puts the tools down: Enter (there is no Done button; the shapes stay on the picture as its layers). */
const done = (app: App) => app.page.keyboard.press('Enter');

/** Any non-white pixel in the box (picture pixels). */
function inked(img: { width: number; data: Uint8Array }, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (!isWhite(pixelAt(img, x, y))) n++;
  return n;
}

test.describe('the Draw toolbar', () => {
  test('picking a tool shows the drawing layer, Enter puts the tools down, and only one tool is pressed at a time', async ({ app }) => {
    await start(app, 'Pen');
    await pickTool(app, 'Line');
    await expect(app.toolbarButton(/^Pen$/)).toHaveAttribute('aria-pressed', 'false');
    await done(app);
    await expect(app.toolbarButton(/^Line$/)).toHaveAttribute('aria-pressed', 'false');
  });

  test('the tools are in the Picture menu too', async ({ app }) => {
    await openPicture(app, CANVAS);
    await app.menu('Picture', 'Rectangle');
    await expect(app.page.locator('.wm-draw')).toBeVisible();
    await drag(app, [50, 50], [150, 120]);
    await done(app);
    await expectPicture(app, (i) => isReddish(pixelAt(i, 50, 85)));
  });

  test('Drawing Color and Line Thickness are offered', async ({ app }) => {
    await openPicture(app, CANVAS);
    await expect(app.page.getByRole('button', { name: 'Line Thickness' })).toBeVisible();
    await expect(app.toolbarButton(/Drawing Color/).first()).toBeVisible();
    await expect(app.toolbarButton(/^Fill Shapes$/)).toBeVisible();
  });
});

test.describe('drawing shapes', () => {
  test('Pen draws a freehand stroke through the points dragged', async ({ app }) => {
    await start(app, 'Pen');
    await drag(app, [50, 50], [150, 50], [[100, 100]]);
    await done(app);
    await expectPicture(app, (i) => isReddish(pixelAt(i, 75, 75)) && isReddish(pixelAt(i, 125, 75)) && isWhite(pixelAt(i, 250, 200)));
    // The picture is the same size.
    expect(pngSize((await currentPicture(app)).bytes)).toEqual({ width: W, height: H });
  });

  test('Highlighter marks semi-transparently: the colour shows but the picture still shows through', async ({ app }) => {
    await start(app, 'Highlighter', makePng(W, H, () => [0, 0, 255, 255]));
    await drag(app, [50, 100], [250, 100]);
    await done(app);
    await expectPicture(app, (i) => {
      const [r, , b] = pixelAt(i, 150, 100);
      return r > 40 && b > 60 && b < 255; // neither blue nor pure red: a blend
    });
  });

  test('Line draws straight between where the drag began and ended', async ({ app }) => {
    await start(app, 'Line');
    await drag(app, [40, 40], [240, 240]);
    await done(app);
    await expectPicture(app, (i) => isReddish(pixelAt(i, 140, 140)) && isWhite(pixelAt(i, 240, 40)) && isWhite(pixelAt(i, 40, 240)));
  });

  test('Arrow draws a line with a head at the end', async ({ app }) => {
    await start(app, 'Arrow');
    await drag(app, [50, 150], [250, 150]);
    await done(app);
    await expectPicture(app, (i) => {
      const shaft = inked(i, 100, 145, 140, 156);
      const head = inked(i, 225, 130, 252, 170);
      const tail = inked(i, 50, 130, 80, 170);
      // The head is wider than the shaft at the tail.
      return isReddish(pixelAt(i, 150, 150)) && head > tail * 1.5 && shaft > 0;
    });
  });

  test('Rectangle draws an outline (the inside stays), Fill Shapes fills it', async ({ app }) => {
    await start(app, 'Rectangle');
    await drag(app, [60, 60], [200, 160]);
    await done(app);
    await expectPicture(app, (i) => isReddish(pixelAt(i, 60, 110)) && isReddish(pixelAt(i, 130, 60)) && isWhite(pixelAt(i, 130, 110)));
    await pickTool(app, 'Rectangle');
    await app.toolbarButton(/^Fill Shapes$/).click();
    await drag(app, [250, 60], [350, 160]);
    await done(app);
    await expectPicture(app, (i) => isReddish(pixelAt(i, 300, 110)) && isWhite(pixelAt(i, 130, 110)));
  });

  test('Ellipse draws an outline touching the edges of the dragged box, not its corners', async ({ app }) => {
    await start(app, 'Ellipse');
    await drag(app, [100, 80], [300, 220]);
    await done(app);
    await expectPicture(app, (i) => isReddish(pixelAt(i, 100, 150)) && isReddish(pixelAt(i, 200, 80)) && isWhite(pixelAt(i, 102, 82)) && isWhite(pixelAt(i, 200, 150)));
  });

  test('Numbered Marker drops 1, then 2, at each click', async ({ app }) => {
    await start(app, 'Numbered Marker');
    await click(app, [80, 80]);
    await click(app, [250, 200]);
    await done(app);
    await expectPicture(app, (i) => inked(i, 60, 60, 100, 100) > 80 && inked(i, 230, 180, 270, 220) > 80 && inked(i, 300, 20, 380, 60) === 0);
  });

  test('Text puts what is typed where it was clicked (Enter), and Esc drops the box', async ({ app }) => {
    await start(app, 'Text');
    await click(app, [60, 100]);
    await app.page.getByRole('textbox', { name: 'Text' }).fill('Hello');
    await app.page.keyboard.press('Enter');
    await click(app, [60, 200]);
    await app.page.getByRole('textbox', { name: 'Text' }).fill('Dropped');
    await app.page.keyboard.press('Escape');
    await done(app);
    await expectPicture(app, (i) => inked(i, 55, 95, 200, 140) > 40 && inked(i, 55, 195, 250, 240) === 0);
  });

  test('Speech Bubble draws a bubble around the typed text', async ({ app }) => {
    await start(app, 'Speech Bubble');
    await click(app, [200, 200]);
    await app.page.getByRole('textbox', { name: 'Text' }).fill('Hi');
    await app.page.keyboard.press('Enter');
    await done(app);
    await expectPicture(app, (i) => inked(i, 100, 80, 320, 220) > 150);
  });

  test('Redact pixelates the area dragged, averaging the stripes away, and leaves the rest', async ({ app }) => {
    await start(app, 'Redact', STRIPES);
    await drag(app, [100, 100], [220, 200]);
    await done(app);
    await expectPicture(app, (i) => {
      const inside = [pixelAt(i, 150, 150)[0], pixelAt(i, 151, 150)[0], pixelAt(i, 152, 150)[0], pixelAt(i, 153, 150)[0]];
      const outside = [pixelAt(i, 300, 150)[0], pixelAt(i, 304, 150)[0]];
      return Math.max(...inside) - Math.min(...inside) < 60 && Math.abs(outside[0] - outside[1]) > 200;
    });
  });
});

test.describe('editing a sketch', () => {
  test('Ctrl+Z undoes a shape while drawing', async ({ app }) => {
    await start(app, 'Line');
    await drag(app, [40, 40], [200, 40]);
    await drag(app, [40, 100], [200, 100]);
    await app.page.keyboard.press('Control+z');
    await done(app);
    await expectPicture(app, (i) => isReddish(pixelAt(i, 120, 40)) && isWhite(pixelAt(i, 120, 100)));
  });

  test('Eraser takes away the shape it is clicked on', async ({ app }) => {
    await start(app, 'Rectangle');
    await drag(app, [40, 40], [140, 120]);
    await drag(app, [200, 40], [300, 120]);
    await pickTool(app, 'Eraser');
    await click(app, [40, 80]); // on the first rectangle's left edge
    await done(app);
    await expectPicture(app, (i) => isWhite(pixelAt(i, 40, 80)) && isReddish(pixelAt(i, 200, 80)));
  });

  test('Move carries a shape to where it is dragged', async ({ app }) => {
    await start(app, 'Rectangle');
    await drag(app, [40, 40], [120, 100]);
    await pickTool(app, 'Move');
    await drag(app, [40, 70], [240, 170]);
    await done(app);
    await expectPicture(app, (i) => isWhite(pixelAt(i, 40, 70)) && isReddish(pixelAt(i, 240, 170)));
  });

  test('switching tools keeps what is drawn: a line and a rectangle in one sketch', async ({ app }) => {
    await start(app, 'Line');
    await drag(app, [40, 40], [200, 40]);
    await pickTool(app, 'Rectangle');
    await drag(app, [40, 100], [200, 200]);
    await done(app);
    await expectPicture(app, (i) => isReddish(pixelAt(i, 120, 40)) && isReddish(pixelAt(i, 40, 150)) && isWhite(pixelAt(i, 120, 150)));
  });

  test('Escape puts the tools down, and what is drawn stays on the picture as its layers', { tag: '@heavy' }, async ({ app }) => {
    await start(app, 'Rectangle');
    await drag(app, [40, 40], [120, 100]);
    await app.page.keyboard.press('Escape');
    await expect(app.toolbarButton(/^Rectangle$/)).toHaveAttribute('aria-pressed', 'false');
    // The rectangle, and the layer it was put in when the tool was picked.
    await expect.poll(() => app.page.evaluate(() => (window as unknown as { pictureShapes: { tool: string }[] }).pictureShapes.map((s) => s.tool).sort())).toEqual(['group', 'rectangle']);
    await expectPicture(app, (i) => inked(i, 0, 0, W, H) > 0);
  });

  test('Enter finishes the sketch like Done', async ({ app }) => {
    await start(app, 'Line');
    await drag(app, [40, 40], [200, 40]);
    await app.page.keyboard.press('Enter');
    await expect(app.toolbarButton(/^Line$/)).toHaveAttribute('aria-pressed', 'false');
    await expectPicture(app, (i) => isReddish(pixelAt(i, 120, 40)));
  });

  test('Done with nothing drawn changes nothing, and each shape is an undo step', async ({ app }) => {
    await start(app, 'Pen');
    await done(app);
    expect(inked(await currentPicture(app), 0, 0, W, H)).toBe(0);
    await pickTool(app, 'Line');
    await drag(app, [40, 40], [200, 40]);
    await drag(app, [40, 100], [200, 100]);
    await done(app);
    await expectPicture(app, (i) => isReddish(pixelAt(i, 120, 40)) && isReddish(pixelAt(i, 120, 100)));
    await app.menu('Edit', 'Undo');
    await expectPicture(app, (i) => isReddish(pixelAt(i, 120, 40)) && isWhite(pixelAt(i, 120, 100)));
    await app.menu('Edit', 'Undo');
    await expectPicture(app, (i) => inked(i, 0, 0, W, H) === 0);
    await app.menu('Edit', 'Redo');
    await expectPicture(app, (i) => isReddish(pixelAt(i, 120, 40)));
  });

  test('a shape drawn stays on the picture after the tools are put down, and Crop puts it into the picture', async ({ app }) => {
    await start(app, 'Rectangle');
    await drag(app, [40, 40], [120, 100]);
    await done(app);
    // The rectangle, and the layer it was put in when the tool was picked.
    await expect.poll(() => app.page.evaluate(() => (window as unknown as { pictureShapes: { tool: string }[] }).pictureShapes.map((s) => s.tool).sort())).toEqual(['group', 'rectangle']);
    // A change to the picture itself takes the shapes into it: they are not layers any more.
    await app.menu('Picture', 'Rotate Right');
    await expect.poll(() => app.page.evaluate(() => (window as unknown as { pictureShapes: unknown[] }).pictureShapes.length)).toBe(0);
    await expectPicture(app, (i) => inked(i, 0, 0, i.width, i.height) > 0);
  });

  test('the Line Thickness list makes thicker strokes', async ({ app }) => {
    await start(app, 'Line');
    await drag(app, [40, 40], [200, 40]);
    await done(app);
    let thin = 0;
    await expectPicture(app, (i) => ((thin = inked(i, 100, 20, 120, 60)) > 0));
    await pickTool(app, 'Line');
    await app.page.getByRole('button', { name: 'Line Thickness' }).click();
    await app.page.getByRole('option', { name: 'Extra thick' }).click();
    await drag(app, [40, 200], [200, 200]);
    await done(app);
    await expectPicture(app, (i) => inked(i, 100, 180, 120, 220) > thin * 2);
  });
});

test.describe('a drawing tablet’s pen', () => {
  test('the Pen draws a thicker line where the pen is pressed harder', async ({ app }) => {
    await start(app, 'Pen');
    await app.page.getByRole('button', { name: 'Line Thickness' }).click();
    await app.page.getByRole('option', { name: 'Extra thick' }).click();
    // From a light touch at the left to pressed hard at the right.
    const points = [];
    for (let i = 0; i <= 32; i++) points.push({ ...(await pictureToScreen(app.page, W, 40 + i * 10, 100)), pressure: 0.08 + (0.92 * i) / 32 });
    await penStroke(app.page, points);
    await done(app);
    await expectPicture(app, (i) => {
      const light = inked(i, 60, 70, 80, 130);
      const hard = inked(i, 320, 70, 340, 130);
      return light > 0 && hard > light * 3;
    });
  });

  test('with pen pressure turned off in Tools ▸ Options, the Pen draws one width however hard it is pressed', async ({ app }) => {
    await openPicture(app, CANVAS);
    await app.menu('Tools', 'Options');
    const options = app.page.getByRole('dialog', { name: 'Options' });
    await options.getByRole('checkbox', { name: /harder a tablet’s pen is pressed/ }).uncheck();
    await options.getByRole('button', { name: 'OK' }).click();
    await pickTool(app, 'Pen');
    await app.page.getByRole('button', { name: 'Line Thickness' }).click();
    await app.page.getByRole('option', { name: 'Extra thick' }).click();
    const points = [];
    for (let i = 0; i <= 32; i++) points.push({ ...(await pictureToScreen(app.page, W, 40 + i * 10, 100)), pressure: 0.08 + (0.92 * i) / 32 });
    await penStroke(app.page, points);
    await done(app);
    await expectPicture(app, (i) => {
      const light = inked(i, 60, 70, 80, 130);
      const hard = inked(i, 320, 70, 340, 130);
      return light > 0 && Math.abs(hard - light) < light * 0.3;
    });
    await app.page.evaluate(() => localStorage.removeItem('vector.penPressure'));
  });

  test('the pen’s eraser end erases what it passes over, whatever tool is picked', async ({ app }) => {
    await start(app, 'Rectangle');
    await drag(app, [40, 40], [140, 120]);
    await drag(app, [200, 40], [300, 120]);
    // Across the first rectangle's left edge.
    await penEraser(app.page, [await pictureToScreen(app.page, W, 30, 80), await pictureToScreen(app.page, W, 40, 80), await pictureToScreen(app.page, W, 50, 80)]);
    // Still the Rectangle tool afterwards.
    await expect(app.toolbarButton(/^Rectangle$/)).toHaveAttribute('aria-pressed', 'true');
    await done(app);
    await expectPicture(app, (i) => isWhite(pixelAt(i, 40, 80)) && isReddish(pixelAt(i, 200, 80)));
  });
});
