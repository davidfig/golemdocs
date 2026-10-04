import { expect, test } from '../fixtures';
import type { App } from '../fixtures';
import { dialog, expectPicture, isReddish, isWhite, makePng, openPicture, pictureToScreen, pixelAt, pngSize, currentPicture } from './helpers';

const W = 400;
const H = 300;
const CANVAS = makePng(W, H, () => [255, 255, 255, 255]);
/** Blue on the left half, white on the right. */
const HALVES = makePng(W, H, (x) => (x < 200 ? [0, 0, 255, 255] : [255, 255, 255, 255]));
/** Nothing at all: every pixel see-through. */
const CLEAR = makePng(W, H, () => [0, 0, 0, 0]);

/** Picks a choice from one of the toolbar's drop-down lists. */
async function choose(app: App, list: string, option: string): Promise<void> {
  await app.page.getByRole('button', { name: list, exact: true }).click();
  await app.page.getByRole('option', { name: option, exact: true }).click();
}

const tool = (app: App, name: string) => app.toolbarButton(new RegExp(`^${name}$`));

async function pick(app: App, name: string): Promise<void> {
  await tool(app, name).click();
  await expect(tool(app, name)).toHaveAttribute('aria-pressed', 'true');
}

async function drag(app: App, from: [number, number], to: [number, number]): Promise<void> {
  const a = await pictureToScreen(app.page, W, ...from);
  const b = await pictureToScreen(app.page, W, ...to);
  await app.page.mouse.move(a.x, a.y);
  await app.page.mouse.down();
  await app.page.mouse.move(b.x, b.y, { steps: 6 });
  await app.page.mouse.up();
}

async function click(app: App, at: [number, number]): Promise<void> {
  const s = await pictureToScreen(app.page, W, ...at);
  await app.page.mouse.click(s.x, s.y);
}

/** The cursor the view shows over a point of the picture. */
async function cursorAt(app: App, at: [number, number]): Promise<string> {
  const s = await pictureToScreen(app.page, W, ...at);
  await app.page.mouse.move(s.x, s.y);
  return app.page.evaluate(() => document.getElementById('canvas')!.style.cursor);
}

test.describe('the pointer follows the tool', () => {
  test('each tool shows its own cursor over the picture, and the plain one comes back when the tools are put down', async ({ app }) => {
    await openPicture(app, CANVAS);
    await pick(app, 'Pen');
    expect(await cursorAt(app, [100, 100])).toContain('url(');
    await pick(app, 'Eraser');
    expect(await cursorAt(app, [110, 100])).toContain('url(');
    await pick(app, 'Eyedropper');
    expect(await cursorAt(app, [120, 100])).toContain('url(');
    await pick(app, 'Paint Bucket');
    expect(await cursorAt(app, [130, 100])).toContain('url(');
    await pick(app, 'Rectangle');
    expect(await cursorAt(app, [140, 100])).toContain('url(');
    await pick(app, 'Text');
    expect(await cursorAt(app, [150, 100])).toBe('text');
    await pick(app, 'Move');
    expect(await cursorAt(app, [160, 100])).toBe('default');
    // With nothing picked, Escape puts the tools down.
    await app.page.keyboard.press('Escape');
    await expect(tool(app, 'Move')).toHaveAttribute('aria-pressed', 'false');
    expect(await cursorAt(app, [170, 100])).toBe('');
  });

  test('over a picked shape the Move tool shows a move cursor, and a resize one over its handles', async ({ app }) => {
    await openPicture(app, CANVAS);
    await pick(app, 'Rectangle');
    await drag(app, [100, 100], [200, 180]);
    await pick(app, 'Move');
    await click(app, [100, 140]);
    expect(await cursorAt(app, [150, 140])).toBe('move');
    expect(await cursorAt(app, [300, 250])).toBe('default');
    expect(await cursorAt(app, [100, 140])).toBe('ew-resize');
    expect(await cursorAt(app, [200, 180])).toBe('nwse-resize');
  });
});

