// What a PDF page paints over what (src/formats/pdfPages.ts `sortRects`, pdfPageScene.ts): a small page like the one Chromium
// prints for a poster, a photo taller than the page under a fade (a tiling pattern), a solid panel, a cutout, text and a logo.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FontSet, packColor } from '@golemdocs/layout';
import { N, PdfDict, PdfDocument, PdfStream, interpretPage } from '../../pdf/src/index.ts';
import { openPdfView, pictures, sortRects } from '../src/formats/pdfPages.ts';
import { pageScene } from '../src/formats/pdfPageScene.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'manifest.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : null;

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

const pixel = (r: number, g: number, b: number): PdfStream => new PdfStream(new PdfDict({ Type: N('XObject'), Subtype: N('Image'), Width: 1, Height: 1, ColorSpace: N('DeviceRGB'), BitsPerComponent: 8 }), Uint8Array.of(r, g, b));

function document(content: string): PdfDocument {
  const doc = PdfDocument.create();
  const page = doc.addPage([200, 200]);
  page.addResource('Font', doc.standardFont('Helvetica').ref, 'F');
  const list = doc.dict(page.resources.get('Font'))!;
  list.set('F1', list.get('F1') ?? [...list][0][1]);
  page.resources.set('XObject', new PdfDict({ Photo: doc.add(pixel(255, 0, 0)), Logo: doc.add(pixel(0, 255, 0)) }));
  const cell = new PdfStream(new PdfDict({ PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 200, 200], XStep: 202, YStep: 202, Matrix: [1, 0, 0, -1, 0, 200], Resources: new PdfDict({ XObject: new PdfDict({ X: doc.add(pixel(0, 0, 255)) }) }) }), ascii('q 200 0 0 -200 0 200 cm /X Do Q'));
  page.resources.set('Pattern', new PdfDict({ Fade: doc.add(cell) }));
  page.setContent(ascii(content));
  return doc;
}

const POSTER = [
  '.5 0 0 -.5 0 200 cm',
  'q 0 0 400 400 re W* n',
  '.1 .1 .1 rg 0 0 400 400 re f',
  'q 400 0 0 -440 0 340 cm /Photo Do Q',
  '/Pattern cs /Fade scn 0 200 400 100 re f',
  '.2 .2 .2 rg 0 300 400 100 re f',
  'q 40 0 0 -40 300 380 cm /Logo Do Q',
  '1 1 1 rg 20 360 360 2 re f',
  'BT /F1 40 Tf 1 0 0 -1 20 350 Tm (Title) Tj ET',
  'Q',
].join('\n');

test('a panel painted over a photo, with a logo and text painted over it, is drawn between them', () => {
  const display = interpretPage(document(POSTER).pages[0], { paths: true, strips: false });
  const { under, over } = sortRects(display);
  assert.deepEqual(under.map((r) => r.y), [0], 'the page colour is under everything');
  // Nothing is painted over the rule: it stays a sharp rectangle.
  assert.deepEqual(over.map((r) => r.h), [1]);
  const order = pictures(display).map((p) => (p.kind === 'image' ? `image ${p.image.y}` : p.group.paths.map((s) => (s.fill?.paint ? 'fade' : `panel ${s.y0}`)).join(' ')));
  assert.deepEqual(order, ['image -50', 'fade panel 150', 'image 170']);
  // Asked again of a page read again (as when its pictures are drawn), it is the same.
  const again = interpretPage(document(POSTER).pages[0], { paths: true, strips: false });
  sortRects(again);
  assert.equal(pictures(again).length, 3);
});

test('rectangles on a page with no pictures go over or under the text as before', () => {
  const display = interpretPage(document('1 0 0 rg 0 0 200 200 re f BT /F1 20 Tf 0 g 10 50 Td (x) Tj ET 0 0 1 rg 8 48 20 20 re f').pages[0], { paths: true, strips: false });
  const { under, over } = sortRects(display);
  assert.deepEqual([under.length, over.length], [1, 1]);
  assert.equal(pictures(display).length, 0);
});

test('a rectangle over text stays in front of it, whatever is painted over the rectangle', () => {
  const display = interpretPage(document('q 200 0 0 200 0 0 cm /Photo Do Q BT /F1 20 Tf 0 g 10 50 Td (secret) Tj ET 0 g 0 40 200 40 re f BT /F1 20 Tf 1 g 10 50 Td (cut) Tj ET').pages[0], { paths: true, strips: false });
  assert.equal(sortRects(display).over.length, 1);
});

test('rectangles over vector art, and over panels over it, keep their order', () => {
  const art = '1 0 0 rg 0 0 m 200 0 l 100 200 l h f';
  const display = interpretPage(document(`${art} 0 0 1 rg 50 50 100 100 re f 0 1 0 rg 140 60 40 40 re f BT /F1 20 Tf 0 g 60 70 Td (Wide text here) Tj ET`).pages[0], { paths: true, strips: false });
  const { under, over } = sortRects(display);
  assert.deepEqual([under.length, over.length], [0, 0]);
  const [only] = pictures(display);
  assert.ok(only.kind === 'shapes');
  assert.deepEqual(only.group.paths.map((p) => p.fill!.color), [0xff0000, 0x0000ff, 0x00ff00]);
});

test('layoutPage: the photo is cropped to the page, and the pictures are in order under the text', skip, async () => {
  const view = await openPdfView(await document(POSTER).save(), fonts!);
  const page = view.layoutPage(0);
  assert.deepEqual([page.background.count, page.foreground.count], [1, 1]);
  assert.equal(page.foreground.color(0), packColor(0xffffff));
  const [photo, art, logo] = page.images;
  assert.deepEqual([photo.x, photo.y, photo.width, photo.height], [0, 0, 200, 170]);
  assert.deepEqual(photo.crop!.map((v) => Math.round(v * 1000) / 1000), [0, 0.227, 1, 1]);
  assert.equal(logo.crop, undefined);
  const svg = new TextDecoder().decode((await view.media(art.svg!))!);
  assert.match(svg, /<pattern [^>]*>\s*<image/);
  assert.match(svg, /fill="#333333"/);
});

test('a page as a drawing paints everything in the order the page does, its images cut by their clips', () => {
  const scene = pageScene(document(`${POSTER.replace(/Q$/, '')} 0 1 0 rg 20 320 10 10 re f q 0 0 20 20 re W n 60 0 0 60 0 0 cm /Logo Do Q Q`).pages[0]);
  const kinds = scene.children.map((n) => {
    const inner = n.kind === 'group' && n.style['clip-path'] ? n.children[0] : n;
    return inner.kind === 'path' ? (inner.style.fill.startsWith('url') ? 'fade' : inner.style.fill) : `${inner === n ? '' : 'clipped '}${inner.kind}`;
  });
  assert.deepEqual(kinds, ['rect', '#1a1a1a', 'image', 'fade', '#333333', 'image', '#ffffff', 'text', '#00ff00', 'clipped image']);
});
