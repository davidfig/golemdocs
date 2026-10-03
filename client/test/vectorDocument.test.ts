// Vector drawings as documents (src/formats/handlers/svg.ts, vectorDoc.ts), painted (vector/paint.ts),
// written as PDF (vector/pdfOut.ts) and made from other documents (formats/svgFromDocument.ts).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { WordDocument, type Paragraph, type Run } from '@golemdocs/docx';
import { FontSet } from '@golemdocs/layout';
import { PdfDocument } from '@golemdocs/pdf';
import { conversionIsLossy, exportDocument, importDocument } from '../src/formats/convert.ts';
import { firstPicture, pageSizeFor } from '../src/formats/imageDoc.ts';
import { documentToScene, documentToSvg } from '../src/formats/svgFromDocument.ts';
import { readWdoc, writeWdoc } from '../src/formats/wdoc.ts';
import { sniffImage } from '../src/formats/images.ts';
import { isGzip } from '../src/vector/gzip.ts';
import { paintScene } from '../src/vector/paint.ts';
import { sceneToPdf } from '../src/vector/pdfOut.ts';
import { readSvg } from '../src/vector/svgRead.ts';
import { FakeCanvas, FakeContext, installFakeCanvas } from './fakeCanvas.ts';
import { pngBytes } from './pictures.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'manifest.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : null;

const DRAWING = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>
  <clipPath id="c"><rect width="50" height="50"/></clipPath></defs>
  <rect x="10" y="10" width="80" height="40" fill="url(#g)" stroke="#000" stroke-width="2" stroke-dasharray="4 2"/>
  <circle cx="150" cy="50" r="30" fill="#0f0" fill-opacity=".5" clip-path="url(#c)"/>
  <path d="M10 90 C 50 60 100 120 190 90" fill="none" stroke="blue" stroke-linecap="round"/>
  <text x="20" y="80" font-size="12" font-family="serif" fill="#333">Hi <tspan font-weight="bold">there</tspan></text>
