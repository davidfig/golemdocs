// A picture that carries an SVG (a drawing, as a PDF's vector art becomes in Word) is drawn from the SVG by the
// app's own painter at the size it is shown at, and drawn again when the zoom changes, so it stays sharp.
// The picture's bitmap here is a flat gray 4 x 4 square: anything else on screen came from the SVG.

import { WordDocument, type Paragraph } from '../../docx/src/index.ts';
import { expect, test } from '../fixtures';
import { importFile } from '../files/helpers';
import { look, makePng, pictureBox } from './helpers';

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120">
  <defs><pattern id="dots" patternUnits="userSpaceOnUse" x="0" y="0" width="10" height="10" viewBox="0 0 10 10"><rect width="5" height="5" fill="#0a0"/></pattern></defs>
  <rect x="20" y="20" width="60" height="80" fill="#00c"/>
  <circle cx="140" cy="60" r="40" fill="url(#dots)"/>
</svg>`;

async function drawingDocx(): Promise<Buffer> {
  const doc = await WordDocument.create();
  const image = doc.addImage(new Uint8Array(makePng(4, 4, () => [128, 128, 128, 255])), 'png');
  const svg = doc.addImage(new TextEncoder().encode(SVG), 'svg');
  const paragraph: Paragraph = {
    kind: 'paragraph',
    properties: {},
    children: [{ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'drawing', inline: true, width: 200 * 12700, height: 120 * 12700, image, svg, name: 'Drawing 1' }] }],
    attrs: {},
  };
  doc.body = [paragraph];
  return Buffer.from(await doc.write());
}

const isBlue = (p: number[]) => p[0] < 40 && p[1] < 40 && p[2] > 150;

test.describe('drawings in a document', () => {
  test('are drawn from their SVG, not their bitmap, and stay sharp as the zoom changes', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await importFile(app, { name: 'drawing.docx', buffer: await drawingDocx() });
    await page.waitForFunction(() => (window as unknown as { pages: { images: unknown[] }[] }).pages[0]?.images.length > 0);
    // At rest at 100%: the blue square (the SVG's) is there, not the bitmap's gray.
    let box = await pictureBox(page);
    await expect.poll(async () => isBlue((await look<number[][]>(page, box, 'points', [[box.x + 0.25 * box.width, box.y + 0.5 * box.height]]))[0])).toBe(true);

    // Zooming in step by step shows the picture all along (the texture on screen is scaled meanwhile), ...
    // (about the square, so it stays in view)
    const center = { x: box.x + 0.25 * box.width, y: box.y + 0.5 * box.height };
    for (let i = 0; i < 6; i++) {
      await page.evaluate(async ({ x, y }) => {
        const w = window as unknown as { camera: { zoomAt(x: number, y: number, f: number): void }; requestRender(): void };
        const canvas = document.getElementById('canvas')!.getBoundingClientRect();
        w.camera.zoomAt(x - canvas.left, y - canvas.top, 1.4);
        w.requestRender();
        // The frame is drawn (and the view kept over the document) before the picture is looked at.
        await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      }, center);
      box = await pictureBox(page);
      // The square is still there, if blurry for a moment: its middle is blue.
      expect(isBlue((await look<number[][]>(page, { ...box, width: Math.min(box.width, 1000), height: Math.min(box.height, 700) }, 'points', [[box.x + 0.25 * box.width, box.y + 0.5 * box.height]]))[0])).toBe(true);
    }
    // ... and once it rests it is drawn again for this size: the square's left edge is a clean step.
    await page.waitForTimeout(900);
    box = await pictureBox(page);
    const edge = box.x + (20 / 200) * box.width; // the square's left edge
    const colors = await look<number[][]>(page, box, 'row', { y: box.y + 0.5 * box.height, from: edge - 8, to: edge + 8 });
    const mixed = colors.filter((p) => !(p[0] > 235 && p[1] > 235 && p[2] > 235) && !isBlue(p)).length;
    expect(mixed).toBeLessThanOrEqual(3);
  });

  test('a tiling pattern in the SVG is drawn', async ({ app, page }) => {
    await app.goto('?doc=welcome');
    await importFile(app, { name: 'drawing.docx', buffer: await drawingDocx() });
    await page.waitForFunction(() => (window as unknown as { pages: { images: unknown[] }[] }).pages[0]?.images.length > 0);
    const box = await pictureBox(page);
    await expect.poll(async () => (await look<number>(page, box, 'green', null)) > 40).toBe(true);
  });
});
