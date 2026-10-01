import { expect, test } from '../fixtures';
import type { App } from '../fixtures';
import { attrs, count, docx, importFile, makePng, pageBoxes, pngSize } from './helpers';

const EMU = 9525; // one pixel at 96 dpi
const mediaOf = (files: Map<string, Buffer>) => [...files.keys()].filter((k) => k.startsWith('word/media/'));

/** Insert ▸ Picture…, choosing `file` in the file chooser (or through the toolbar's Picture button). */
async function insertPicture(app: App, file: { name: string; mimeType: string; buffer: Buffer }, via: 'menu' | 'toolbar' = 'menu'): Promise<void> {
  const [chooser] = await Promise.all([app.page.waitForEvent('filechooser'), via === 'menu' ? app.menu('Insert', 'Picture…') : app.toolbarButton('Picture').click()]);
  await chooser.setFiles(file);
}

const png = (name: string, w: number, h: number) => ({ name, mimeType: 'image/png', buffer: makePng(w, h) });

/** Waits until the saved document holds `n` pictures. */
const pictures = (app: App, n: number) => expect.poll(async () => count((await docx(app)).xml, 'w:drawing')).toBe(n);

test.describe('Insert ▸ Picture', () => {
  test.beforeEach(async ({ app }) => {
    await app.blank();
  });

  test('puts the picture in the paragraph at the caret, at its own size, and keeps the file', async ({ app }) => {
    await app.type('Before ');
    const source = png('grad.png', 120, 60);
    await insertPicture(app, source);
    await pictures(app, 1);
    const { xml, files } = await docx(app);
    expect(attrs(xml, 'wp:extent')).toMatchObject({ cx: String(120 * EMU), cy: String(60 * EMU) });
    expect(xml).toContain('descr="grad"');
    expect(xml.indexOf('Before')).toBeLessThan(xml.indexOf('<w:drawing>'));
    const media = mediaOf(files);
    expect(media).toHaveLength(1);
    expect(media[0]).toMatch(/\.png$/);
    expect(pngSize(files.get(media[0])!)).toEqual({ width: 120, height: 60 });
    expect(files.get(media[0])!.equals(source.buffer)).toBe(true);
    // The picture is on the page.
    expect(await app.page.evaluate(() => (window as unknown as { pages: { images: unknown[] }[] }).pages[0].images.length)).toBe(1);
  });

  test('the toolbar Picture button does the same', async ({ app }) => {
    await insertPicture(app, png('t.png', 50, 50), 'toolbar');
    await pictures(app, 1);
  });

  test('a picture wider than the text is brought down to the text width, keeping its shape', async ({ app }) => {
    await insertPicture(app, png('wide.png', 1200, 600));
    await pictures(app, 1);
    const { cx, cy } = attrs((await docx(app)).xml, 'wp:extent');
    const textWidth = 6.5 * 914400;
    expect(Number(cx)).toBeLessThanOrEqual(textWidth);
    expect(Number(cx)).toBeGreaterThan(textWidth * 0.9);
    expect(Number(cx) / Number(cy)).toBeCloseTo(2, 1);
  });

  test('a tall picture makes the line tall, and text carries on after it', async ({ app }) => {
    await insertPicture(app, png('tall.png', 100, 300));
    await pictures(app, 1);
    await app.type('after');
    await expect.poll(() => app.text()).toContain('after');
    expect(await pageBoxes(app.page)).toHaveLength(1);
  });

  test('pictures can go in several places, each its own file', async ({ app }) => {
    await insertPicture(app, png('one.png', 40, 40));
    await pictures(app, 1);
    await app.type(' and ');
    await insertPicture(app, png('two.png', 60, 30));
    await pictures(app, 2);
    const { files, xml } = await docx(app);
    expect(mediaOf(files)).toHaveLength(2);
    expect(xml).toContain('descr="one"');
    expect(xml).toContain('descr="two"');
  });

  test('inserting is one undo step, and Redo brings the picture back', async ({ app }) => {
    await app.type('text');
    await insertPicture(app, png('u.png', 40, 40));
    await pictures(app, 1);
    await app.menu('Edit', 'Undo');
    await pictures(app, 0);
    await expect.poll(() => app.text()).toBe('text');
    await app.menu('Edit', 'Redo');
    await pictures(app, 1);
  });

  test('an SVG is drawn to a PNG and put in as a picture', async ({ app }) => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#e5322d"/></svg>';
    await insertPicture(app, { name: 'shape.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
    await pictures(app, 1);
    const { files } = await docx(app);
    const [media] = mediaOf(files);
    expect(media).toMatch(/\.png$/);
    // Drawn at a larger scale than its nominal size, in the same shape.
    const size = pngSize(files.get(media)!);
    expect(size.width).toBeGreaterThanOrEqual(80);
    expect(size.width / size.height).toBeCloseTo(2, 1);
  });

  test('a file that is not a picture is refused with a message and nothing is inserted', async ({ app }) => {
    await insertPicture(app, { name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('this is not a picture') });
    await expect(app.page.getByText(/Couldn.t insert the picture/).first()).toBeVisible();
    expect(count((await docx(app)).xml, 'w:drawing')).toBe(0);
  });

  test('a picture stays in the Word file: saved, opened again, it is still there, byte for byte', async ({ app }) => {
    const source = png('keep.png', 90, 45);
    await insertPicture(app, source);
    await pictures(app, 1);
    const file = await app.download(() => app.menu('File', 'Download'));
    await app.menu('File', 'New');
    await importFile(app, { name: 'with-picture.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: file.bytes });
    await pictures(app, 1);
    const { files, xml } = await docx(app);
    expect(attrs(xml, 'wp:extent')).toMatchObject({ cx: String(90 * EMU), cy: String(45 * EMU) });
    expect(files.get(mediaOf(files)[0])!.equals(source.buffer)).toBe(true);
  });

  test('a text document has no Picture menu: the picture tools are for pictures opened on their own', async ({ app }) => {
    await insertPicture(app, png('x.png', 40, 40));
    await pictures(app, 1);
    await expect(app.menubar.getByRole('menuitem', { name: 'Picture' })).toHaveCount(0);
    await expect(app.menubar.getByRole('menuitem', { name: 'Table' })).toBeVisible();
  });
});

test.describe('dropping a picture on a document', () => {
  test.beforeEach(async ({ app }) => {
    await app.blank();
  });

  async function drop(app: App, file: { name: string; buffer: Buffer }): Promise<void> {
    await app.page.evaluate(
      ({ name, bytes }) => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(bytes)], name, { type: 'image/png' }));
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
      },
      { name: file.name, bytes: [...file.buffer] },
    );
  }

  test('asks whether to insert it or open it, and "Insert in the document" inserts', async ({ app }) => {
    await drop(app, { name: 'dropped.png', buffer: makePng(64, 32) });
    const choice = app.page.getByRole('dialog', { name: 'What should be done with dropped.png?' });
    await expect(choice).toBeVisible();
    await expect(choice.getByRole('button', { name: 'Open as a picture' })).toBeVisible();
    await choice.getByRole('button', { name: 'Insert in the document' }).click();
    await pictures(app, 1);
    expect(attrs((await docx(app)).xml, 'wp:extent')).toMatchObject({ cx: String(64 * EMU) });
  });

  test('"Open as a picture" opens it as a picture document of its own', async ({ app }) => {
    await drop(app, { name: 'other.png', buffer: makePng(64, 32) });
    await app.page.getByRole('dialog', { name: /What should be done/ }).getByRole('button', { name: 'Open as a picture' }).click();
    await expect(app.menubar.getByRole('menuitem', { name: 'Picture' })).toBeVisible();
  });

  test('Cancel and Escape drop it without doing anything', async ({ app }) => {
    await drop(app, { name: 'nope.png', buffer: makePng(64, 32) });
    const choice = app.page.getByRole('dialog', { name: /What should be done/ });
    await choice.getByRole('button', { name: 'Cancel' }).click();
    await expect(choice).toHaveCount(0);
    await drop(app, { name: 'nope.png', buffer: makePng(64, 32) });
    await app.page.keyboard.press('Escape');
    await expect(choice).toHaveCount(0);
    expect(count((await docx(app)).xml, 'w:drawing')).toBe(0);
    await expect(app.menubar.getByRole('menuitem', { name: 'Picture' })).toHaveCount(0);
  });
});