test.describe('Photoshop keys', () => {
  test('a bare letter picks a tool, and they can be changed in Keyboard Shortcuts', async ({ app }) => {
    await openPicture(app, CANVAS);
    for (const [key, name] of [['b', 'Pen'], ['e', 'Eraser'], ['i', 'Eyedropper'], ['g', 'Paint Bucket'], ['u', 'Rectangle'], ['Shift+U', 'Ellipse'], ['t', 'Text'], ['v', 'Move']] as const) {
      await app.page.keyboard.press(key);
      await expect(tool(app, name)).toHaveAttribute('aria-pressed', 'true');
    }
    await app.menu('Help', 'Keyboard Shortcuts');
    const dlg = dialog(app, /Keyboard Shortcuts/);
    await expect(dlg.getByText('Picture Tools')).toBeVisible();
    // Give the Pen another key.
    await dlg.getByRole('button', { name: 'Change shortcut for Pen' }).last().click();
    await app.page.keyboard.press('q');
    await dlg.getByRole('button', { name: /Close/ }).first().click();
    await app.page.keyboard.press('q');
    await expect(tool(app, 'Pen')).toHaveAttribute('aria-pressed', 'true');
  });

  test('[ and ] make the line thinner and thicker', async ({ app }) => {
    await openPicture(app, CANVAS);
    const size = app.page.getByRole('button', { name: 'Line Thickness' });
    await expect(size).toContainText('Medium');
    await app.page.keyboard.press('b');
    await app.page.keyboard.press(']');
    await expect(size).toContainText('Thick');
    await app.page.keyboard.press('[');
    await app.page.keyboard.press('[');
    await expect(size).toContainText('Thin');
  });
});

test.describe('the Layers panel', () => {
  test('everything drawn is a layer: it can be hidden, shown and renamed', async ({ app }) => {
    await openPicture(app, CANVAS);
    // The panel is open to begin with; F7 puts it away and brings it back.
    const panel = app.page.locator('.wm-layers');
    await expect(panel).toBeVisible();
    await app.page.keyboard.press('F7');
    await expect(panel).toBeHidden();
    await app.page.keyboard.press('F7');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Background')).toBeVisible();
    await pick(app, 'Rectangle');
    await app.toolbarButton(/^Fill Shapes$/).click();
    await drag(app, [100, 100], [200, 180]);
    const row = panel.locator('.wm-layers-row').filter({ hasText: 'Rectangle 1' });
    await expect(row).toBeVisible();
    await expectPicture(app, (i) => isReddish(pixelAt(i, 150, 140)));
    await row.getByRole('button', { name: 'Hide' }).click();
    await expectPicture(app, (i) => isWhite(pixelAt(i, 150, 140)));
    await row.getByRole('button', { name: 'Show' }).click();
    await expectPicture(app, (i) => isReddish(pixelAt(i, 150, 140)));
    await row.dblclick();
    await panel.getByRole('textbox', { name: 'Rename' }).fill('Box');
    await app.page.keyboard.press('Enter');
    await expect(panel.locator('.wm-layers-row').filter({ hasText: 'Box' })).toBeVisible();
  });

  test('a locked layer cannot be picked, a group hides what is inside it, and a layer can be deleted', async ({ app }) => {
    await openPicture(app, CANVAS);
    const panel = app.page.locator('.wm-layers');
    await pick(app, 'Rectangle');
    await app.toolbarButton(/^Fill Shapes$/).click();
    await drag(app, [100, 100], [200, 180]);
    await panel.getByRole('button', { name: 'Group', exact: true }).click();
    // A layer made for a tool starts closed.
    await panel.getByRole('button', { name: 'Expand' }).first().click();
    const group = panel.locator('.wm-layers-row').filter({ hasText: 'Group' });
    await expect(group).toBeVisible();
    await group.getByRole('button', { name: 'Hide' }).click();
    await expectPicture(app, (i) => isWhite(pixelAt(i, 150, 140)));
    await group.getByRole('button', { name: 'Show' }).click();
    await group.getByRole('button', { name: 'Lock' }).click();
    // Locked: the Move tool passes over it and picks nothing.
    await pick(app, 'Move');
    await click(app, [150, 140]);
    await expect(panel.locator('.wm-layers-row.selected')).toHaveCount(0);
    await group.getByRole('button', { name: 'Unlock' }).click();
    await click(app, [150, 140]);
    await expect(panel.locator('.wm-layers-row.selected')).not.toHaveCount(0);
    await app.page.keyboard.press('Delete');
    await expectPicture(app, (i) => isWhite(pixelAt(i, 150, 140)));
    // Only the layer made for the tool is left (empty: it goes when another tool is picked).
    await expect(panel.locator('.wm-layers-row').filter({ hasText: 'Rectangle' })).toHaveCount(1);
  });

  test('a new layer takes the shapes drawn next, and its opacity fades them', async ({ app }) => {
    await openPicture(app, CANVAS);
    const panel = app.page.locator('.wm-layers');
    await panel.getByRole('button', { name: 'New Layer' }).click();
    await expect(panel.locator('.wm-layers-row.active-layer')).toBeVisible();
    await pick(app, 'Rectangle');
    await app.toolbarButton(/^Fill Shapes$/).click();
    await drag(app, [100, 100], [200, 180]);
    // The rectangle is inside the layer (indented under it).
    const rows = panel.locator('.wm-layers-row:not(.wm-layers-background)');
    await expect(rows).toHaveCount(2);
    await rows.first().click();
    await panel.getByRole('slider', { name: 'Opacity' }).fill('50');
    await expectPicture(app, (i) => {
      const [r, g] = pixelAt(i, 150, 140);
      return r > 200 && g > 100 && g < 200;
    });
  });
});

