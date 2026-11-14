// A PDF page as a drawing (docs/live-blocks.md §2: `Contract.pdf#page:3`), part of the PDF chunk (handlers/pdf.ts): a `Scene` of the drawing editor, so the drawing
// writer makes its SVG and the drawing painter its PNG, the same way a chart becomes a picture. Nothing here needs a canvas
// or the WebGL viewer, so it runs in the live worker.
//
// The page is drawn as the viewer draws it: the shapes the page paints (pdfDrawings.ts turns them into paths, with their
// clips, gradients and patterns), its images, and its text as the outlines of the fonts it embeds (pdf's `FontProgram`),
// or as text in a like font where it embeds none (the standard fonts, Type 3). Shapes and images painted over text come
// after the text. Like the viewer, a glyph run is set upright at its size: text the page turns or stretches is not.

import { imageBytes, interpretPage, type DisplayImage, type GlyphRun, type PdfPage } from '@golemdocs/pdf';
import { FontProgram, type Outline } from '@golemdocs/pdf/fontProgram';
import { colorText } from '../vector/style.ts';
import { emptyScene, type ImageNode, type Matrix, type PathCommand, type Scene, type SceneNode, type TextNode } from '../vector/model.ts';
import { Definitions, nodesOf } from './pdfDrawings.ts';
import { writeSvg } from '../vector/svgWrite.ts';

const color = (rgb: number): string => colorText([(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, 1]);
const round = (v: number): number => Math.round(v * 100) / 100;

/** An image of the page, placed as it is drawn: the page's matrix for the image's unit square, its rows from the top. */
function imageNode(page: PdfPage, image: DisplayImage): ImageNode | null {
  const found = imageBytes(page.doc, image.stream, image.maskColor !== undefined ? { maskColor: image.maskColor } : {});
  if (!found || !image.pixelWidth || !image.pixelHeight) return null;
  // Where the unit square lands (y down), and the image's own size: a turned one says, an upright one is its box and mirrors.
  const [a, b, c, d, e, f]: Matrix = image.matrix ?? [image.flipX ? -image.w : image.w, 0, 0, image.flipY ? image.h : -image.h, image.flipX ? image.x + image.w : image.x, image.flipY ? image.y : image.y + image.h];
  // A PDF image's first row is at the top of its unit square (y = 1); an SVG image's is at y = 0.
  const pw = image.pixelWidth;
  const ph = image.pixelHeight;
  const transform: Matrix = [a / pw, b / pw, -c / ph, -d / ph, c + e, d + f];
  let binary = '';
  for (let i = 0; i < found.bytes.length; i += 0x8000) binary += String.fromCharCode(...found.bytes.subarray(i, i + 0x8000));
  return { kind: 'image', x: 0, y: 0, width: pw, height: ph, href: `data:${found.mime};base64,${btoa(binary)}`, transform, style: image.alpha < 1 ? { opacity: String(round(image.alpha)) } : {}, attrs: {} };
}

/** A glyph's outline (ems, y up) as commands at its place on the page (points, y down). */
function glyphCommands(outline: Outline, x: number, y: number, size: number, out: PathCommand[]): void {
  const px = (gx: number): number => round(x + gx * size);
  const py = (gy: number): number => round(y - gy * size);
  for (const contour of outline) {
    if (!contour.length) continue;
    out.push(['M', px(contour[0].points[0]), py(contour[0].points[1])]);
    for (const { points: p } of contour) {
      if (p.length === 4) out.push(['L', px(p[2]), py(p[3])]);
      else if (p.length === 6) {
        // A quadratic as the cubic it is.
        const [x0, y0, cx, cy, x1, y1] = p;
        out.push(['C', px(x0 + ((cx - x0) * 2) / 3), py(y0 + ((cy - y0) * 2) / 3), px(x1 + ((cx - x1) * 2) / 3), py(y1 + ((cy - y1) * 2) / 3), px(x1), py(y1)]);
      } else if (p.length === 8) out.push(['C', px(p[2]), py(p[3]), px(p[4]), py(p[5]), px(p[6]), py(p[7])]);
    }
    out.push(['Z']);
  }
}

/** A run of text: one path of its glyphs' outlines, or text in a like font for glyphs its font has no outline for. */
function runNodes(page: PdfPage, run: GlyphRun, programs: Map<object, FontProgram | null>): SceneNode[] {
  let program = programs.get(run.fontDict);
  if (program === undefined) programs.set(run.fontDict, (program = FontProgram.load(page.doc, run.fontDict)));
  const fill: Record<string, string> = { fill: color(run.color), ...(run.alpha < 1 && { 'fill-opacity': String(round(run.alpha)) }) };
  const commands: PathCommand[] = [];
  const missing: TextNode['runs'] = [];
  for (const g of run.glyphs) {
    const outline = program?.outline(g.glyph);
    if (outline) glyphCommands(outline, g.x, g.y, run.size, commands);
    else if (g.unicode.trim()) missing.push({ text: g.unicode, x: round(g.x), y: round(g.y), style: {} });
  }
  const nodes: SceneNode[] = [];
  if (commands.length) nodes.push({ kind: 'path', commands, style: fill, attrs: {} });
  if (missing.length) {
    const family = run.mono ? 'monospace' : run.serif ? 'serif' : 'sans-serif';
    const style = { ...fill, 'font-family': run.family ? `"${run.family.replace(/"/g, '')}", ${family}` : family, 'font-size': String(round(run.size)), ...(run.bold && { 'font-weight': 'bold' }), ...(run.italic && { 'font-style': 'italic' }) };
    nodes.push({ kind: 'text', x: missing[0].x!, y: missing[0].y!, runs: missing, style, attrs: {} });
  }
  return nodes;
}

/** A page as a drawing, in points, on white. */
export function pageScene(page: PdfPage): Scene {
  const display = interpretPage(page, { paths: true });
  const scene = emptyScene(round(display.width), round(display.height));
  const defs = new Definitions();
  const programs = new Map<object, FontProgram | null>();
  const images = (over: boolean): SceneNode[] => display.images.filter((i) => i.over === over).flatMap((i) => imageNode(page, i) ?? []);
  scene.children = [
    { kind: 'rect', x: 0, y: 0, width: scene.width, height: scene.height, rx: 0, ry: 0, style: { fill: '#ffffff' }, attrs: {} },
    ...nodesOf(
      display.paths.filter((p) => !p.over),
      0,
      0,
      defs,
    ),
    ...images(false),
    ...display.glyphRuns.flatMap((run) => runNodes(page, run, programs)),
    ...nodesOf(
      display.paths.filter((p) => p.over),
      0,
      0,
      defs,
    ),
    ...images(true),
  ];
  scene.defs = defs.elements;
  return scene;
}

/** A page as a drawing and its SVG text. */
export function pagePicture(page: PdfPage): { scene: Scene; svg: string } {
  const scene = pageScene(page);
  return { scene, svg: writeSvg(scene) };
}
