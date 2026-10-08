// Vector art from PDF pages as SVG and PNG: gradients, clips, tiling patterns, dashes and joins.
// Run: node --experimental-transform-types --test test/pdfDrawings.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { N, PdfDict, PdfDocument, PdfStream, interpretPage } from '../../pdf/src/index.ts';
import { drawingGroups, drawingPng, drawingSvg, type DrawingGroup } from '../src/formats/pdfDrawings.ts';
import { pdfToDocument } from '../src/formats/pdfImport.ts';
import type { Drawing, Paragraph, Run } from '@golemdocs/docx';

/** Pixels (RGBA) of a PNG the pdf package writes: 8-bit, unfiltered rows. */
function pixelsOf(png: Uint8Array): { width: number; height: number; at(x: number, y: number): number[] } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const channels = ({ 0: 1, 2: 3, 6: 4 } as Record<number, number>)[png[25]];
  const data: number[] = [];
  for (let p = 8; p < png.length; ) {
    const length = view.getUint32(p);
    if (String.fromCharCode(...png.subarray(p + 4, p + 8)) === 'IDAT') data.push(...png.subarray(p + 8, p + 8 + length));
    p += 12 + length;
  }
  const raw = inflateSync(Uint8Array.from(data));
  return {
    width,
    height,
    at: (x, y) => {
      const o = y * (width * channels + 1) + 1 + x * channels;
      const px = Array.from(raw.subarray(o, o + channels));
      return channels === 4 ? px : channels === 3 ? [...px, 255] : [px[0], px[0], px[0], 255];
    },
  };
}

async function groupsOf(pdf: PdfDocument): Promise<DrawingGroup[]> {
  const display = interpretPage(PdfDocument.load(await pdf.save()).pages[0], { paths: true });
  return drawingGroups(display.paths, display);
}

test('a gradient inside a clip is an SVG gradient, and the PNG shades from one color to the other', async () => {
  const pdf = PdfDocument.create();
  const page = pdf.addPage([300, 300]).draw({ origin: 'top-left' });
  page.save().ellipsePath(150, 150, 100, 60);
  page.gradient({ type: 'linear', coords: [50, 150, 250, 150], stops: [{ offset: 0, color: [1, 0, 0] }, { offset: 1, color: [0, 0, 1] }] });
  page.restore().finish();
  const [group] = await groupsOf(pdf);
  assert.ok(group);
  const svg = drawingSvg(group);
  assert.match(svg, /<linearGradient id="g\d+" gradientUnits="userSpaceOnUse"[^>]*>.*<stop offset="0" stop-color="#ff0000"\/>.*<stop offset="1" stop-color="#0000ff"\/>/);
  assert.match(svg, /<clipPath id="c\d+"><path d="M[^"]+Z"\/><\/clipPath>/);
  assert.match(svg, /<g clip-path="url\(#c\d+\)"><path d="[^"]+" fill="url\(#g\d+\)"\/><\/g>/);
  const png = pixelsOf(drawingPng(group));
  const row = Math.floor(png.height / 2);
  const left = png.at(25, row);
  const right = png.at(png.width - 25, row);
  assert.ok(left[0] > 200 && left[2] < 60 && left[3] === 255, `left ${left}`);
  assert.ok(right[2] > 200 && right[0] < 60 && right[3] === 255, `right ${right}`);
  // The corners are outside the ellipse the gradient is clipped to.
  assert.equal(png.at(2, 2)[3], 0);
});

test('a radial gradient starts with its first stop at the center', async () => {
  const pdf = PdfDocument.create();
  const page = pdf.addPage([200, 200]).draw({ origin: 'top-left' });
  page.save().rectPath(50, 50, 100, 100);
  page.gradient({ type: 'radial', coords: [100, 100, 0, 100, 100, 50], stops: [{ offset: 0, color: [1, 1, 0] }, { offset: 1, color: [0, 0, 0] }] });
  page.restore().finish();
  const [group] = await groupsOf(pdf);
  assert.match(drawingSvg(group), /<radialGradient id="g\d+" gradientUnits="userSpaceOnUse" cx="[\d.]+" cy="[\d.]+" r="50"/);
  const png = pixelsOf(drawingPng(group));
  const middle = png.at(Math.floor(png.width / 2), Math.floor(png.height / 2));
  const edge = png.at(5, Math.floor(png.height / 2));
  assert.ok(middle[0] > 230 && middle[1] > 230 && middle[2] < 30, `middle ${middle}`);
  assert.ok(edge[0] < 80, `edge ${edge}`);
});

test('a tiling pattern is an SVG pattern, and the PNG repeats its cell', async () => {
  const pdf = PdfDocument.create();
  const cell = new PdfStream(new PdfDict({ PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10, Resources: new PdfDict() }), new TextEncoder().encode('1 0 0 rg 0 0 5 5 re f'));
  const page = pdf.addPage([200, 200]);
  const name = page.addResource('Pattern', pdf.add(cell), 'P');
  const draw = page.draw({ origin: 'top-left' });
  draw.op('cs', N('Pattern')).op('scn', N(name)).ellipsePath(100, 100, 80, 60).fill();
  draw.finish();
  const [group] = await groupsOf(pdf);
  assert.ok(group);
  assert.match(drawingSvg(group), /<pattern id="p\d+" patternUnits="userSpaceOnUse" x="0" y="0" width="10" height="10" viewBox="0 0 10 10" patternTransform="matrix\([^)]+\)"><path d="M0 0L5 0L5 5L0 5Z" fill="#ff0000"\/><\/pattern>/);
  const png = pixelsOf(drawingPng(group));
  let red = 0;
  let inside = 0;
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const px = png.at(x, y);
      if (px[3] === 255) inside++;
      if (px[0] > 200 && px[1] < 60 && px[3] === 255) red++;
    }
  // A quarter of the ellipse's area is cell; the rest of the picture shows through.
  const filled = Math.PI * 80 * 60;
  assert.ok(Math.abs(red - filled / 4) < filled * 0.04, `red ${red} of ${filled}`);
  assert.equal(inside, red);
});