test.describe('layers from tools', () => {
  test('each tool picked starts a layer of its own, the same tool keeps drawing into it, and Shift picks a run of layers', async ({ app }) => {
    await openPicture(app, CANVAS);
    const panel = app.page.locator('.wm-layers');
    await pick(app, 'Rectangle');
    await drag(app, [20, 20], [80, 60]);
    await drag(app, [100, 20], [160, 60]);
    await pick(app, 'Line');
    await drag(app, [20, 100], [160, 100]);
    await pick(app, 'Ellipse');
    await drag(app, [20, 150], [80, 200]);
    // Three layers, the two rectangles in the first.
    const layers = panel.locator('.wm-layers-row.layer');
    await expect(layers).toHaveCount(3);
    // A layer made for a tool starts closed; opened, its shapes show.
    await expect(panel.locator('.wm-layers-row').filter({ hasText: /^Rectangle/ })).toHaveCount(1);
    await layers.last().getByRole('button', { name: 'Expand' }).click();
    await expect(panel.locator('.wm-layers-row').filter({ hasText: /^Rectangle/ })).toHaveCount(3);
    // A layer can be closed, so its shapes are out of the way.
    await layers.last().getByRole('button', { name: 'Collapse' }).click();
    await expect(panel.locator('.wm-layers-row').filter({ hasText: /^Rectangle/ })).toHaveCount(1);
    // Click one layer, Shift-click another: everything between is picked; Ctrl-click takes one away.
    await layers.nth(0).click();
    await layers.nth(2).click({ modifiers: ['Shift'] });
    await expect(panel.locator('.wm-layers-row.layer.selected')).toHaveCount(3);
    await layers.nth(1).click({ modifiers: ['ControlOrMeta'] });
    await expect(panel.locator('.wm-layers-row.layer.selected')).toHaveCount(2);
  });
});

test.describe('rotating', () => {
  test('the knob above a picked shape turns it about its middle', async ({ app }) => {
    await openPicture(app, CANVAS);
    await pick(app, 'Rectangle');
    await app.toolbarButton(/^Fill Shapes$/).click();
    await drag(app, [100, 100], [300, 140]);
    await pick(app, 'Move');
    await click(app, [200, 120]);
    // The knob stands 24 screen pixels above the top edge; dragging it round to the right turns the bar a quarter.
    const top = await pictureToScreen(app.page, W, 200, 100);
    const middle = await pictureToScreen(app.page, W, 200, 120);
    await app.page.mouse.move(top.x, top.y - 24);
    await app.page.mouse.down();
    await app.page.mouse.move(middle.x + 80, middle.y - 40, { steps: 5 });
    await app.page.mouse.move(middle.x + 80, middle.y, { steps: 5 });
    await app.page.mouse.up();
    // Now it is tall: ink above and below the middle, none at the old ends.
    await expectPicture(app, (i) => isReddish(pixelAt(i, 200, 40)) && isReddish(pixelAt(i, 200, 200)) && isWhite(pixelAt(i, 120, 120)));
  });
});