</svg>`;

let fake: ReturnType<typeof installFakeCanvas>;
beforeEach(() => {
  fake = installFakeCanvas();
  // Encoding yields a real (tiny) PNG, since the page is made from what comes out.
  FakeCanvas.blob = () => new Blob([pngBytes(8, 4, 90) as Uint8Array<ArrayBuffer>], { type: 'image/png' });
});
afterEach(() => fake.restore());

const bytes = (text: string) => new TextEncoder().encode(text);

test('opening a drawing makes a one-page document the size of the drawing, and keeps the SVG', async () => {
  const { document, extensions } = await importDocument('svg', bytes(DRAWING));
  assert.deepEqual(document.section.pageSize, pageSizeFor(200, 100));
  assert.equal(extensions.svg?.source, DRAWING);
  assert.equal(extensions.svg?.gzip, undefined);
  assert.ok(await firstPicture(document));
  // Small drawings are pictured larger, so they stay sharp when zoomed.
  assert.deepEqual([fake.canvases[0].width, fake.canvases[0].height], [800, 400]);
});

test('a file that is not an SVG is refused with a message', async () => {
  await assert.rejects(importDocument('svg', bytes('<html></html>')), /SVG/);
  await assert.rejects(importDocument('svg', bytes('plain words')), /SVG/);
});

test('the drawing is written back as it was, as SVG or compressed, and compressed files open', async () => {
  const { document, extensions } = await importDocument('svg', bytes(DRAWING));
  const plain = await exportDocument(document, extensions, 'svg', fonts as never);
  assert.equal(new TextDecoder().decode(plain), DRAWING);
  const zipped = await exportDocument(document, extensions, 'svgz', fonts as never);
  assert.ok(isGzip(zipped));
  const again = await importDocument('svgz', zipped);
  assert.equal(again.extensions.svg?.source, DRAWING);
  assert.equal(again.extensions.svg?.gzip, true);
});

test('the drawing survives a .wdoc, and goes out as a picture or in a Word file', async () => {
  const { document, extensions } = await importDocument('svg', bytes(DRAWING));
  const saved = await writeWdoc({ manifest: { version: 1, lens: 'svg', origin: 'svg', pagesCurrent: false }, document: await document.write(), original: null, extensions });
  const back = await readWdoc(saved);
  assert.equal(back.extensions.svg?.source, DRAWING);
  assert.equal(back.manifest.lens, 'svg');
  // As a PNG: the picture the page shows.
  const png = await exportDocument(document, extensions, 'png', fonts as never);
  assert.equal(sniffImage(png)?.type, 'png');
  const word = await WordDocument.read(await exportDocument(document, extensions, 'docx', fonts as never));
  assert.ok(await firstPicture(word));
});

test('switching a drawing to a raster or document format is lossy, to SVG or PDF is not', () => {
  assert.equal(conversionIsLossy('svg', 'png'), true);
  assert.equal(conversionIsLossy('svg', 'docx'), true);
  assert.equal(conversionIsLossy('svg', 'svgz'), false);
  assert.equal(conversionIsLossy('svgz', 'pdf'), false);
  // A picture goes into a drawing whole; a text document keeps how it looks but not how it reflows.
  assert.equal(conversionIsLossy('png', 'svg'), false);
  assert.equal(conversionIsLossy('docx', 'svg'), true);
});

function paint(svg: string, width = 200, height = 100): FakeContext {
  const canvas = new FakeCanvas(width, height);
  paintScene(canvas.ctx as never, readSvg(svg), width, height);
  return canvas.ctx;
}

test('painting: shapes are traced and filled with their colors, in order', () => {
  const ctx = paint(DRAWING);
  // The clip to the drawing, then the scene's view box.
  assert.equal(ctx.calls[0].op, 'save');
  assert.ok(ctx.ops('clip').length >= 2);
  const fills = ctx.ops('fill');
  assert.equal(fills.length, 2, "the curve has fill none");
  // The gradient is made across the box of the rectangle: from x 10 to 90, along its top edge.
  assert.deepEqual(ctx.ops('createLinearGradient')[0].args, [10, 10, 90, 10]);
  assert.deepEqual(ctx.ops('addColorStop').map((c) => c.args), [[0, 'rgba(255,0,0,1)'], [1, 'rgba(0,0,255,1)']]);
  // The circle's own opacity.
  assert.equal(fills[1].fillStyle, 'rgba(0,255,0,0.5)');
  // Stroke width, dashes and caps come from the style.
  assert.deepEqual(ctx.ops('setLineDash')[0].args, [[4, 2]]);
  assert.equal(ctx.ops('bezierCurveTo').length >= 1, true);
  assert.deepEqual(ctx.ops('fillText').map((c) => c.args[0]), ['Hi ', 'there']);
});

test('painting: text runs follow each other, and nodes with display none are left out', () => {
  const ctx = paint('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text x="10" y="20" font-size="10">ab<tspan dy="5">cd</tspan></text><rect width="5" height="5" display="none"/></svg>', 100, 50);
  const [first, second] = ctx.ops('fillText');
  assert.deepEqual(first.args, ['ab', 10, 20]);
  // The measure is 5 per letter in the fake: the second run starts where the first ended, 5 lower.
  assert.deepEqual(second.args, ['cd', 20, 25]);
  assert.equal(ctx.ops('fill').length, 0);
});

test('the drawing becomes a vector PDF page: curves and text stay as they are', async () => {
  const pdf = PdfDocument.load(await sceneToPdf(readSvg(DRAWING)));
  assert.equal(pdf.pageCount, 1);
  const page = pdf.pages[0];
  assert.deepEqual([page.mediaBox[2], page.mediaBox[3]], [150, 75]);
  const ops = page.operations().map((o) => o.op);
  assert.ok(ops.includes('c'), 'curves');
  assert.ok(ops.includes('W'), 'clips');
  assert.ok(ops.includes('d'), 'dashes');
  assert.equal(page.extractText().text.replace(/\s+/g, ' ').trim(), 'Hi there');
});

test('a document becomes vector graphics: pages as groups, text as text at the laid-out positions', skip, async () => {
  const doc = await WordDocument.create();
  const run = (text: string, properties: Run['properties'] = {}): Run => ({ kind: 'run', properties, content: [{ kind: 'text', text }], attrs: {} });
  const paragraph = (children: Paragraph['children']): Paragraph => ({ kind: 'paragraph', properties: {}, children, attrs: {} });
  doc.body = [paragraph([run('Hello '), run('world', { bold: true, color: { val: 'FF0000' } })])];
  const scene = await documentToScene(doc, fonts!);
  assert.equal(scene.children.length, 1);
  assert.deepEqual([scene.width, scene.height], [816, 1056]);
  const page = scene.children[0];
  assert.equal(page.kind, 'group');
  const texts = (page.kind === 'group' ? page.children : []).filter((n) => n.kind === 'text');
  assert.equal(texts.map((t) => (t.kind === 'text' ? t.runs.map((r) => r.text).join('') : '')).join('|'), 'Hello|world');
  const world = texts[1];
  assert.equal(world.style.fill, '#ff0000');
  assert.equal(world.style['font-weight'], 'bold');
  // 1 inch margin: 72 points.
  assert.ok(texts[0].kind === 'text' && Math.abs(texts[0].x - 72) < 0.5);
  // And it is an SVG that reads back.
  const text = await documentToSvg(doc, fonts!);
  assert.equal(readSvg(text).children.length, 1);
  assert.match(text, /font-family="'Calibri', 'Carlito', sans-serif"/);
});

test('a gradient fill is a PDF shading drawn through the shape, with its stroke on top', async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f00"/><stop offset=".5" stop-color="#0f0"/><stop offset="1" stop-color="#00f"/></linearGradient>
    <radialGradient id="r"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient></defs>
    <rect x="10" y="10" width="40" height="40" fill="url(#g)" stroke="#000"/>
    <circle cx="70" cy="70" r="20" fill="url(#r)"/></svg>`;
  const bytes = await sceneToPdf(readSvg(svg));
  const ops = PdfDocument.load(bytes).pages[0].operations().map((o) => o.op);
  assert.equal(ops.filter((o) => o === 'sh').length, 2);
  assert.ok(ops.includes('S'), 'the rectangle’s outline');
  // Stroked after the shading, which is clipped to the shape.
  assert.ok(ops.indexOf('sh') < ops.indexOf('S'));
  const page = PdfDocument.load(bytes).pages[0];
  const shadings = page.resources.get('Shading') as unknown as Map<string, unknown>;
  assert.equal([...shadings].length, 2);
});
