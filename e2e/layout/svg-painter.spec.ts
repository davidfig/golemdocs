// The drawing editor's painter draws what a PDF's vector art becomes (the SVG the converter writes) the way the
// browser draws the same SVG: gradients, clips, tiling patterns, dashes, caps, joins, opacity and even-odd fills.

import { PdfDocument, N, PdfDict, PdfStream, interpretPage } from '../../pdf/src/index.ts';
import { drawingGroups, drawingSvg } from '../../client/src/formats/pdfDrawings.ts';
import { expect, test } from '../fixtures';

async function svgsOf(pdf: PdfDocument): Promise<string[]> {
  const display = interpretPage(PdfDocument.load(await pdf.save()).pages[0], { paths: true });
  return drawingGroups(display.paths, display).map(drawingSvg);
}

async function samples(): Promise<[string, string][]> {
  const out: [string, string][] = [];
  const add = async (name: string, pdf: PdfDocument) => {
    for (const svg of await svgsOf(pdf)) out.push([name, svg]);
  };
  {
    const pdf = PdfDocument.create();
    const page = pdf.addPage([300, 300]).draw({ origin: 'top-left' });
    page.save().ellipsePath(150, 150, 100, 60);
    page.gradient({ type: 'linear', coords: [50, 150, 250, 150], stops: [{ offset: 0, color: [1, 0, 0] }, { offset: 0.5, color: [1, 1, 0] }, { offset: 1, color: [0, 0, 1] }] });
    page.restore().finish();
    await add('linear gradient in a clip', pdf);
  }
  {
    const pdf = PdfDocument.create();
    const page = pdf.addPage([200, 200]).draw({ origin: 'top-left' });
    page.save().rectPath(50, 50, 100, 100);
    page.gradient({ type: 'radial', coords: [90, 90, 0, 100, 100, 55], stops: [{ offset: 0, color: [1, 1, 0] }, { offset: 1, color: [0, 0.2, 0.6] }] });
    page.restore().finish();
    await add('radial gradient', pdf);
  }
  {
    const pdf = PdfDocument.create();
    const cell = new PdfStream(new PdfDict({ PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10, Resources: new PdfDict() }), new TextEncoder().encode('1 0 0 rg 0 0 5 5 re f 0 0 1 RG 1 w 5 5 m 10 10 l S'));
    const page = pdf.addPage([200, 200]);
    const name = page.addResource('Pattern', pdf.add(cell), 'P');
    const draw = page.draw({ origin: 'top-left' });
    draw.op('cs', N('Pattern')).op('scn', N(name)).ellipsePath(100, 100, 80, 60).fill();
    draw.finish();
    await add('tiling pattern', pdf);
  }
  {
    const pdf = PdfDocument.create();
    const draw = pdf.addPage([200, 200]).draw({ origin: 'top-left' });
    draw.lineWidth(8).lineCap('round').lineJoin('bevel').dash([14, 6], 2).strokeColor([0, 0.5, 0]).moveTo(20, 150).lineTo(100, 30).lineTo(180, 150).stroke();
    draw.lineWidth(6).lineCap('square').lineJoin('round').dash([]).strokeColor([0.8, 0, 0.4]).moveTo(30, 180).lineTo(100, 120).lineTo(170, 180).stroke();
    draw.lineWidth(5).lineJoin('miter').fillColor([1, 0.8, 0]).strokeColor([0, 0, 0]).moveTo(60, 60).lineTo(140, 60).lineTo(100, 110).closePath().fillAndStroke().finish();
    await add('strokes', pdf);
  }
  {
    const pdf = PdfDocument.create();
    const draw = pdf.addPage([200, 200]).draw({ origin: 'top-left' });
    draw.save().rectPath(40, 40, 120, 120).clip();
    draw.save().ellipsePath(100, 100, 70, 50).clip();
    draw.opacity(0.5).fillColor([0, 0.4, 1]).rectPath(0, 0, 200, 200).fill();
    draw.restore().restore();
    draw.fillColor([1, 0, 0]).ellipsePath(100, 100, 30, 30).rectPath(90, 90, 20, 20).fill(true);
    draw.finish();
    await add('nested clips, opacity, even-odd', pdf);
  }
  return out;
}

test('the painter draws what the converter writes the way the browser does', async ({ app, page }) => {
  const list = await samples();
  expect(list.length).toBeGreaterThanOrEqual(5);
  await app.goto('?doc=welcome');
  const results = await page.evaluate(async (items) => {
    const { readSvg } = await import('/src/vector/svgRead.ts');
    const { paintScene } = await import('/src/vector/paint.ts');
    const out: { name: string; differing: number; painted: number }[] = [];
    for (const [name, svg] of items) {
      const match = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)!;
      const scale = Math.min(3, 700 / Number(match[1]));
      const width = Math.ceil(Number(match[1]) * scale);
      const height = Math.ceil(Number(match[2]) * scale);
      const draw = (paint: (context: OffscreenCanvasRenderingContext2D) => void) => {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { willReadFrequently: true })!;
        context.fillStyle = '#fff';
        context.fillRect(0, 0, width, height);
        paint(context);
        return context.getImageData(0, 0, width, height).data;
      };
      const mine = draw((context) => paintScene(context, readSvg(svg), width, height));
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      const image = new Image();
      image.src = url;
      await image.decode();
      const browser = draw((context) => context.drawImage(image, 0, 0, width, height));
      let differing = 0;
      let painted = 0;
      for (let i = 0; i < mine.length; i += 4) {
        const d = (Math.abs(mine[i] - browser[i]) + Math.abs(mine[i + 1] - browser[i + 1]) + Math.abs(mine[i + 2] - browser[i + 2])) / 3;
        if (d > 40) differing++;
        if (browser[i] < 235 || browser[i + 1] < 235 || browser[i + 2] < 235) painted++;
      }
      out.push({ name, differing: differing / (mine.length / 4), painted: painted / (mine.length / 4) });
    }
    return out;
  }, list);
  for (const result of results) {
    // Something is drawn (the comparison is not of two blank pictures), and the two agree to within edge pixels.
    expect(result.painted, result.name).toBeGreaterThan(0.01);
    expect(result.differing, result.name).toBeLessThan(0.005);
  }
});