test.describe('more tools', () => {
  test('the Paint Bucket floods the area clicked, up to the edge of another colour', async ({ app }) => {
    await openPicture(app, HALVES);
    await pick(app, 'Paint Bucket');
    await click(app, [300, 100]);
    await expectPicture(app, (i) => isReddish(pixelAt(i, 300, 100)) && isReddish(pixelAt(i, 390, 290)) && pixelAt(i, 100, 100)[2] > 240 && pixelAt(i, 100, 100)[0] < 20);
  });

  test('the Eyedropper picks a colour from the picture for what is drawn next', async ({ app }) => {
    await openPicture(app, HALVES);
    await pick(app, 'Eyedropper');
    await click(app, [100, 100]);
    await pick(app, 'Rectangle');
    await app.toolbarButton(/^Fill Shapes$/).click();
    await drag(app, [250, 100], [350, 200]);
    await expectPicture(app, (i) => {
      const [r, g, b] = pixelAt(i, 300, 150);
      return b > 240 && r < 30 && g < 30;
    });
  });

  test('the Shapes tool draws a ready-made shape: a triangle is empty at its top corners', async ({ app }) => {
    await openPicture(app, CANVAS);
    await app.page.keyboard.press('Alt+u');
    await expect(app.page.getByRole('button', { name: /^Shapes/ }).first()).toHaveAttribute('aria-pressed', 'true');
    await app.page.getByRole('button', { name: /^Shapes/ }).nth(1).click();
    await app.page.getByRole('option', { name: 'Triangle', exact: true }).click();
    await app.toolbarButton(/^Fill Shapes$/).click();
    await drag(app, [100, 50], [300, 250]);
    await expectPicture(app, (i) => isReddish(pixelAt(i, 200, 200)) && isWhite(pixelAt(i, 110, 60)) && isWhite(pixelAt(i, 290, 60)));
  });

  test('a gradient fill fades from the fill colour to the second colour', async ({ app }) => {
    await openPicture(app, CANVAS);
    await pick(app, 'Rectangle');
    await app.toolbarButton(/^Fill Shapes$/).click();
    await app.page.getByRole('button', { name: 'Fill Color' }).last().click();
    await app.page.getByRole('button', { name: 'Linear', exact: true }).click();
    await app.page.keyboard.press('Escape');
    await drag(app, [100, 50], [300, 250]);
    // The fill fades from red across to white, so the two ends differ in their green and blue.
    await expectPicture(app, (i) => Math.abs(pixelAt(i, 200, 60)[1] - pixelAt(i, 200, 240)[1]) > 80);
  });

  test('a dashed line leaves gaps', async ({ app }) => {
    await openPicture(app, CANVAS);
    await pick(app, 'Line');
    await choose(app, 'Line Style', 'Dashed');
    await drag(app, [20, 150], [380, 150]);
    await expectPicture(app, (i) => {
      let inked = 0;
      let gaps = 0;
      for (let x = 30; x < 370; x++) (isWhite(pixelAt(i, x, 150)) ? gaps++ : inked++);
      return inked > 50 && gaps > 50;
    });
  });
});

test.describe('background and canvas', () => {
  test('Picture › Background lays a colour behind a see-through picture', async ({ app }) => {
    await openPicture(app, CLEAR);
    expect((await currentPicture(app)).data[3]).toBe(0);
    await app.menu('Picture', 'Background…');
    const dlg = dialog(app, 'Background');
    await dlg.getByRole('button', { name: 'OK' }).click();
    await expectPicture(app, (i) => isReddish(pixelAt(i, 10, 10)) && pixelAt(i, 10, 10)[3] === 255);
  });

  test('Picture › Canvas Size grows the canvas around the picture and fills the new area', async ({ app }) => {
    await openPicture(app, HALVES);
    await app.menu('Picture', 'Canvas Size…');
    const dlg = dialog(app, 'Canvas Size');
    await dlg.getByRole('spinbutton', { name: 'Width' }).fill('500');
    await dlg.getByRole('spinbutton', { name: 'Height' }).fill('400');
    await dlg.getByRole('radio', { name: 'Top left' }).click();
    await dlg.getByRole('button', { name: 'OK' }).click();
    await expectPicture(app, (i) => i.width === 500 && i.height === 400);
    // The picture stays at the top left; the new area is filled.
    const img = await currentPicture(app);
    expect(pngSize(img.bytes)).toEqual({ width: 500, height: 400 });
    expect(pixelAt(img, 100, 100)[2]).toBeGreaterThan(240);
    expect(pixelAt(img, 100, 100)[0]).toBeLessThan(20);
    expect(pixelAt(img, 450, 350)[3]).toBe(255);
  });
});
