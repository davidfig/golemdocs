// A scene as a PDF page that stays vector: paths, curves, strokes, dashes, clips and opacity are
// PDF's own, so the drawing is as sharp as the file it came from. Text is set in the PDF standard
// fonts (the family's closest of Times, Courier and Helvetica, characters they lack become "?"),
// and a gradient is a PDF shading (linear or radial, any number of stops).

import { PdfDocument } from '@golemdocs/pdf';
import type { PageDrawing, PdfFont, PdfImage } from '@golemdocs/pdf';
import { readClip } from './clip.ts';
import { fontSizeOf, findNode, localBounds, outline, viewBoxMatrix } from './geometry.ts';
import { averageColor, readGradient } from './gradients.ts';
import { gradientInLocal } from './gradientEdit.ts';
import { apply } from './matrix.ts';
import type { Matrix, PathCommand, Scene, SceneNode, Style } from './model.ts';
import { inherited, parseColor, parseLength, parseNumbers, urlReference } from './style.ts';
import type { Rgba } from './style.ts';
import { pdfChar } from '../formats/pdfExport.ts';

/** Points per CSS pixel. */
const PT = 0.75;

interface Out {
  d: PageDrawing;
  scene: Scene;
  pdf: PdfDocument;
  fonts: Map<string, PdfFont>;
  images: Map<string, PdfImage | null>;
  depth: number;
}

function standardName(chain: readonly Style[]): string {
  const family = (inherited(chain, 'font-family') ?? '').toLowerCase();
  const weight = inherited(chain, 'font-weight') ?? '';
  const bold = weight === 'bold' || weight === 'bolder' || Number(weight) >= 600;
  const style = inherited(chain, 'font-style');
  const italic = style === 'italic' || style === 'oblique';
  if (/mono|courier|consolas|menlo/.test(family)) return bold ? (italic ? 'Courier-BoldOblique' : 'Courier-Bold') : italic ? 'Courier-Oblique' : 'Courier';
  if (/serif|times|georgia|garamond|cambria|palatino/.test(family) && !/sans/.test(family)) return bold ? (italic ? 'Times-BoldItalic' : 'Times-Bold') : italic ? 'Times-Italic' : 'Times-Roman';
  return bold ? (italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : italic ? 'Helvetica-Oblique' : 'Helvetica';
}

/** A paint value as a colour with its alpha; null for none. */
function colorOf(out: Out, value: string | undefined, chain: readonly Style[]): Rgba | null {
  if (value === undefined || value === 'none') return null;
  const reference = urlReference(value);
  if (reference) {
    const gradient = readGradient(out.scene, reference);
    if (gradient?.stops.length) return averageColor(gradient);
    return parseColor(value.replace(/url\([^)]*\)/, '').trim());
  }
  return value === 'currentColor' ? parseColor(inherited(chain, 'color') ?? 'black') : parseColor(value);
}

/** A gradient fill as what the PDF writer takes, in the shape's own coordinates; null when the fill is not one the PDF can do (or is not a gradient). */
function gradientSpec(out: Out, value: string, node: SceneNode): { type: 'linear' | 'radial'; coords: number[]; stops: { offset: number; color: [number, number, number] }[] } | null {
  const id = urlReference(value);
  const read = id ? readGradient(out.scene, id) : null;
  const box = localBounds(node, out.scene);
  if (!read || !box || read.stops.length < 2) return null;
  const g = gradientInLocal(read, box);
  const m = g.transform;
  const at = (x: number, y: number): [number, number] => apply(m, x, y);
  const stops = g.stops.map((s) => ({ offset: s.offset, color: [s.color[0] / 255, s.color[1] / 255, s.color[2] / 255] as [number, number, number] }));
  if (g.type === 'linear') {
    const [x0, y0] = at(g.x1, g.y1);
    const [x1, y1] = at(g.x2, g.y2);
    return { type: 'linear', coords: [x0, y0, x1, y1], stops };
  }
  const [cx, cy] = at(g.cx, g.cy);
  const [fx, fy] = at(g.fx, g.fy);
  return { type: 'radial', coords: [fx, fy, 0, cx, cy, g.r * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))], stops };
}

