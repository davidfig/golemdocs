// Vector art from PDF pages as drawings (scenes of the drawing editor, written as SVG): gradients, clips, tiling patterns,
// dashes and joins. What they look like when painted is checked in the browser (e2e/layout/svg-painter.spec.ts).
// Run: node --experimental-transform-types --test test/pdfDrawings.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { N, PdfDict, PdfDocument, PdfStream, interpretPage } from '../../pdf/src/index.ts';
import { drawingGroups, drawingPng, drawingScene, drawingSvg, type DrawingGroup } from '../src/formats/pdfDrawings.ts';
import { pdfToDocument } from '../src/formats/pdfImport.ts';
import type { Drawing, Paragraph, Run } from '@golemdocs/docx';

async function groupsOf(pdf: PdfDocument): Promise<DrawingGroup[]> {
  const display = interpretPage(PdfDocument.load(await pdf.save()).pages[0], { paths: true });
  return drawingGroups(display.paths, display);
}

const compact = (svg: string) => svg.replace(/>\s+</g, '><');

test('a gradient inside a clip is an SVG gradient in a clipped group', async () => {
  const pdf = PdfDocument.create();
  const page = pdf.addPage([300, 300]).draw({ origin: 'top-left' });
  page.save().ellipsePath(150, 150, 100, 60);
  page.gradient({ type: 'linear', coords: [50, 150, 250, 150], stops: [{ offset: 0, color: [1, 0, 0] }, { offset: 1, color: [0, 0, 1] }] });
  page.restore().finish();
  const [group] = await groupsOf(pdf);
  assert.ok(group);
  const svg = compact(drawingSvg(group));
  assert.match(svg, /<linearGradient id="g\d+" gradientUnits="userSpaceOnUse"[^>]*><stop offset="0" stop-color="#ff0000"\/><stop offset="1" stop-color="#0000ff"\/><\/linearGradient>/);
  assert.match(svg, /<clipPath id="c\d+"><path d="M[^"]+Z"\/><\/clipPath>/);
  assert.match(svg, /<g clip-path="url\(#c\d+\)"><path d="[^"]+" fill="url\(#g\d+\)"\/><\/g>/);
  // The scene is the editor's: a group under the clip holding the filled path.
  const scene = drawingScene(group);
  assert.equal(scene.children.length, 1);
  assert.equal(scene.children[0].kind, 'group');
  assert.deepEqual([scene.width, scene.height], [200, 120]);
});

test('a radial gradient keeps its circles', async () => {
  const pdf = PdfDocument.create();
  const page = pdf.addPage([200, 200]).draw({ origin: 'top-left' });
  page.save().rectPath(50, 50, 100, 100);
  page.gradient({ type: 'radial', coords: [90, 90, 0, 100, 100, 50], stops: [{ offset: 0, color: [1, 1, 0] }, { offset: 1, color: [0, 0.2, 0.6] }] });
  page.restore().finish();
  const [group] = await groupsOf(pdf);
  assert.match(drawingSvg(group), /<radialGradient id="g\d+" gradientUnits="userSpaceOnUse" cx="[\d.]+" cy="[\d.]+" r="50" fx="[\d.]+" fy="[\d.]+"/);
});

test('a tiling pattern is an SVG pattern holding its cell', async () => {
  const pdf = PdfDocument.create();
  const cell = new PdfStream(new PdfDict({ PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10, Resources: new PdfDict() }), new TextEncoder().encode('1 0 0 rg 0 0 5 5 re f'));
  const page = pdf.addPage([200, 200]);
  const name = page.addResource('Pattern', pdf.add(cell), 'P');
  const draw = page.draw({ origin: 'top-left' });
  draw.op('cs', N('Pattern')).op('scn', N(name)).ellipsePath(100, 100, 80, 60).fill();
  draw.finish();
  const [group] = await groupsOf(pdf);
  assert.ok(group);
  assert.match(compact(drawingSvg(group)), /<pattern id="p\d+" patternUnits="userSpaceOnUse" x="0" y="0" width="10" height="10" viewBox="0 0 10 10" patternTransform="[^"]+"><path d="M0 0L5 0L5 5L0 5Z" fill="#ff0000"\/><\/pattern>/);
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
  for (const part of ['stroke="#008000"', 'stroke-width="6"', 'stroke-linecap="round"', 'stroke-linejoin="bevel"', 'stroke-dasharray="10 5"', 'stroke-dashoffset="2"', 'fill="none"']) assert.ok(svg.includes(part), part);
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
});

test('the PNG beside the SVG is a PNG (a transparent pixel where there is no canvas to paint on, as in these tests)', async () => {
  const pdf = PdfDocument.create();
  const page = pdf.addPage([200, 200]).draw({ origin: 'top-left' });
  page.ellipse(100, 100, 50, 50, { fill: [1, 0, 0] });
  page.finish();
  const [group] = await groupsOf(pdf);
  assert.deepEqual(group.frame, { x: 50, y: 50, width: 100, height: 100 });
  assert.match(compact(drawingSvg(group)), /^<\?xml[^>]*\?><svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="100" height="100" viewBox="0 0 100 100"><path d="M[^"]+Z" fill="#ff0000"\/><\/svg>/);
  const png = await drawingPng(group);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
