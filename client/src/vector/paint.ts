// Drawing a scene on a 2D canvas, at any scale: the vector editor's view, and the pixels a vector
// file has where a bitmap is wanted (thumbnails, and conversion to PNG, JPEG, WebP and Word).
// Coordinates are walked the way SVG does: each node's transform, then its style inherited
// from its parents. Painting is best effort for what a canvas can't do (filters, masks,
// per-group opacity): those parts of a file are left unpainted rather than wrongly painted.

import { elements } from '@golemdocs/docx';
import { makeCanvas } from '../formats/imageCodec.ts';
import { readClip } from './clip.ts';
import { findDefinition } from './gradients.ts';
import { readFragment } from './svgRead.ts';
import { readGradient } from './gradients.ts';
import { fontSizeOf, findNode, localBounds, outline, viewBoxMatrix } from './geometry.ts';
import type { Matrix, PathCommand, Scene, SceneNode, Style, TextNode } from './model.ts';
import type { Bounds } from './pathData.ts';
import { inherited, parseColor, parseLength, parseNumbers, urlReference } from './style.ts';
import type { Rgba } from './style.ts';

export type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Pictures a scene shows, decoded ahead of painting (see `loadImages`), by their `href`. */
export type ImageCache = ReadonlyMap<string, CanvasImageSource>;

export interface PaintOptions {
  images?: ImageCache;
  /** Nodes not to paint (the editor hides the one it is drawing itself while it is being changed). */
  skip?: (node: SceneNode) => boolean;
}

const rgba = ([r, g, b, a]: Rgba, opacity = 1): string => `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a * opacity))})`;

/** Adds a path's commands to the context's current path. */
export function tracePath(ctx: Context2D, commands: readonly PathCommand[]): void {
  for (const c of commands) {
    switch (c[0]) {
      case 'M':
        ctx.moveTo(c[1], c[2]);
        break;
      case 'L':
        ctx.lineTo(c[1], c[2]);
        break;
      case 'C':
        ctx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
        break;
      case 'Z':
        ctx.closePath();
        break;
    }
  }
}

const applyMatrix = (ctx: Context2D, m: Matrix): void => ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);

/** What a paint value (`fill` or `stroke`) turns into on a canvas: a colour or gradient, or nothing. */
function paintFor(ctx: Context2D, scene: Scene, value: string | undefined, chain: readonly Style[], box: Bounds | null, opacity: number): string | CanvasGradient | null {
  if (value === undefined || value === 'none') return null;
  const current = (): Rgba | null => parseColor(inherited(chain, 'color') ?? 'black');
  const reference = urlReference(value);
  if (reference) {
    const gradient = readGradient(scene, reference);
    if (!gradient || !gradient.stops.length) {
      // `url(#x) red`: the colour after the reference stands in when the paint server is missing.
      const fallback = parseColor(value.replace(/url\([^)]*\)/, '').trim());
      return fallback ? rgba(fallback, opacity) : null;
    }
    if (gradient.units === 'box' && !box) return null;
    const unit = (x: number, y: number): [number, number] => {
      const [tx, ty] = [gradient.transform[0] * x + gradient.transform[2] * y + gradient.transform[4], gradient.transform[1] * x + gradient.transform[3] * y + gradient.transform[5]];
      return gradient.units === 'box' ? [box!.x + tx * box!.width, box!.y + ty * box!.height] : [tx, ty];
    };
    const meanBox = gradient.units === 'box' ? (box!.width + box!.height) / 2 : 1;
    let g: CanvasGradient;
    if (gradient.type === 'linear') {
      const [x1, y1] = unit(gradient.x1, gradient.y1);
      const [x2, y2] = unit(gradient.x2, gradient.y2);
      g = ctx.createLinearGradient(x1, y1, x2, y2);
    } else {
      const [cx, cy] = unit(gradient.cx, gradient.cy);
      const [fx, fy] = unit(gradient.fx, gradient.fy);
      const r = gradient.r * meanBox * Math.sqrt(Math.abs(gradient.transform[0] * gradient.transform[3] - gradient.transform[1] * gradient.transform[2]));
      g = ctx.createRadialGradient(fx, fy, 0, cx, cy, Math.max(r, 1e-6));
    }
    for (const s of gradient.stops) g.addColorStop(s.offset, rgba(s.color, opacity));
    return g;
  }
  if (value === 'currentColor') {
    const color = current();
    return color ? rgba(color, opacity) : null;
  }
  const color = parseColor(value);
  return color ? rgba(color, opacity) : null;
}

interface Walk {
  ctx: Context2D;
  scene: Scene;
  options: PaintOptions;
  /** Nodes being shown by `use`, so a drawing that shows itself ends. */
  depth: number;
}