const unitColor = (c: Rgba): [number, number, number] => [c[0] / 255, c[1] / 255, c[2] / 255];

function trace(d: PageDrawing, commands: readonly PathCommand[]): void {
  for (const c of commands) {
    if (c[0] === 'M') d.moveTo(c[1], c[2]);
    else if (c[0] === 'L') d.lineTo(c[1], c[2]);
    else if (c[0] === 'C') d.curveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
    else d.closePath();
  }
}

const num = (value: string | undefined, fallback: number): number => {
  const v = parseFloat(value ?? '');
  return Number.isFinite(v) ? v : fallback;
};

function paintShape(out: Out, node: SceneNode, chain: readonly Style[], commands: readonly PathCommand[], opacity: number): void {
  const { d } = out;
  const fillValue = inherited(chain, 'fill') ?? 'black';
  const fill = colorOf(out, fillValue, chain);
  const stroke = colorOf(out, inherited(chain, 'stroke'), chain);
  const shading = gradientSpec(out, fillValue, node);
  const width = parseLength(inherited(chain, 'stroke-width')) ?? 1;
  const strokes = !!stroke && width > 0;
  if (!fill && !strokes) return;
  const fillAlpha = fill ? fill[3] * num(inherited(chain, 'fill-opacity'), 1) * opacity : 1;
  const strokeAlpha = stroke ? stroke[3] * num(inherited(chain, 'stroke-opacity'), 1) * opacity : 1;
  d.save();
  d.opacity(Math.max(0, Math.min(1, fillAlpha)), Math.max(0, Math.min(1, strokeAlpha)));
  if (fill && !shading) d.fillColor(unitColor(fill));
  if (strokes) {
    d.strokeColor(unitColor(stroke!));
    d.lineWidth(width);
    const cap = inherited(chain, 'stroke-linecap');
    d.lineCap(cap === 'round' || cap === 'square' ? cap : 'butt');
    const join = inherited(chain, 'stroke-linejoin');
    d.lineJoin(join === 'round' || join === 'bevel' ? join : 'miter');
    const dashes = inherited(chain, 'stroke-dasharray');
    const list = dashes && dashes !== 'none' ? parseNumbers(dashes) : [];
    if (list.length && list.some((v) => v > 0)) d.dash(list.length % 2 ? [...list, ...list] : list, parseLength(inherited(chain, 'stroke-dashoffset')) ?? 0);
  }
  const evenOdd = inherited(chain, 'fill-rule') === 'evenodd';
  if (fill && shading) {
    // A gradient is painted through the shape's outline as a clip, then the outline is stroked on its own.
    trace(d, commands);
    d.gradient(shading, evenOdd);
    if (strokes) {
      trace(d, commands);
      d.stroke();
    }
  } else {
    trace(d, commands);
    if (fill && strokes) d.fillAndStroke(evenOdd);
    else if (fill) d.fill(evenOdd);
    else d.stroke();
  }
  d.restore();
}

function paintText(out: Out, node: Extract<SceneNode, { kind: 'text' }>, chain: readonly Style[], opacity: number): void {
  const { d } = out;
  let x = node.x;
  let y = node.y;
  const anchor = inherited(chain, 'text-anchor');
  const pieces = node.runs.map((run) => {
    const runChain = [run.style, ...chain];
    const name = standardName(runChain);
    let font = out.fonts.get(name);
    if (!font) out.fonts.set(name, (font = out.pdf.standardFont(name)));
    const size = fontSizeOf(runChain);
    const text = [...run.text].map((ch) => pdfChar(ch.codePointAt(0)).text).join('');
    return { run, runChain, font, size, text, width: font.widthOf(text, size) };
  });
  const total = pieces.reduce((n, p) => n + p.width, 0);
  x -= anchor === 'middle' ? total / 2 : anchor === 'end' ? total : 0;
  for (const p of pieces) {
    if (p.run.x !== undefined) x = p.run.x;
    if (p.run.y !== undefined) y = p.run.y;
    x += p.run.dx ?? 0;
    y += p.run.dy ?? 0;
    const fill = colorOf(out, inherited(p.runChain, 'fill') ?? 'black', p.runChain);
    if (fill && p.text) {
      d.save();
      d.opacity(Math.max(0, Math.min(1, fill[3] * num(inherited(p.runChain, 'fill-opacity'), 1) * opacity)));
      // The page is flipped to put y downward; text is flipped back so that it stands up.
      d.transform(1, 0, 0, -1, x, y);
      d.text(p.text, 0, 0, { font: p.font, size: p.size, color: unitColor(fill) });
      d.restore();
    }
    x += p.width;
  }
}

