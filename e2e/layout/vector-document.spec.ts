import { expect, test } from '../fixtures';
import { importFile } from '../files/helpers';
import { pageBoxes, penStroke } from './helpers';
import type { App } from '../fixtures';

const DRAWING = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">
  <rect id="red" x="20" y="20" width="120" height="80" fill="#e53935" stroke="#000" stroke-width="4"/>
  <circle id="green" cx="300" cy="100" r="60" fill="#43a047"/>
</svg>`;

async function openDrawing(app: App, svg = DRAWING, name = 'drawing.svg'): Promise<void> {
  await app.blank();
  await importFile(app, { name, mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  await app.menubar.getByRole('menuitem', { name: 'Drawing' }).waitFor({ timeout: 30_000 });
  await app.page.waitForFunction(() => (window as unknown as { pages: unknown[] }).pages.length === 1);
  // The editor is a chunk fetched when the drawing opens: its layers panel is there when it is ready.
  await expect(app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem')).toHaveCount(2, { timeout: 30_000 });
}

/** The drawing's file, downloaded (File ▸ Download). */
async function currentSvg(app: App): Promise<string> {
  return (await app.download(() => app.menu('File', 'Download'))).text;
}

/** A point on the page of the drawing, from the fractions of its width and height. */
async function onPage(app: App, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const box = await app.page.locator('.wm-vector-canvas').boundingBox();
  if (!box) throw new Error('the drawing is not shown');
  // The page is centred in the view, with a margin: the drawing's own area is found from the white of its page.
  const area = await app.page.evaluate(() => {
    const canvas = document.querySelector('.wm-vector-canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let x0 = width;
    let y0 = height;
    let x1 = 0;
    let y1 = 0;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const i = (y * width + x) * 4;
        if (data[i + 3] > 200) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
    }
    const ratio = width / canvas.clientWidth;
    return { x0: x0 / ratio, y0: y0 / ratio, x1: x1 / ratio, y1: y1 / ratio };
  });
  return { x: box.x + area.x0 + (area.x1 - area.x0) * fx, y: box.y + area.y0 + (area.y1 - area.y0) * fy };
}

test.describe('opening a vector drawing', () => {
  test('an SVG opens as a drawing of its own kind, with the Drawing menu and toolbar and no Picture menu', async ({ app }) => {
    await openDrawing(app);
    // 400 × 200 pixels at 96 dpi.
    expect(await pageBoxes(app.page)).toEqual([{ width: 300, height: 150 }]);
    await expect(app.menubar.getByRole('menuitem', { name: 'Picture' })).toHaveCount(0);
    for (const name of ['Select', 'Rectangle', 'Ellipse', 'Line', 'Pen', 'Text', 'Group', 'Ungroup', 'Duplicate', 'Delete']) {
      await expect(app.toolbarButton(new RegExp(`^${name}$`))).toBeVisible();
    }
    await expect(app.page.getByRole('button', { name: 'Stroke Style' })).toBeVisible();
    await expect(app.page.getByRole('button', { name: 'Fill Color options' })).toBeVisible();
    // The layers panel lists the shapes, the top one first.
    const layers = app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem');
    await expect(layers.nth(0)).toContainText('green');
    await expect(layers.nth(1)).toContainText('red');
  });

  test('the file comes back out as SVG, unchanged until something is edited', async ({ app }) => {
    await openDrawing(app);
    const svg = await currentSvg(app);
    expect(svg).toContain('<rect id="red"');
    expect(svg).toContain('<circle id="green"');
  });

  test('a compressed SVG opens too, and converting to SVG Drawing offers both kinds', async ({ app }) => {
    await app.blank();
    await app.page.getByRole('combobox', { name: 'Format' }).first().click();
    await expect(app.page.getByRole('option', { name: 'SVG Drawing', exact: true })).toBeAttached();
    await expect(app.page.getByRole('option', { name: 'Compressed SVG Drawing' })).toBeAttached();
  });
});

test.describe('editing a drawing', () => {
  test('a rectangle is drawn with the Rectangle tool and saved in the file', async ({ app }) => {
    await openDrawing(app);
    await app.toolbarButton('Rectangle').click();
    const from = await onPage(app, 0.1, 0.6);
    const to = await onPage(app, 0.4, 0.95);
    await app.page.mouse.move(from.x, from.y);
    await app.page.mouse.down();
    await app.page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2);
    await app.page.mouse.move(to.x, to.y);
    await app.page.mouse.up();
    // It is a third shape, picked, and the tool is put back to Select.
    const layers = app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem');
    await expect(layers).toHaveCount(3);
    await expect(layers.first()).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await currentSvg(app)).match(/<rect /g)?.length ?? 0, { timeout: 15_000 }).toBe(2);
  });

  test('a shape is picked by clicking it, deleted with the Delete key, and brought back by Undo', async ({ app }) => {
    await openDrawing(app);
    const layers = app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem');
    const at = await onPage(app, 0.75, 0.5); // the green circle's middle
    await app.page.mouse.click(at.x, at.y);
    await expect(layers.first()).toHaveAttribute('aria-selected', 'true');
    await app.press('Delete');
    await expect(layers).toHaveCount(1);
    await expect.poll(async () => (await currentSvg(app)).includes('id="green"'), { timeout: 15_000 }).toBe(false);
    await app.menu('Edit', 'Undo');
    await expect(layers).toHaveCount(2);
    await expect.poll(async () => (await currentSvg(app)).includes('id="green"'), { timeout: 15_000 }).toBe(true);
  });

  test('a shape is hidden and locked from the layers panel', async ({ app }) => {
    await openDrawing(app);
    const layers = app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem');
    await layers.first().getByRole('button', { name: 'Hide' }).click();
    await expect.poll(async () => (await currentSvg(app)).match(/<circle[^>]*display="none"/) !== null, { timeout: 15_000 }).toBe(true);
    await layers.nth(1).getByRole('button', { name: 'Lock' }).click();
    await expect.poll(async () => (await currentSvg(app)).includes('data-golem-locked="true"'), { timeout: 15_000 }).toBe(true);
  });

  test('a stroke style from the list is applied to the picked shape and kept in the file', async ({ app }) => {
    await openDrawing(app);
    const at = await onPage(app, 0.25, 0.4); // the red rectangle
    await app.page.mouse.click(at.x, at.y);
    const list = app.page.getByRole('listbox', { name: 'Stroke Style' });
    await app.page.getByRole('button', { name: 'Stroke Style' }).click();
    // Each row shows a drawing of its stroke, and the current one is marked.
    await expect(list.getByRole('option', { name: 'Solid' })).toHaveAttribute('aria-selected', 'true');
    await expect(list.getByRole('option', { name: 'Frayed Ink' }).locator('svg path')).toHaveCount(1);
    await list.getByRole('option', { name: 'Dashed', exact: true }).click();
    await expect.poll(async () => (await currentSvg(app)).includes('stroke-dasharray'), { timeout: 15_000 }).toBe(true);
    await app.page.getByRole('button', { name: 'Stroke Style' }).click();
    await expect(list.getByRole('option', { name: 'Dashed', exact: true })).toHaveAttribute('aria-selected', 'true');
    await list.getByRole('option', { name: 'Solid' }).click();
    await expect.poll(async () => (await currentSvg(app)).includes('stroke-dasharray'), { timeout: 15_000 }).toBe(false);
  });

  test('the stroke width is a list like the stroke style’s, each width drawn as a line', async ({ app }) => {
    await openDrawing(app);
    const at = await onPage(app, 0.25, 0.4); // the red rectangle, 4 wide
    await app.page.mouse.click(at.x, at.y);
    const button = app.page.getByRole('button', { name: 'Outline Width' });
    await expect(button).toContainText('4');
    await button.click();
    const list = app.page.getByRole('listbox', { name: 'Outline Width' });
    await expect(list.getByRole('option', { name: '4', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(list.locator('svg')).toHaveCount(7);
    await list.getByRole('option', { name: '8', exact: true }).click();
    await expect(button).toContainText('8');
    await expect.poll(async () => /<rect[^>]*stroke-width="8"/.test(await currentSvg(app)), { timeout: 15_000 }).toBe(true);
  });

  test('a radial gradient’s stops are rings on the shape: drag one to move it, click one to pick it and colour it alone', async ({ app }) => {
    await openDrawing(app);
    const centre = await onPage(app, 0.75, 0.5); // the green circle, 60 across from its centre to its edge
    const scale = (await onPage(app, 1, 0.5)).x - (await onPage(app, 0, 0.5)).x;
    const px = scale / 400;
    await app.page.mouse.click(centre.x, centre.y);
    await app.page.getByRole('button', { name: 'Fill Color options' }).click();
    const popup = app.page.locator('.wm-palette');
    await popup.getByRole('button', { name: 'Radial' }).click();
    await expect(popup.locator('.wm-grad-stop')).toHaveCount(2); // the editor is drawn when the state follows
    const bar = await popup.locator('.wm-grad-bar').boundingBox();
    await app.page.mouse.click(bar!.x + bar!.width / 2, bar!.y + bar!.height / 2); // a stop halfway out
    await expect(popup.locator('.wm-grad-stop')).toHaveCount(3);
    await app.page.keyboard.press('Escape');
    // The ring is grabbed above the centre line, not only at its dot, and dragged outwards.
    await app.page.mouse.move(centre.x, centre.y - 30 * px);
    await app.page.mouse.down();
    await app.page.mouse.move(centre.x, centre.y - 45 * px, { steps: 4 });
    await app.page.mouse.up();
    await expect.poll(async () => /offset="0\.7[0-9]*"/.test((await currentSvg(app)).match(/<radialGradient[\s\S]*?<\/radialGradient>/)?.[0] ?? ''), { timeout: 15_000 }).toBe(true);
    // The ring stays picked: a palette colour changes that stop only.
    await app.page.getByRole('button', { name: 'Fill Color options' }).click();
    await expect(popup.getByLabel('Position')).toHaveValue('75');
    await popup.getByRole('button', { name: '#0000FF' }).click();
    await expect.poll(async () => /offset="0\.75[0-9]*"[^>]*stop-color="#0000FF"/i.test(await currentSvg(app)), { timeout: 15_000 }).toBe(true);
  });

  test('the Fill popup lists the colours the drawing uses and marks the picked shape’s own', async ({ app }) => {
    await openDrawing(app);
    const at = await onPage(app, 0.75, 0.5); // the green circle
    await app.page.mouse.click(at.x, at.y);
    await app.page.getByRole('button', { name: 'Fill Color options' }).click();
    const used = app.page.locator('.wm-palette').getByRole('button', { name: '#e53935' });
    await expect(used).toHaveCount(1);
    await expect(app.page.locator('.wm-palette').getByRole('button', { name: '#000000' })).toHaveCount(2); // in the palette and in the drawing
    await expect(app.page.locator('.wm-swatch.current')).toHaveAttribute('title', '#43a047');
  });

  test('the Fill popup makes a gradient and edits its stops: pick, add, move, colour, delete, reverse', async ({ app }) => {
    await openDrawing(app);
    const at = await onPage(app, 0.75, 0.5);
    await app.page.mouse.click(at.x, at.y);
    await app.page.getByRole('button', { name: 'Fill Color options' }).click();
    const popup = app.page.locator('.wm-palette');
    await popup.getByRole('button', { name: 'Linear' }).click();
    // The popup stays open and now shows the gradient's two stops.
    const stops = popup.locator('.wm-grad-stop');
    await expect(stops).toHaveCount(2);
    // A click on the bar adds a stop, and it is the picked one.
    const bar = await popup.locator('.wm-grad-bar').boundingBox();
    await app.page.mouse.click(bar!.x + bar!.width / 2, bar!.y + bar!.height / 2);
    await expect(stops).toHaveCount(3);
    await expect(popup.getByRole('button', { name: 'Color stop 2' })).toHaveAttribute('aria-pressed', 'true');
    // Its position is typed, and a colour from the palette is its colour (the popup stays open).
    await popup.getByLabel('Position').fill('25');
    await popup.getByLabel('Position').press('Tab');
    await popup.getByRole('button', { name: '#FF0000' }).click();
    await expect(stops).toHaveCount(3);
    await expect(popup.getByLabel('Position')).toHaveValue('25');
    // Reverse turns the gradient around: the red stop is now at 75%.
    await popup.getByRole('button', { name: 'Reverse' }).click();
    await expect(popup.getByLabel('Position')).toHaveValue('75');
    // An inner stop can be deleted; the ends cannot.
    await popup.getByRole('button', { name: 'Delete Stop' }).click();
    await expect(stops).toHaveCount(2);
    await popup.getByRole('button', { name: 'Color stop 1' }).click();
    await expect(popup.getByRole('button', { name: 'Delete Stop' })).toBeDisabled();
    // The file has the gradient with its two stops left.
    await expect.poll(async () => (await currentSvg(app)).match(/<linearGradient[\s\S]*?<\/linearGradient>/)?.[0].match(/<stop /g)?.length, { timeout: 15_000 }).toBe(2);
  });

  test('with nothing selected, the Fill popup makes and edits the gradient the next shape is drawn with', async ({ app }) => {
    await openDrawing(app);
    await app.page.getByRole('button', { name: 'Fill Color options' }).click();
    const popup = app.page.locator('.wm-palette');
    await popup.getByRole('button', { name: 'Linear' }).click();
    // The gradient for new shapes shows its two stops: the second picked and coloured, and a third added.
    const stops = popup.locator('.wm-grad-stop');
    await expect(stops).toHaveCount(2);
    await popup.getByRole('button', { name: 'Color stop 2' }).click();
    await expect(popup.getByRole('button', { name: 'Color stop 2' })).toHaveAttribute('aria-pressed', 'true');
    await popup.getByRole('button', { name: '#FF0000' }).click();
    await expect.poll(() => popup.getByRole('button', { name: 'Color stop 2' }).evaluate((e) => (e as HTMLElement).style.getPropertyValue('--stop').toLowerCase())).toBe('#ff0000');
    const bar = (await popup.locator('.wm-grad-bar').boundingBox())!;
    await app.page.mouse.click(bar.x + bar.width * 0.4, bar.y + bar.height / 2);
    await expect(stops).toHaveCount(3);
    await app.page.keyboard.press('Escape');
    // A rectangle drawn now is filled with it.
    await app.toolbarButton('Rectangle').click();
    const from = await onPage(app, 0.1, 0.6);
    const to = await onPage(app, 0.4, 0.95);
    await app.page.mouse.move(from.x, from.y);
    await app.page.mouse.down();
    await app.page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2);
    await app.page.mouse.move(to.x, to.y);
    await app.page.mouse.up();
    await expect(app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem')).toHaveCount(3);
    const svg = await currentSvg(app);
    const gradient = svg.match(/<linearGradient[^>]*id="([^"]+)"[\s\S]*?<\/linearGradient>/);
    expect(gradient).not.toBeNull();
    expect(gradient![0].match(/<stop /g)).toHaveLength(3);
    expect(gradient![0]).toMatch(/offset="1"[^>]*stop-color="#FF0000"/i);
    expect(svg).toMatch(new RegExp(`<rect[^>]*fill="url\\(#${gradient![1]}\\)"`));
  });

  test('one click on Solid, Linear or Radial changes the fill, even while the document is saving', async ({ app }) => {
    await openDrawing(app);
    const at = await onPage(app, 0.75, 0.5);
    await app.page.mouse.click(at.x, at.y);
    await app.page.getByRole('button', { name: 'Fill Color options' }).click();
    const popup = app.page.locator('.wm-palette');
    const types = popup.getByRole('group', { name: 'Fill Type' });
    await types.getByRole('button', { name: 'Linear' }).click();
    await expect(types.getByRole('button', { name: 'Linear' })).toHaveAttribute('aria-pressed', 'true');
    // Held down while the change just made is saved (the save status changes under it), then let go.
    const solid = (await types.getByRole('button', { name: 'Solid' }).boundingBox())!;
    await app.page.mouse.move(solid.x + solid.width / 2, solid.y + solid.height / 2);
    await app.page.mouse.down();
    await app.page.waitForTimeout(1500);
    await app.page.mouse.up();
    await expect(types.getByRole('button', { name: 'Solid' })).toHaveAttribute('aria-pressed', 'true');
    await expect(popup.locator('.wm-grad-bar')).toHaveCount(0);
    // With a solid fill too, the swatches flow across the popup's width, centred.
    const spread = await popup.locator('.wm-palette-grid').first().evaluate((grid) => {
      const box = grid.getBoundingClientRect();
      const boxes = [...grid.children].map((c) => c.getBoundingClientRect());
      return { left: Math.min(...boxes.map((b) => b.left)) - box.left, right: box.right - Math.max(...boxes.map((b) => b.right)) };
    });
    expect(spread.right).toBeLessThan(24);
    expect(Math.abs(spread.left - spread.right)).toBeLessThanOrEqual(1);
    await types.getByRole('button', { name: 'Radial' }).click();
    await expect(types.getByRole('button', { name: 'Radial' })).toHaveAttribute('aria-pressed', 'true');
    await expect(popup.locator('.wm-grad-stop')).toHaveCount(2);
  });

  test('the Fill popup’s stop markers: one added off centre is picked, a drag moves it, a click picks another, Delete Stop takes any', async ({ app }) => {
    await openDrawing(app);
    const at = await onPage(app, 0.75, 0.5);
    await app.page.mouse.click(at.x, at.y);
    await app.page.getByRole('button', { name: 'Fill Color options' }).click();
    const popup = app.page.locator('.wm-palette');
    await popup.getByRole('button', { name: 'Linear' }).click();
    const stops = popup.locator('.wm-grad-stop');
    await expect(stops).toHaveCount(2);
    // Under the gradient's editor the swatches flow across the popup's whole width, centred, leaving no empty strip.
    const spread = await popup.locator('.wm-palette-grid').first().evaluate((grid) => {
      const box = grid.getBoundingClientRect();
      const boxes = [...grid.children].map((c) => c.getBoundingClientRect());
      return { left: Math.min(...boxes.map((b) => b.left)) - box.left, right: box.right - Math.max(...boxes.map((b) => b.right)), columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length };
    });
    expect(spread.columns).toBeGreaterThan(8);
    expect(spread.right).toBeLessThan(24);
    expect(Math.abs(spread.left - spread.right)).toBeLessThanOrEqual(1);
    // A stop added anywhere on the bar (not just its middle) is the picked one.
    const bar = (await popup.locator('.wm-grad-bar').boundingBox())!;
    await app.page.mouse.click(bar.x + bar.width * 0.3, bar.y + bar.height / 2);
    await expect(stops).toHaveCount(3);
    await expect(popup.getByRole('button', { name: 'Color stop 2' })).toHaveAttribute('aria-pressed', 'true');
    // Its marker is dragged along the bar, and it stays picked.
    const marker = (await popup.getByRole('button', { name: 'Color stop 2' }).boundingBox())!;
    await app.page.mouse.move(marker.x + marker.width / 2, marker.y + marker.height / 2);
    await app.page.mouse.down();
    await app.page.mouse.move(bar.x + bar.width * 0.7, marker.y + marker.height / 2, { steps: 6 });
    await app.page.mouse.up();
    await expect(popup.getByLabel('Position')).toHaveValue('70');
    await expect(popup.getByRole('button', { name: 'Color stop 2' })).toHaveAttribute('aria-pressed', 'true');
    // A click on the first marker picks it, and a palette colour colours that stop.
    await popup.getByRole('button', { name: 'Color stop 1' }).click();
    await expect(popup.getByRole('button', { name: 'Color stop 1' })).toHaveAttribute('aria-pressed', 'true');
    await expect(popup.getByLabel('Position')).toHaveValue('0');
    await popup.getByRole('button', { name: '#0000FF' }).click();
    await expect.poll(() => popup.getByRole('button', { name: 'Color stop 1' }).evaluate((e) => (e as HTMLElement).style.getPropertyValue('--stop').toLowerCase())).toBe('#0000ff');
    // With three stops, even an end can be deleted; two always stay.
    await popup.getByRole('button', { name: 'Delete Stop' }).click();
    await expect(stops).toHaveCount(2);
    await expect(popup.getByRole('button', { name: 'Delete Stop' })).toBeDisabled();
    // The blue first stop went; the moved stop (now first) and the last are left.
    await expect.poll(async () => (await currentSvg(app)).match(/<linearGradient[\s\S]*?<\/linearGradient>/)?.[0].match(/offset="[^"]*"/g), { timeout: 15_000 }).toEqual(['offset="0.7"', 'offset="1"']);
  });
});

test.describe('layers', () => {
  test('New Layer adds a layer on top, and what is drawn next goes on it', async ({ app }) => {
    await openDrawing(app);
    const tree = app.page.getByRole('tree', { name: 'Layers' });
    await app.page.locator('.wm-layers-bar').getByRole('button', { name: 'New Layer' }).click();
    await expect(tree.getByRole('treeitem')).toHaveCount(3);
    await expect(tree.getByRole('treeitem').first()).toContainText('Layer 1');
    await app.toolbarButton(/^Rectangle$/).click();
    const from = await onPage(app, 0.1, 0.6);
    const to = await onPage(app, 0.4, 0.95);
    await app.page.mouse.move(from.x, from.y);
    await app.page.mouse.down();
    await app.page.mouse.move(to.x, to.y, { steps: 4 });
    await app.page.mouse.up();
    // The rectangle is in the layer: one more row, and the file has it inside the layer's group.
    await expect(tree.getByRole('treeitem')).toHaveCount(4);
    await expect.poll(async () => /<g [^>]*inkscape:groupmode="layer"[^>]*>\s*<rect/.test(await currentSvg(app)), { timeout: 15_000 }).toBe(true);
  });

  test('New Group adds an empty group when nothing is picked, and groups what is picked otherwise', async ({ app }) => {
    await openDrawing(app);
    const rows = app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem');
    const newGroup = app.page.locator('.wm-layers-bar').getByRole('button', { name: 'New Group' });
    await newGroup.click();
    await expect(rows).toHaveCount(3);
    // Pick the rectangle and the circle: the same button groups them.
    const rect = await onPage(app, 0.25, 0.4);
    const circle = await onPage(app, 0.75, 0.5);
    await app.page.mouse.click(rect.x, rect.y);
    await app.page.keyboard.down('Shift');
    await app.page.mouse.click(circle.x, circle.y);
    await app.page.keyboard.up('Shift');
    await newGroup.click();
    // The two shapes are in a group now, beside the empty one: three groups' worth of rows, the shapes nested.
    await expect.poll(async () => (await currentSvg(app)).match(/<g[ >]/g)?.length ?? 0, { timeout: 15_000 }).toBe(2);
  });
});

test.describe('free drawing', () => {
  test('the Nudge tool shows a strip with Size and Strength, and [ and ] resize the brush', async ({ app }) => {
    await openDrawing(app);
    const strip = app.page.getByRole('toolbar', { name: 'Tool options' });
    await expect(strip).toBeHidden();
    await app.toolbarButton(/^Nudge$/).click();
    await expect(strip).toBeVisible();
    const size = strip.getByRole('slider', { name: 'Size' });
    const strength = strip.getByRole('slider', { name: 'Strength' });
    await expect(size).toHaveValue('36');
    await expect(strength).toHaveValue('100');
    // The keys act on the drawing, not on the slider that had the click.
    const at = await onPage(app, 0.5, 0.5);
    await app.page.mouse.move(at.x, at.y);
    await app.page.keyboard.press(']');
    await expect(size).toHaveValue('43');
    await app.page.keyboard.press('[');
    await expect(size).toHaveValue('34');
    await strength.fill('40');
    await expect(strength).toHaveValue('40');
    await app.toolbarButton(/^Select$/).click();
    await expect(strip).toBeHidden();
    await app.page.evaluate(() => localStorage.removeItem('vector.nudgeStrength'));
  });

  test('the Pencil draws a smooth path through the points the pointer went through, and stays picked for the next', async ({ app }) => {
    await openDrawing(app);
    await app.toolbarButton(/^Pencil$/).click();
    const stroke = async (fy: number) => {
      const start = await onPage(app, 0.1, fy);
      await app.page.mouse.move(start.x, start.y);
      await app.page.mouse.down();
      for (let i = 1; i <= 24; i++) {
        const p = await onPage(app, 0.1 + i * 0.03, fy + Math.sin(i / 3) * 0.08);
        await app.page.mouse.move(p.x, p.y);
      }
      await app.page.mouse.up();
    };
    await stroke(0.85);
    const layers = app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem');
    await expect(layers).toHaveCount(3);
    await expect
      .poll(
        async () => {
          const d = /<path d="(M[^"]*)"/.exec(await currentSvg(app))?.[1] ?? '';
          // Dozens of pointer points, a few curves.
          return /^M[^C]*C/.test(d) && (d.match(/C/g)?.length ?? 0) < 10;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    // Still the pencil: the next stroke is another path, not a click on the first.
    await stroke(0.7);
    await expect(layers).toHaveCount(4);
  });

  test('the Pencil with the Pen Pressure stroke follows how hard a tablet’s pen is pressed', async ({ app }) => {
    await openDrawing(app);
    await app.toolbarButton(/^Pencil$/).click();
    await app.page.getByRole('button', { name: 'Stroke Style' }).click();
    await app.page.getByRole('listbox', { name: 'Stroke Style' }).getByRole('option', { name: 'Pen Pressure' }).click();
    // Light at the start, pressed hard at the end: the ready-made stroke would thin out again there.
    const points = [];
    for (let i = 0; i <= 24; i++) points.push({ ...(await onPage(app, 0.1 + i * 0.03, 0.85)), pressure: 0.1 + (0.9 * i) / 24 });
    await penStroke(app.page, points);
    await expect
      .poll(
        async () => {
          const attr = /data-golem-brush="([^"]*)"/.exec(await currentSvg(app))?.[1];
          if (!attr) return false;
          const profile = (JSON.parse(attr.replace(/&quot;/g, '"')) as { profile: [number, number][] }).profile;
          return profile[0][1] < 0.3 && profile[profile.length - 1][1] > 0.8;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  });

  test('a plain Pencil line drawn with a tablet’s pen follows the pressure, and Tools ▸ Options can turn that off', async ({ app }) => {
    await openDrawing(app);
    await app.toolbarButton(/^Pencil$/).click();
    const stroke = async (fy: number) => {
      const points = [];
      for (let i = 0; i <= 24; i++) points.push({ ...(await onPage(app, 0.1 + i * 0.03, fy)), pressure: 0.1 + (0.9 * i) / 24 });
      await penStroke(app.page, points);
    };
    const brushes = async () => [...(await currentSvg(app)).matchAll(/data-golem-brush="([^"]*)"/g)].map((m) => JSON.parse(m[1].replace(/&quot;/g, '"')) as { preset: string; profile: [number, number][] });
    await stroke(0.85);
    await expect
      .poll(async () => {
        const [brush] = await brushes();
        return !!brush && brush.preset === 'pressure' && brush.profile[0][1] < 0.3 && brush.profile[brush.profile.length - 1][1] > 0.8;
      }, { timeout: 15_000 })
      .toBe(true);
    // The Stroke Style list shows what the line became.
    await expect(app.page.getByRole('button', { name: 'Stroke Style' })).toBeVisible();

    await app.menu('Tools', 'Options');
    const options = app.page.getByRole('dialog', { name: 'Options' });
    const pressure = options.getByRole('checkbox', { name: /harder a tablet’s pen is pressed/ });
    await expect(pressure).toBeChecked();
    await pressure.uncheck();
    await options.getByRole('button', { name: 'OK' }).click();
    await expect(options).toHaveCount(0);
    expect(await app.page.evaluate(() => localStorage.getItem('vector.penPressure'))).toBe('off');
    await app.toolbarButton(/^Pencil$/).click();
    await stroke(0.7);
    // Off: the second stroke is an ordinary line of one width.
    await expect(app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem')).toHaveCount(4);
    await expect.poll(async () => (await brushes()).length, { timeout: 15_000 }).toBe(1);
    await app.page.evaluate(() => localStorage.removeItem('vector.penPressure'));
  });

  test('Drawing ▸ Lock Guides keeps a guide where it is, and Show Guides hides the guides without removing them', async ({ app }) => {
    await openDrawing(app);
    const guides = async () => /data-golem-guides="([^"]*)"/.exec(await currentSvg(app))?.[1] ?? '';
    await app.menu('Drawing', 'Add Vertical Guide');
    await expect.poll(guides, { timeout: 15_000 }).not.toBe('');
    const before = await guides();
    const drag = async (fx: number, to: number) => {
      const from = await onPage(app, fx, 0.95);
      const end = await onPage(app, to, 0.95);
      await app.page.mouse.move(from.x, from.y);
      await app.page.mouse.down();
      await app.page.mouse.move((from.x + end.x) / 2, end.y);
      await app.page.mouse.move(end.x, end.y);
      await app.page.mouse.up();
    };
    // Locked: the pointer passes through it.
    await app.menu('Drawing', 'Lock Guides');
    await drag(0.5, 0.65);
    await expect(app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem')).toHaveCount(2);
    expect(await guides()).toBe(before);
    // Unlocked: it is dragged.
    await app.menu('Drawing', 'Lock Guides');
    await drag(0.5, 0.65);
    await expect.poll(guides, { timeout: 15_000 }).not.toBe(before);
    // Hidden, the guides stay in the file; the menu shows the state, and adding one shows them again.
    const moved = await guides();
    await app.menu('Drawing', 'Show Guides');
    expect(await guides()).toBe(moved);
    expect(await app.page.evaluate(() => localStorage.getItem('vector.showGuides'))).toBe('off');
    await app.menu('Drawing', 'Add Horizontal Guide');
    await expect.poll(() => app.page.evaluate(() => localStorage.getItem('vector.showGuides'))).toBe('on');
  });

  test('Tools ▸ Options ▸ Drawing: with "select after pencil" off a finished stroke is not selected, and the setting is kept', async ({ app }) => {
    await openDrawing(app);
    await app.menu('Tools', 'Options');
    const options = app.page.getByRole('dialog', { name: 'Options' });
    const select = options.getByRole('checkbox', { name: 'Select a pencil stroke when it is finished' });
    await expect(select).toBeChecked();
    await expect(options.getByRole('checkbox', { name: /Switch back to the Select tool/ })).toBeChecked();
    await expect(options.getByRole('combobox', { name: 'Pencil smoothing' })).toHaveValue('medium');
    await select.uncheck();
    await options.getByRole('button', { name: 'OK' }).click();
    await expect(options).toHaveCount(0);

    await app.toolbarButton(/^Pencil$/).click();
    const start = await onPage(app, 0.1, 0.85);
    await app.page.mouse.move(start.x, start.y);
    await app.page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      const p = await onPage(app, 0.1 + i * 0.05, 0.85);
      await app.page.mouse.move(p.x, p.y);
    }
    await app.page.mouse.up();
    const layers = app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem');
    await expect(layers).toHaveCount(3);
    await expect(layers.locator('xpath=self::*[@aria-selected="true"]')).toHaveCount(0);
    // The choice is stored where the account sync picks it up.
    expect(await app.page.evaluate(() => localStorage.getItem('vector.selectAfterPencil'))).toBe('off');
    // The Drawing menu shows it too.
    await app.menubar.getByRole('menuitem', { name: 'Drawing' }).click();
    await expect(app.page.getByRole('menu').getByRole('menuitemcheckbox', { name: 'Select After Pencil' })).not.toBeChecked();
  });
});

test.describe('groups', () => {
  const GROUPED = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">
    <g id="pair"><rect id="left" x="20" y="20" width="120" height="80" fill="#e53935"/><circle id="right" cx="300" cy="100" r="60" fill="#43a047"/></g>
  </svg>`;

  async function open(app: App): Promise<void> {
    await app.blank();
    await importFile(app, { name: 'grouped.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(GROUPED) });
    await app.menubar.getByRole('menuitem', { name: 'Drawing' }).waitFor({ timeout: 30_000 });
    await expect(app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem')).toHaveCount(3, { timeout: 30_000 });
  }

  test('a click picks the group, Ctrl-click the shape inside it, and a double click goes into the group', async ({ app }) => {
    await open(app);
    const rows = app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem');
    const group = rows.filter({ hasText: 'pair' });
    const inner = rows.filter({ hasText: 'left' });
    const at = await onPage(app, 0.2, 0.4);
    await app.page.mouse.click(at.x, at.y);
    await expect(group).toHaveAttribute('aria-selected', 'true');
    await expect(inner).toHaveAttribute('aria-selected', 'false');
    // Ctrl (or Cmd) goes straight to the shape.
    await app.page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
    await app.page.mouse.click(at.x, at.y);
    await app.page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
    await expect(inner).toHaveAttribute('aria-selected', 'true');
    await expect(group).toHaveAttribute('aria-selected', 'false');
    // Clear, then a double click enters the group: the next click picks a child.
    await app.press('Escape');
    await app.page.waitForTimeout(600);
    await app.page.mouse.dblclick(at.x, at.y);
    await expect(rows.filter({ hasText: 'pair' })).toHaveAttribute('aria-selected', 'false');
    await app.page.waitForTimeout(600);
    await app.page.mouse.click(at.x, at.y);
    await expect(inner).toHaveAttribute('aria-selected', 'true');
    // Escape goes back out, with the group picked.
    await app.press('Escape');
    await expect(group).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('overlapping shapes', () => {
  const STACK = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">
    <rect id="bottom" x="20" y="20" width="200" height="150" fill="#e53935"/>
    <rect id="middle" x="60" y="40" width="200" height="120" fill="#43a047"/>
    <rect id="top" x="100" y="60" width="200" height="100" fill="#1e88e5"/>
  </svg>`;

  test('Ctrl+Alt+click picks the shape underneath, one at a time, and round to the top again', async ({ app }) => {
    await app.blank();
    await importFile(app, { name: 'stack.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(STACK) });
    await app.menubar.getByRole('menuitem', { name: 'Drawing' }).waitFor({ timeout: 30_000 });
    const rows = app.page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem');
    await expect(rows).toHaveCount(3, { timeout: 30_000 });
    const selected = async () => (await rows.evaluateAll((els) => els.filter((e) => e.getAttribute('aria-selected') === 'true').map((e) => e.textContent ?? ''))).map((t) => t.replace(/\s+/g, ' ').trim());
    const at = await onPage(app, 0.4, 0.6); // inside all three
    await app.page.mouse.click(at.x, at.y);
    // The layers panel follows the click a frame or two later.
    await expect.poll(selected).toEqual(['top']);
    const control = process.platform === 'darwin' ? 'Meta' : 'Control';
    const underneath = async () => {
      await app.page.keyboard.down(control);
      await app.page.keyboard.down('Alt');
      await app.page.mouse.click(at.x, at.y);
      await app.page.keyboard.up('Alt');
      await app.page.keyboard.up(control);
    };
    await underneath();
    await expect.poll(selected).toEqual(['middle']);
    await underneath();
    await expect.poll(selected).toEqual(['bottom']);
    await underneath();
    await expect.poll(selected).toEqual(['top']);
  });
});

test.describe('the canvas', () => {
  test('Canvas Size changes the page, keeping the proportions, and Fit to Artwork shrinks it to the shapes', async ({ app }) => {
    await openDrawing(app);
    // The page is the first row of the layers list, and opens the same dialog.
    await app.page.getByRole('tree', { name: 'Layers' }).getByRole('button', { name: 'Canvas Size' }).click();
    const dialog = app.page.getByRole('dialog', { name: 'Canvas Size' });
    await expect(dialog).toContainText('Now 400 × 200 pixels');
    await dialog.getByRole('spinbutton', { name: 'Width' }).fill('800');
    await expect(dialog.getByRole('spinbutton', { name: 'Height' })).toHaveValue('400');
    await dialog.getByRole('button', { name: 'OK' }).click();
    await expect.poll(async () => (await currentSvg(app)).includes('width="800" height="400"'), { timeout: 15_000 }).toBe(true);
    expect(await pageBoxes(app.page)).toEqual([{ width: 600, height: 300 }]);
    await app.menu('Drawing', 'Canvas Size');
    await app.page.getByRole('dialog', { name: 'Canvas Size' }).getByRole('button', { name: 'Fit to Artwork' }).click();
    // The shapes span 20 to 360 across and 20 to 160 down (the rectangle’s bottom is 100, the circle’s is 160).
    await expect.poll(async () => (await currentSvg(app)).includes('viewBox="20 20 340 140"'), { timeout: 15_000 }).toBe(true);
  });
});

test.describe('the Canvas tool', () => {
  test('dragging the right edge of the page makes it wider, and the shapes stay where they are', async ({ app }) => {
    await openDrawing(app);
    await app.toolbarButton(/^Canvas$/).click();
    const from = await onPage(app, 1, 0.5);
    await app.page.mouse.move(from.x, from.y);
    await app.page.mouse.down();
    await app.page.mouse.move(from.x + 40, from.y, { steps: 4 });
    await app.page.mouse.move(from.x + 75, from.y, { steps: 4 });
    await app.page.mouse.up();
    await expect.poll(async () => /<svg[^>]* width="(\d+)"/.exec(await currentSvg(app))?.[1] !== '400', { timeout: 15_000 }).toBe(true);
    const svg = await currentSvg(app);
    expect(Number(/<svg[^>]* width="(\d+)"/.exec(svg)![1])).toBeGreaterThan(410);
    expect(svg).toMatch(/<svg[^>]* height="200"/);
    // The shapes are where they were.
    expect(svg).toContain('x="20" y="20"');
  });
});

test.describe('converting a drawing', () => {
  test('to PDF it becomes a one-page PDF', async ({ app }) => {
    await openDrawing(app);
    await app.menu('File', 'Convert To', 'PDF (.pdf)');
    await app.page.waitForFunction(() => (window as unknown as { pages: unknown[] }).pages.length === 1, null, { timeout: 30_000 });
    await expect(app.page.getByRole('combobox', { name: 'Format' }).first()).toHaveValue(/PDF/);
  });

  test('a Word document becomes an SVG drawing with its text as text', async ({ app }) => {
    await app.blank();
    await app.type('Hello vector world');
    await app.menu('File', 'Convert To', 'SVG Drawing (.svg)');
    await app.menubar.getByRole('menuitem', { name: 'Drawing' }).waitFor({ timeout: 30_000 });
    await expect.poll(async () => (await currentSvg(app)).includes('<text'), { timeout: 30_000 }).toBe(true);
    expect(await currentSvg(app)).toContain('Hello');
  });
});