test('dashes, caps and joins carry over to the SVG', async () => {
  const pdf = PdfDocument.create();
  const page = pdf.addPage([200, 200]).draw({ origin: 'top-left' });
  page.lineWidth(6).lineCap('round').lineJoin('bevel').dash([10, 5], 2).strokeColor([0, 0.5, 0]);
  page.moveTo(30, 150).lineTo(100, 40).lineTo(170, 150).stroke();
  page.finish();
  const [group] = await groupsOf(pdf);
  assert.ok(group);
  const svg = drawingSvg(group);
  assert.match(svg, /stroke="#008000" stroke-width="6" stroke-linecap="round" stroke-linejoin="bevel" stroke-dasharray="10 5" stroke-dashoffset="2"/);
  const png = pixelsOf(drawingPng(group));
  // Along the first dash the line is painted; the picture has gaps.
  let painted = 0;
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) if (png.at(x, y)[3] > 128) painted++;
  assert.ok(painted > 200 && painted < (png.width * png.height) / 3, `painted ${painted}`);
});

test('shapes cut by a rectangle clip are cut in the SVG and the picture is only as large as what shows', async () => {
  const pdf = PdfDocument.create();
  const page = pdf.addPage([300, 300]).draw({ origin: 'top-left' });
  page.save().rectPath(100, 100, 50, 50).clip();
  page.fillColor([0, 0, 1]).ellipsePath(125, 125, 100, 100).fill();
  page.restore().finish();
  const [group] = await groupsOf(pdf);
  assert.ok(group);
  assert.deepEqual(group.frame, { x: 100, y: 100, width: 50, height: 50 });
  assert.match(drawingSvg(group), /<g clip-path="url\(#c\d+\)">/);
  const png = pixelsOf(drawingPng(group));
  assert.deepEqual(png.at(Math.floor(png.width / 2), Math.floor(png.height / 2)), [0, 0, 255, 255]);
});

test('a picture drawn turned and mirrored is placed turned and mirrored', async () => {
  const pdf = PdfDocument.create();
  const image = pdf.embedImage(new Uint8Array(readFileSync(join(import.meta.dirname, '..', '..', 'pdf', 'test', 'fixtures', 'img-rgb.jpg'))));
  const page = pdf.addPage([400, 400]).draw({ origin: 'top-left' });
  page.save().rotate(90, 200, 200).image(image, 150, 150, 100, 60).restore();
  page.save().transform(-1, 0, 0, 1, 380, 0).image(image, 300, 20, 60, 40).restore();
  page.finish();
  const doc = await pdfToDocument(await pdf.save());
  const pictures = doc.body.filter((b): b is Paragraph => b.kind === 'paragraph').flatMap((p) => p.children.filter((c): c is Run => c.kind === 'run').flatMap((r) => r.content.filter((c): c is Drawing => c.kind === 'drawing')));
  assert.equal(pictures.length, 2);
  const json = pictures.map((d) => JSON.stringify(d.xml));
  const turned = json.find((j) => /rot/.test(j));
  const mirrored = json.find((j) => /flipH/.test(j));
  assert.ok(turned && mirrored, json.join('\n'));
  assert.match(turned, /"rot":\s*"?5400000/);
  // The turned picture keeps its own size (100 x 60 points), not the box around it.
  const sizes = pictures.map((d) => [Math.round(d.width / 12700), Math.round(d.height / 12700)]);
  assert.ok(sizes.some(([w, h]) => w === 100 && h === 60), JSON.stringify(sizes));
});