function paintShape(walk: Walk, node: SceneNode, chain: readonly Style[], commands: readonly PathCommand[]): void {
  const { ctx, scene } = walk;
  const box = localBounds(node, scene, chain);
  const fillOpacity = parseFloat(inherited(chain, 'fill-opacity') ?? '1');
  const strokeOpacity = parseFloat(inherited(chain, 'stroke-opacity') ?? '1');
  const fill = paintFor(ctx, scene, inherited(chain, 'fill') ?? 'black', chain, box, Number.isFinite(fillOpacity) ? fillOpacity : 1);
  const stroke = paintFor(ctx, scene, inherited(chain, 'stroke'), chain, box, Number.isFinite(strokeOpacity) ? strokeOpacity : 1);
  if (!fill && !stroke) return;
  ctx.beginPath();
  tracePath(ctx, commands);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill(inherited(chain, 'fill-rule') === 'evenodd' ? 'evenodd' : 'nonzero');
  }
  if (stroke) {
    const width = parseLength(inherited(chain, 'stroke-width')) ?? 1;
    if (width > 0) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      const cap = inherited(chain, 'stroke-linecap');
      ctx.lineCap = cap === 'round' || cap === 'square' ? cap : 'butt';
      const join = inherited(chain, 'stroke-linejoin');
      ctx.lineJoin = join === 'round' || join === 'bevel' ? join : 'miter';
      ctx.miterLimit = parseFloat(inherited(chain, 'stroke-miterlimit') ?? '4') || 4;
      const dashes = inherited(chain, 'stroke-dasharray');
      const list = dashes && dashes !== 'none' ? parseNumbers(dashes) : [];
      ctx.setLineDash(list.length && list.every((v) => v >= 0) && list.some((v) => v > 0) ? (list.length % 2 ? [...list, ...list] : list) : []);
      ctx.lineDashOffset = parseLength(inherited(chain, 'stroke-dashoffset')) ?? 0;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

/** The font shorthand for a run's style. */
function fontFor(chain: readonly Style[]): string {
  const style = inherited(chain, 'font-style');
  const weight = inherited(chain, 'font-weight');
  const family = inherited(chain, 'font-family') ?? 'sans-serif';
  return `${style === 'italic' || style === 'oblique' ? 'italic ' : ''}${weight && weight !== 'normal' ? `${weight} ` : ''}${fontSizeOf(chain)}px ${family}`;
}

function paintText(walk: Walk, node: TextNode, chain: readonly Style[]): void {
  const { ctx, scene } = walk;
  const anchor = inherited(chain, 'text-anchor');
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  // Widths of the runs, so a chunk can be centred or right-aligned as a whole.
  const widths = node.runs.map((run) => {
    ctx.font = fontFor([run.style, ...chain]);
    return ctx.measureText(run.text).width;
  });
  let total = 0;
  for (const w of widths) total += w;
  let x = node.x - (anchor === 'middle' ? total / 2 : anchor === 'end' ? total : 0);
  let y = node.y;
  node.runs.forEach((run, i) => {
    const runChain = [run.style, ...chain];
    if (run.x !== undefined) x = run.x - (anchor === 'middle' ? widths[i] / 2 : anchor === 'end' ? widths[i] : 0);
    if (run.y !== undefined) y = run.y;
    x += run.dx ?? 0;
    y += run.dy ?? 0;
    ctx.font = fontFor(runChain);
    const box = { x, y: y - fontSizeOf(runChain) * 0.8, width: widths[i], height: fontSizeOf(runChain) };
    const fillOpacity = parseFloat(inherited(runChain, 'fill-opacity') ?? '1');
    const fill = paintFor(ctx, scene, inherited(runChain, 'fill') ?? 'black', runChain, box, Number.isFinite(fillOpacity) ? fillOpacity : 1);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillText(run.text, x, y);
    }
    const stroke = paintFor(ctx, scene, inherited(runChain, 'stroke'), runChain, box, 1);
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = parseLength(inherited(runChain, 'stroke-width')) ?? 1;
      ctx.strokeText(run.text, x, y);
    }
    x += widths[i];
  });
}

function paintNode(walk: Walk, node: SceneNode, parentChain: readonly Style[]): void {
  const { ctx, scene, options } = walk;
  if (node.kind === 'raw' || options.skip?.(node)) return;
  const chain = [node.style, ...parentChain];
  if (node.style.display === 'none') return;
  // `visibility` is inherited, and a child may turn it back on (which `inherited` resolves); a group draws nothing itself.
  const visibility = inherited(chain, 'visibility');
  if (node.kind !== 'group' && (visibility === 'hidden' || visibility === 'collapse')) return;
  ctx.save();
  if (node.transform) applyMatrix(ctx, node.transform);
  const opacity = parseFloat(node.style.opacity ?? '1');
  if (Number.isFinite(opacity) && opacity < 1) ctx.globalAlpha *= Math.max(0, opacity);
  const clip = node.style['clip-path'];
  const cut = clip && clip !== 'none' ? readClip(scene, clip, localBounds(node, scene, chain)) : null;
  if (cut) {
    ctx.beginPath();
    tracePath(ctx, cut.commands);
    ctx.clip(cut.evenOdd ? 'evenodd' : 'nonzero');
  }
  const maskId = urlReference(node.style.mask);
  const mask = maskId ? maskLayer(walk, maskId, localBounds(node, scene, chain)) : null;
  if (mask) {
    // The node is drawn on a layer of its own, which is then cut by the mask's brightness and put on the drawing.
    const layer = makeCanvas(mask.canvas.width, mask.canvas.height);
    layer.context.setTransform(ctx.getTransform());
    drawContent({ ...walk, ctx: layer.context }, node, chain);
    layer.context.globalCompositeOperation = 'destination-in';
    layer.context.setTransform(1, 0, 0, 1, 0, 0);
    layer.context.drawImage(mask.canvas as CanvasImageSource, 0, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer.canvas as CanvasImageSource, 0, 0);
    ctx.restore();
  } else drawContent(walk, node, chain);
  ctx.restore();
}

