// A picture that carries an SVG (a drawing, as a PDF's vector art becomes in Word) is drawn from the SVG by the
// app's own painter at the size it is shown at, and drawn again when the zoom changes, so it stays sharp.
// The picture's bitmap here is a flat gray 4 x 4 square: anything else on screen came from the SVG.

import type { Page } from '@playwright/test';
import { WordDocument, type Paragraph } from '../../docx/src/index.ts';
import { expect, test } from '../fixtures';
import { importFile } from '../files/helpers';
import { makePng } from './helpers';

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

/** Where the picture is on screen, in CSS pixels. */
async function pictureBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate(() => {
    const w = window as unknown as { pages: { x: number; y: number; images: { x: number; y: number; width: number; height: number }[] }[]; camera: { x: number; y: number; scale: number; dpr: number } };
    const page = w.pages[0];
    const image = page.images[0];
    const k = w.camera.scale / w.camera.dpr;
    const canvas = document.getElementById('canvas')!.getBoundingClientRect();
    return { x: canvas.left + (page.x + image.x - w.camera.x) * k, y: canvas.top + (page.y + image.y - w.camera.y) * k, width: image.width * k, height: image.height * k };
  });
}

type Box = { x: number; y: number; width: number; height: number };

/** A screenshot of the box (what is on screen of it), read in the page: what `read` asks of it comes back, not the picture. Positions are CSS pixels of the page. */
async function look<T>(page: Page, box: Box, read: 'points' | 'row' | 'green', arg: unknown): Promise<T> {
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const clip = { x, y, width: Math.max(1, Math.min(box.width - (x - box.x), 1000)), height: Math.max(1, Math.min(box.height - (y - box.y), 700)) };
  const shot = (await page.screenshot({ clip })).toString('base64');
  // Positions asked for are the page's; the screenshot starts at the clip's corner.
  if (read === 'points') arg = (arg as [number, number][]).map(([ax, ay]) => [ax - clip.x, ay - clip.y]);
  if (read === 'row') arg = { y: (arg as { y: number }).y - clip.y, from: (arg as { from: number }).from - clip.x, to: (arg as { to: number }).to - clip.x };
  return page.evaluate(
    async ({ b64, read, arg }) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const at = (px: number, py: number) => {
        const o = (Math.max(0, Math.min(bitmap.height - 1, Math.round(py))) * bitmap.width + Math.max(0, Math.min(bitmap.width - 1, Math.round(px)))) * 4;
        return [data[o], data[o + 1], data[o + 2]];
      };
      if (read === 'points') return (arg as [number, number][]).map(([px, py]) => at(px, py));
      if (read === 'row') {
        const { y: fy, from, to } = arg as { y: number; from: number; to: number };
        const out: number[][] = [];
        for (let px = Math.round(from); px <= Math.round(to); px++) out.push(px >= 0 && px < bitmap.width ? at(px, fy) : [255, 255, 255]);
        return out;
      }
      // The dots of the tiling pattern: green pixels in the circle's box.
      let green = 0;
      for (let py = 0.3 * bitmap.height; py < 0.7 * bitmap.height; py++)
        for (let px = 0.58 * bitmap.width; px < 0.8 * bitmap.width; px++) {
          const p = at(px, py);
          if (p[1] > 140 && p[0] < 60 && p[2] < 60) green++;
        }
      return green;
    },
    { b64: shot, read, arg },
  ) as Promise<T>;
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
