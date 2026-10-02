import { expect, test } from '../fixtures';
import { currentPicture, dialog, expectPicture, makePng, openPicture, pageBoxes, pixelAt, pngSize, type Rgba } from './helpers';

/** Red on the left to blue on the right (120 × 60). */
const GRADIENT = makePng(120, 60);
/** Red at the top to blue at the bottom, the same across (60 × 120). */
const VERTICAL = makePng(60, 120, (_x, y) => [Math.round(255 - (255 * y) / 119), 40, Math.round((255 * y) / 119), 255]);
const red = (p: Rgba) => p[0] - p[2];

test.describe('opening a picture as a document', () => {
  test('a PNG opens as one page the size of the picture, with the Picture menu and toolbars', async ({ app }) => {
    await openPicture(app, GRADIENT, 'grad.png');
    expect(await pageBoxes(app.page)).toEqual([{ width: 90, height: 45 }]);
    await expect(app.menubar.getByRole('menuitem', { name: 'Picture' })).toBeVisible();
    // A picture has no Format or Table menus.
    await expect(app.menubar.getByRole('menuitem', { name: 'Table' })).toHaveCount(0);
    await expect(app.menubar.getByRole('menuitem', { name: 'Format' })).toHaveCount(0);
    for (const name of ['Rotate Left', 'Rotate Right', 'Flip Horizontal', 'Flip Vertical', 'Crop', 'Resize', 'Adjust Colors', 'Auto Levels', 'Grayscale', 'Sepia', 'Invert Colors', 'Blur', 'Sharpen']) {
      await expect(app.toolbarButton(name)).toBeEnabled();
    }
    const img = await currentPicture(app);
    expect(img).toMatchObject({ width: 120, height: 60 });
    // Left is red, right is blue, as made.
    expect(red(pixelAt(img, 2, 30))).toBeGreaterThan(150);
    expect(red(pixelAt(img, 117, 30))).toBeLessThan(-150);
  });

  // Suspected bug: typing into a picture document is accepted (the text lands in the model behind the picture, unseen).
  test.fixme('a picture is not text: typing does not change it', async ({ app }) => {
    await openPicture(app, GRADIENT);
    await app.type('hello');
    expect(await pageBoxes(app.page)).toEqual([{ width: 90, height: 45 }]);
    expect(await app.text()).toBe('');
  });

  test('the picture menu and the toolbar buttons do the same thing', async ({ app }) => {
    await openPicture(app, GRADIENT);
    await app.menu('Picture', 'Rotate Right');
    await expectPicture(app, (i) => i.width === 60 && i.height === 120);
    await app.toolbarButton('Rotate Left').click();
    await expectPicture(app, (i) => i.width === 120 && i.height === 60);
  });
});

test.describe('rotating and flipping', () => {
  test('Rotate Right turns the picture a quarter clockwise: the red left edge becomes the top', async ({ app }) => {
    await openPicture(app, GRADIENT);
    await app.menu('Picture', 'Rotate Right');
    await expectPicture(app, (i) => i.width === 60 && i.height === 120 && red(pixelAt(i, 30, 2)) > 150 && red(pixelAt(i, 30, 117)) < -150);
    expect(await pageBoxes(app.page)).toEqual([{ width: 45, height: 90 }]);
  });

  test('Rotate Left turns it a quarter the other way: the red left edge becomes the bottom', async ({ app }) => {
    await openPicture(app, GRADIENT);
    await app.menu('Picture', 'Rotate Left');
    await expectPicture(app, (i) => i.width === 60 && i.height === 120 && red(pixelAt(i, 30, 117)) > 150 && red(pixelAt(i, 30, 2)) < -150);
  });

  test('Rotate 180° keeps the size and swaps the ends', async ({ app }) => {
    await openPicture(app, GRADIENT);
    await app.menu('Picture', 'Rotate 180°');
    await expectPicture(app, (i) => i.width === 120 && i.height === 60 && red(pixelAt(i, 2, 30)) < -150 && red(pixelAt(i, 117, 30)) > 150);
  });

  test('Flip Horizontal mirrors left to right, and does not touch top to bottom', async ({ app }) => {
    await openPicture(app, GRADIENT);
    await app.menu('Picture', 'Flip Horizontal');
    await expectPicture(app, (i) => red(pixelAt(i, 2, 30)) < -150 && red(pixelAt(i, 117, 30)) > 150);
    await app.menu('Picture', 'Flip Vertical'); // a horizontal gradient does not change
    await expectPicture(app, (i) => red(pixelAt(i, 2, 5)) < -150 && red(pixelAt(i, 117, 55)) > 150);
  });

  test('Flip Vertical mirrors top to bottom', async ({ app }) => {
    await openPicture(app, VERTICAL);
    await app.menu('Picture', 'Flip Vertical');
    await expectPicture(app, (i) => red(pixelAt(i, 30, 2)) < -150 && red(pixelAt(i, 30, 117)) > 150);
  });

  test('Undo and Redo step back and forward through the picture edits', async ({ app }) => {
    await openPicture(app, GRADIENT);
    await app.menu('Picture', 'Rotate Right');
    await expectPicture(app, (i) => i.width === 60);
    await app.menu('Picture', 'Flip Vertical');
    await expectPicture(app, (i) => i.width === 60 && red(pixelAt(i, 30, 2)) < -150);
    await app.menu('Edit', 'Undo');
    await expectPicture(app, (i) => i.width === 60 && red(pixelAt(i, 30, 2)) > 150);
    await app.menu('Edit', 'Undo');
    await expectPicture(app, (i) => i.width === 120);
    await app.menu('Edit', 'Redo');
    await expectPicture(app, (i) => i.width === 60 && red(pixelAt(i, 30, 2)) > 150);
  });
});