function drawContent(walk: Walk, node: SceneNode, chain: readonly Style[]): void {
  const { ctx, scene, options } = walk;
  switch (node.kind) {
    case 'group':
      for (const child of node.children) paintNode(walk, child, chain);
      break;
    case 'path':
    case 'rect':
    case 'ellipse':
      if (node.kind !== 'rect' || (node.width > 0 && node.height > 0)) paintShape(walk, node, chain, outline(node)!);
      break;
    case 'text':
      paintText(walk, node, chain);
      break;
    case 'image': {
      const image = options.images?.get(node.href);
      if (image && node.width > 0 && node.height > 0) ctx.drawImage(image, node.x, node.y, node.width, node.height);
      break;
    }
    case 'use': {
      const target = findNode(scene, node.href);
      if (target && walk.depth < 16) {
        ctx.translate(node.x, node.y);
        paintNode({ ...walk, depth: walk.depth + 1 }, target, chain);
      }
      break;
    }
  }
}

/**
 * What a `mask` lets through, as a canvas the size of the one being painted: transparent where the
 * mask is black or empty, opaque where it is white. Null when there is no such mask, or the canvas
 * can't be read back (a mask is then ignored, and what it covers is painted as it is).
 */
function maskLayer(walk: Walk, id: string, box: Bounds | null): ReturnType<typeof makeCanvas> | null {
  const element = findDefinition(walk.scene, id);
  if (!element || element.name !== 'mask' || walk.depth > 8) return null;
  const { ctx, scene } = walk;
  const canvas = ctx.canvas;
  if (!canvas.width || !canvas.height) return null;
  let layer: ReturnType<typeof makeCanvas>;
  try {
    layer = makeCanvas(canvas.width, canvas.height);
  } catch {
    return null;
  }
  const mc = layer.context;
  if (typeof mc.getImageData !== 'function') return null;
  mc.setTransform(ctx.getTransform());
  // Content in the shape's own box units, when the mask says so.
  if (element.attrs.maskContentUnits === 'objectBoundingBox') {
    if (!box) return null;
    mc.transform(box.width, 0, 0, box.height, box.x, box.y);
  }
  const nodes = readFragment([...elements(element)], scene.viewBox.width, scene.viewBox.height);
  for (const node of nodes) paintNode({ ...walk, ctx: mc, depth: walk.depth + 1 }, node, [scene.style]);
  // Brightness becomes opacity: white is let through, black is not.
  const image = mc.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const luminance = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    d[i + 3] = Math.round(luminance * d[i + 3]);
    d[i] = d[i + 1] = d[i + 2] = 0;
  }
  mc.setTransform(1, 0, 0, 1, 0, 0);
  mc.putImageData(image, 0, 0);
  return layer;
}

/**
 * Paints a scene so that its drawing area fills `width` × `height` pixels of the context's current
 * coordinates (the context is left as it was). Nothing is painted behind it.
 */
export function paintScene(ctx: Context2D, scene: Scene, width = scene.width, height = scene.height, options: PaintOptions = {}): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  ctx.scale(width / scene.width, height / scene.height);
  applyMatrix(ctx, viewBoxMatrix(scene));
  const walk: Walk = { ctx, scene, options, depth: 0 };
  for (const node of scene.children) paintNode(walk, node, [scene.style]);
  ctx.restore();
}

/** The pictures inside a scene (data: URIs), decoded so that `paintScene` can draw them. */
export async function loadImages(scene: Scene, decode: (bytes: Uint8Array, mime: string) => Promise<CanvasImageSource>): Promise<ImageCache> {
  const cache = new Map<string, CanvasImageSource>();
  const visit = async (nodes: readonly SceneNode[]): Promise<void> => {
    for (const node of nodes) {
      if (node.kind === 'group') await visit(node.children);
      else if (node.kind === 'image' && !cache.has(node.href)) {
        const m = /^data:([^;,]+)((?:;[^;,]+)*),(.*)$/s.exec(node.href);
        if (!m || m[1] === 'image/svg+xml') continue;
        try {
          const bytes = m[2].includes(';base64') ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
          cache.set(node.href, await decode(bytes, m[1]));
        } catch {
          // A picture that can't be decoded is left out.
        }
      }
    }
  };
  await visit(scene.children);
  for (const node of Object.values(scene.defined)) await visit([node]);
  return cache;
}