function imageFor(out: Out, href: string): PdfImage | null {
  if (out.images.has(href)) return out.images.get(href)!;
  let image: PdfImage | null = null;
  const m = /^data:image\/(png|jpe?g);base64,(.*)$/s.exec(href);
  if (m) {
    try {
      image = out.pdf.embedImage(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)));
    } catch {
      image = null;
    }
  }
  out.images.set(href, image);
  return image;
}

function paintNode(out: Out, node: SceneNode, parentChain: readonly Style[], parentOpacity: number): void {
  if (node.kind === 'raw' || node.style.display === 'none') return;
  const { d, scene } = out;
  const chain = [node.style, ...parentChain];
  const visibility = inherited(chain, 'visibility');
  if (node.kind !== 'group' && (visibility === 'hidden' || visibility === 'collapse')) return;
  const opacity = parentOpacity * Math.max(0, Math.min(1, num(node.style.opacity, 1)));
  d.save();
  if (node.transform) d.transform(...(node.transform as readonly [number, number, number, number, number, number]));
  const clip = node.style['clip-path'];
  const cut = clip && clip !== 'none' ? readClip(scene, clip, localBounds(node, scene, chain)) : null;
  if (cut) {
    trace(d, cut.commands);
    d.clip(cut.evenOdd);
  }
  switch (node.kind) {
    case 'group':
      for (const child of node.children) paintNode(out, child, chain, opacity);
      break;
    case 'path':
    case 'rect':
    case 'ellipse':
      if (node.kind !== 'rect' || (node.width > 0 && node.height > 0)) paintShape(out, node, chain, outline(node)!, opacity);
      break;
    case 'text':
      paintText(out, node, chain, opacity);
      break;
    case 'image': {
      const image = imageFor(out, node.href);
      if (image && node.width > 0 && node.height > 0) {
        d.save();
        d.opacity(opacity);
        d.transform(1, 0, 0, -1, 0, node.y * 2 + node.height);
        d.image(image, node.x, node.y, node.width, node.height);
        d.restore();
      }
      break;
    }
    case 'use': {
      const target = findNode(scene, node.href);
      if (target && out.depth < 16) {
        d.translate(node.x, node.y);
        paintNode({ ...out, depth: out.depth + 1 }, target, chain, opacity);
      }
      break;
    }
  }
  d.restore();
}

/** The scene as a one-page PDF the size of the drawing. */
export async function sceneToPdf(scene: Scene, title?: string): Promise<Uint8Array> {
  const pdf = PdfDocument.create();
  if (title) pdf.setMetadata('Title', title);
  pdf.setMetadata('Creator', 'Golem Docs');
  pdf.setMetadata('Producer', 'Golem Docs PDF export');
  const width = Math.max(scene.width * PT, 1);
  const height = Math.max(scene.height * PT, 1);
  const page = pdf.addPage([width, height]);
  const d = page.draw();
  // User units to points, y downward.
  d.transform(PT, 0, 0, -PT, 0, height);
  d.save();
  // The drawing is clipped to its own area.
  d.rectPath(0, 0, scene.width, scene.height).clip();
  d.transform(...(viewBoxMatrix(scene) as Matrix as readonly [number, number, number, number, number, number]));
  const out: Out = { d, scene, pdf, fonts: new Map(), images: new Map(), depth: 0 };
  for (const node of scene.children) paintNode(out, node, [scene.style], 1);
  d.restore();
  d.finish();
  return pdf.save();
}