test.describe('Resize', () => {
  test('shows the current size, keeps the proportions while one side is typed, and resizes', async ({ app }) => {
    await openPicture(app, GRADIENT);
    await app.menu('Picture', 'Resize…');
    const dlg = dialog(app, 'Resize Picture');
    await expect(dlg.getByText('Now 120 × 60 pixels')).toBeVisible();
    await expect(dlg.getByRole('spinbutton', { name: 'Width' })).toHaveValue('120');
    await expect(dlg.getByRole('spinbutton', { name: 'Height' })).toHaveValue('60');
    await dlg.getByRole('spinbutton', { name: 'Width' }).fill('60');
    await expect(dlg.getByRole('spinbutton', { name: 'Height' })).toHaveValue('30');
    await dlg.getByRole('spinbutton', { name: 'Height' }).fill('15');
    await expect(dlg.getByRole('spinbutton', { name: 'Width' })).toHaveValue('30');
    await dlg.getByRole('spinbutton', { name: 'Width' }).fill('60');
    await dlg.getByRole('button', { name: 'OK' }).click();
    await expectPicture(app, (i) => i.width === 60 && i.height === 30);
    const [page] = await pageBoxes(app.page);
    expect(page.width / page.height).toBeCloseTo(2, 1);
  });

  test('without "Keep proportions" the sides are independent', async ({ app }) => {
    await openPicture(app, GRADIENT);
    await app.menu('Picture', 'Resize…');
    const dlg = dialog(app, 'Resize Picture');
    await dlg.getByRole('checkbox', { name: 'Keep proportions' }).uncheck();
    await dlg.getByRole('spinbutton', { name: 'Width' }).fill('50');
    await dlg.getByRole('spinbutton', { name: 'Height' }).fill('80');
    await expect(dlg.getByRole('spinbutton', { name: 'Width' })).toHaveValue('50');
    await dlg.getByRole('button', { name: 'OK' }).click();
    await expectPicture(app, (i) => i.width === 50 && i.height === 80);
  });

  test('Cancel and an empty size change nothing', async ({ app }) => {
    await openPicture(app, GRADIENT);
    await app.menu('Picture', 'Resize…');
    const dlg = dialog(app, 'Resize Picture');
    await dlg.getByRole('spinbutton', { name: 'Width' }).fill('0');
    await dlg.getByRole('button', { name: 'OK' }).click();
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg).toHaveCount(0);
    expect(await pageBoxes(app.page)).toEqual([{ width: 90, height: 45 }]);
    // OK with the size as it is changes nothing either.
    await app.menu('Picture', 'Resize…');
    await dialog(app, 'Resize Picture').getByRole('button', { name: 'OK' }).click();
    const img = await currentPicture(app);
    expect(pngSize(img.bytes)).toEqual({ width: 120, height: 60 });
  });
});

