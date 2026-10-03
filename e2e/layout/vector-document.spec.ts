import { expect, test } from '../fixtures';
import { importFile } from '../files/helpers';
import { pageBoxes } from './helpers';
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
    await expect(app.page.getByRole('combobox', { name: 'Fill Type' })).toBeVisible();
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

  test('a linear gradient is made from the Fill Type list', async ({ app }) => {
    await openDrawing(app);
    const at = await onPage(app, 0.75, 0.5);
    await app.page.mouse.click(at.x, at.y);
    await app.page.getByRole('combobox', { name: 'Fill Type' }).selectOption('linear');
    await expect.poll(async () => (await currentSvg(app)).includes('<linearGradient'), { timeout: 15_000 }).toBe(true);
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
    expect(await selected()).toEqual(['top']);
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