test.describe('Adjust Colors', () => {
  const GREY = makePng(40, 40, () => [100, 100, 100, 255]);

  test('brightness lightens, with a preview, and the Reset button sets the sliders back', async ({ app }) => {
    await openPicture(app, GREY);
    await app.menu('Picture', 'Adjust Colors…');
    const dlg = dialog(app, 'Adjust Colors');
    await expect(dlg.locator('canvas')).toBeVisible();
    const brightness = dlg.getByRole('slider', { name: 'Brightness' });
    await brightness.fill('60');
    await expect(dlg.getByText('60', { exact: true })).toBeVisible();
    await dlg.getByRole('button', { name: 'Reset' }).click();
    await expect(brightness).toHaveValue('0');
    await brightness.fill('60');
    await dlg.getByRole('button', { name: 'OK' }).click();
    await expectPicture(app, (i) => pixelAt(i, 20, 20)[0] > 130);
  });

  test('contrast and saturation change the pixels; zero everywhere changes nothing', { tag: '@heavy' }, async ({ app }) => {
    await openPicture(app, makePng(40, 40, () => [200, 100, 50, 255]));
    await app.menu('Picture', 'Adjust Colors…');
    let dlg = dialog(app, 'Adjust Colors');
    await dlg.getByRole('slider', { name: 'Saturation' }).fill('-100');
    await dlg.getByRole('button', { name: 'OK' }).click();
    await expectPicture(app, (i) => {
      const [r, g, b] = pixelAt(i, 20, 20);
      return Math.abs(r - g) < 6 && Math.abs(g - b) < 6;
    });
    await app.menu('Picture', 'Adjust Colors…');
    dlg = dialog(app, 'Adjust Colors');
    await dlg.getByRole('button', { name: 'OK' }).click();
    await expect(dlg).toHaveCount(0);
    await app.menu('Edit', 'Undo');
    await expectPicture(app, (i) => pixelAt(i, 20, 20)[0] - pixelAt(i, 20, 20)[2] > 100);
  });

  test('Cancel leaves the picture alone', async ({ app }) => {
    await openPicture(app, GREY);
    await app.menu('Picture', 'Adjust Colors…');
    const dlg = dialog(app, 'Adjust Colors');
    await dlg.getByRole('slider', { name: 'Contrast' }).fill('80');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    const img = await currentPicture(app);
    expect(pixelAt(img, 20, 20).slice(0, 3)).toEqual([100, 100, 100]);
  });
});

test.describe('effects', () => {
  const COLOR = makePng(40, 40, () => [200, 100, 50, 255]);
  const STRIPES = makePng(40, 40, (x) => (x < 20 ? [0, 0, 0, 255] : [255, 255, 255, 255]));

  test('Grayscale makes every pixel grey', async ({ app }) => {
    await openPicture(app, GRADIENT);
    await app.menu('Picture', 'Grayscale');
    await expectPicture(app, (i) => {
      const [r, g, b] = pixelAt(i, 10, 10);
      const [r2, g2, b2] = pixelAt(i, 100, 30);
      return Math.abs(r - g) <= 2 && Math.abs(g - b) <= 2 && Math.abs(r2 - g2) <= 2 && Math.abs(g2 - b2) <= 2 && r !== r2;
    });
  });

  test('Sepia warms the picture: red above green above blue', async ({ app }) => {
    await openPicture(app, makePng(40, 40, () => [120, 120, 120, 255]));
    await app.menu('Picture', 'Sepia');
    await expectPicture(app, (i) => {
      const [r, g, b] = pixelAt(i, 20, 20);
      return r > g && g > b && r - b > 30;
    });
  });

  test('Invert Colors turns each colour into its opposite', async ({ app }) => {
    await openPicture(app, COLOR);
    await app.menu('Picture', 'Invert Colors');
    await expectPicture(app, (i) => {
      const [r, g, b] = pixelAt(i, 20, 20);
      return Math.abs(r - 55) <= 2 && Math.abs(g - 155) <= 2 && Math.abs(b - 205) <= 2;
    });
  });

  test('Blur softens a hard edge and Sharpen hardens a soft one', async ({ app }) => {
    await openPicture(app, STRIPES);
    await app.menu('Picture', 'Blur');
    await expectPicture(app, (i) => {
      const left = pixelAt(i, 19, 20)[0];
      const right = pixelAt(i, 20, 20)[0];
      return left > 10 && right < 245;
    });
    await app.menu('Picture', 'Sharpen');
    await expectPicture(app, (i) => {
      const a = pixelAt(i, 18, 20)[0];
      const b = pixelAt(i, 21, 20)[0];
      return b - a > 200; // the step from dark to light is steeper than the blurred one
    });
  });

  test('Auto Levels stretches a low-contrast picture to the full range', async ({ app }) => {
    await openPicture(app, makePng(40, 40, (x) => (x < 20 ? [100, 100, 100, 255] : [150, 150, 150, 255])));
    await app.menu('Picture', 'Auto Levels');
    await expectPicture(app, (i) => pixelAt(i, 5, 20)[0] < 30 && pixelAt(i, 35, 20)[0] > 225);
  });
});

test.describe('Crop', () => {
  const BIG = makePng(400, 300, (x, y) => [Math.round((255 * x) / 399), Math.round((255 * y) / 299), 80, 255]);

  test('starts a box a little in from the edges and Crop cuts the picture to it', async ({ app }) => {
    await openPicture(app, BIG);
    await app.menu('Picture', 'Crop…');
    const layer = app.page.locator('.wm-crop');
    await expect(layer).toBeVisible();
    await expect(layer.locator('.wm-crop-size')).toHaveText('352 × 252');
    await expect(layer.locator('.wm-crop-handle')).toHaveCount(8);
    await layer.getByRole('button', { name: 'Crop', exact: true }).click();
    await expect(layer).toBeHidden();
    await expectPicture(app, (i) => i.width === 352 && i.height === 252);
    // The top-left of the cropped picture is the original's pixel (24, 24).
    const img = await currentPicture(app);
    expect(pixelAt(img, 0, 0)[0]).toBeGreaterThan(10);
  });

  test('a shape fixes the box\'s proportions', async ({ app }) => {
    await openPicture(app, BIG);
    await app.menu('Picture', 'Crop…');
    const layer = app.page.locator('.wm-crop');
    await layer.getByRole('combobox', { name: 'Shape' }).selectOption({ label: '1:1' });
    const text = await layer.locator('.wm-crop-size').textContent();
    const [w, h] = text!.split(' × ').map(Number);
    expect(Math.abs(w - h)).toBeLessThanOrEqual(1);
    await layer.getByRole('button', { name: 'Crop', exact: true }).click();
    await expectPicture(app, (i) => Math.abs(i.width - i.height) <= 1 && i.width < 300);
  });

  test('dragging a handle resizes the box; Enter applies it', async ({ app }) => {
    await openPicture(app, BIG);
    await app.menu('Picture', 'Crop…');
    const layer = app.page.locator('.wm-crop');
    await expect(layer).toBeVisible();
    const handle = layer.locator('[data-handle="se"]');
    const box = (await handle.boundingBox())!;
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    // Picture pixels are 0.75 pt = 1 css px at 100% zoom: drag 100 px left and 50 up.
    await app.page.mouse.move(from.x, from.y);
    await app.page.mouse.down();
    await app.page.mouse.move(from.x - 50, from.y - 25, { steps: 3 });
    await app.page.mouse.move(from.x - 100, from.y - 50, { steps: 3 });
    await app.page.mouse.up();
    await expect(layer.locator('.wm-crop-size')).not.toHaveText('352 × 252');
    const [w, h] = (await layer.locator('.wm-crop-size').textContent())!.split(' × ').map(Number);
    expect(w).toBeLessThan(352);
    expect(h).toBeLessThan(252);
    await app.page.keyboard.press('Enter');
    await expectPicture(app, (i) => Math.abs(i.width - w) <= 1 && Math.abs(i.height - h) <= 1);
  });

  test('Cancel and Escape leave the picture as it was', async ({ app }) => {
    await openPicture(app, BIG);
    await app.menu('Picture', 'Crop…');
    const layer = app.page.locator('.wm-crop');
    await layer.getByRole('button', { name: 'Cancel' }).click();
    await expect(layer).toBeHidden();
    await app.menu('Picture', 'Crop…');
    await expect(layer).toBeVisible();
    await app.page.keyboard.press('Escape');
    await expect(layer).toBeHidden();
    expect(pngSize((await currentPicture(app)).bytes)).toEqual({ width: 400, height: 300 });
  });
});
