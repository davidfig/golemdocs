// SVG text to a Scene (see model.ts). Shapes become typed nodes with their style resolved from the
// presentation attributes, the stylesheet and the `style` attribute (in that order of strength);
// everything the scene doesn't model is kept as XML so that writing it back loses nothing.

import { parseXml, textContent } from '@golemdocs/docx';
import type { XmlElement } from '@golemdocs/docx';
import { parseTransform } from './matrix.ts';
import type { EllipseNode, GroupNode, ImageNode, Matrix, PathCommand, PathNode, RawNode, RectNode, Scene, SceneNode, Style, TextNode, TextRun, UseNode } from './model.ts';
import { parsePath } from './pathData.ts';
import { PRESENTATION, parseDeclarations, parseLength, parseNumbers, parseStylesheet, styleFor } from './style.ts';
import type { Matchable } from './style.ts';

/** Thrown for text that is not an SVG document. */
export class SvgError extends Error {}

/** Elements that define things other elements refer to, or hold the file's own bookkeeping: they go in `Scene.defs`. */
const DEFINITIONS = new Set(['defs', 'style', 'linearGradient', 'radialGradient', 'clipPath', 'mask', 'filter', 'pattern', 'marker', 'symbol', 'script', 'font-face', 'cursor', 'view']);
const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);

interface Context {
  rules: ReturnType<typeof parseStylesheet>;
  /** What 100% means for horizontal and vertical lengths. */
  width: number;
  height: number;
  defs: XmlElement[];
}

const hasValue = (v: string | undefined): v is string => v !== undefined && v.trim() !== '';

/** The attributes of an element split into: the style that applies to it, and the attributes that are not modelled. */
function split(e: XmlElement, context: Context, parent: Matchable | undefined, consumed: ReadonlySet<string>): { style: Style; attrs: Record<string, string>; matchable: Matchable } {
  const matchable: Matchable = { tag: e.name, id: e.attrs.id, classes: (e.attrs.class ?? '').split(/\s+/).filter(Boolean), parent };
  const style: Style = {};
  const attrs: Record<string, string> = {};
  for (const [name, value] of Object.entries(e.attrs)) {
    if (consumed.has(name) || name === 'style') continue;
    if (PRESENTATION.has(name)) style[name] = value.trim();
    else attrs[name] = value;
  }
  for (const [name, value] of styleFor(context.rules, matchable)) style[name] = value;
  if (e.attrs.style) for (const [name, value] of parseDeclarations(e.attrs.style)) style[name] = value;
  return { style, attrs, matchable };
}

const GEOMETRY = ['x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'points', 'd'];
const COMMON = ['id', 'transform', 'href', 'xlink:href'];

function transformOf(e: XmlElement, attrs: Record<string, string>): Matrix | undefined {
  const text = e.attrs.transform;
  if (!hasValue(text)) return undefined;
  const matrix = parseTransform(text);
  // A transform we can't read is kept as an attribute rather than dropped.
  if (!matrix) attrs.transform = text;
  return matrix ?? undefined;
}

function base(e: XmlElement, context: Context, parent: Matchable | undefined, extra: readonly string[] = []) {
  const consumed = new Set([...COMMON, ...extra]);
  const { style, attrs, matchable } = split(e, context, parent, consumed);
  const common = { style, attrs, ...(e.attrs.id !== undefined && { id: e.attrs.id }) };
  const transform = transformOf(e, attrs);
  return { common: { ...common, ...(transform && { transform }) }, matchable };
}

/** An element kept whole: nothing is split off it, so it is written back as it was. */
const raw = (e: XmlElement): RawNode => ({ kind: 'raw', element: e, style: {}, attrs: {} });

function pointsPath(points: string | undefined, close: boolean): PathCommand[] {
  const n = parseNumbers(points);
  const out: PathCommand[] = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push([i === 0 ? 'M' : 'L', n[i], n[i + 1]]);
  if (close && out.length) out.push(['Z']);
  return out;
}

function shape(e: XmlElement, context: Context, parent: Matchable | undefined): SceneNode | null {
  const { common } = base(e, context, parent, GEOMETRY);
  const { width: w, height: h } = context;
  const x = (name: string): number => parseLength(e.attrs[name], w) ?? 0;
  const y = (name: string): number => parseLength(e.attrs[name], h) ?? 0;
  switch (e.name) {
    case 'path': {
      const node: PathNode = { kind: 'path', commands: parsePath(e.attrs.d ?? ''), ...common };
      if (hasValue(e.attrs.d)) node.source = e.attrs.d;
      return node;
    }
    case 'rect': {
      let rx = parseLength(e.attrs.rx, w);
      let ry = parseLength(e.attrs.ry, h);
      if (rx === null) rx = ry ?? 0;
      if (ry === null) ry = rx;
      const node: RectNode = { kind: 'rect', x: x('x'), y: y('y'), width: x('width'), height: y('height'), rx: Math.max(0, rx), ry: Math.max(0, ry), ...common };
      return node;
    }
    case 'circle': {
      const r = parseLength(e.attrs.r, Math.sqrt((w * w + h * h) / 2)) ?? 0;
      const node: EllipseNode = { kind: 'ellipse', cx: x('cx'), cy: y('cy'), rx: r, ry: r, ...common };
      return node;
    }
    case 'ellipse': {
      let rx = parseLength(e.attrs.rx, w);
      let ry = parseLength(e.attrs.ry, h);
      if (rx === null) rx = ry ?? 0;
      if (ry === null) ry = rx;
      const node: EllipseNode = { kind: 'ellipse', cx: x('cx'), cy: y('cy'), rx, ry, ...common };
      return node;
    }
    case 'line': {
      const node: PathNode = { kind: 'path', commands: [['M', x('x1'), y('y1')], ['L', x('x2'), y('y2')]], ...common };
      return node;
    }
    default: {
      const node: PathNode = { kind: 'path', commands: pointsPath(e.attrs.points, e.name === 'polygon'), ...common };
      return node;
    }
  }
}

/** Collapses white space as SVG does without `xml:space="preserve"`: line breaks go, tabs become spaces, runs of spaces become one. */
function collapse(runs: TextRun[], preserve: boolean): void {
  if (preserve) {
    for (const r of runs) r.text = r.text.replace(/[\n\r\t]/g, ' ');
    return;
  }
  let previousEndsWithSpace = true;
  for (const r of runs) {
    let text = r.text.replace(/[\n\r]/g, '').replace(/[\t ]+/g, ' ');
    if (previousEndsWithSpace && text.startsWith(' ')) text = text.slice(1);
    r.text = text;
    if (text) previousEndsWithSpace = text.endsWith(' ');
  }
  const last = runs.filter((r) => r.text).pop();
  if (last) last.text = last.text.replace(/ $/, '');
}

function firstNumber(value: string | undefined, percentOf: number): number | undefined {
  if (!hasValue(value)) return undefined;
  return parseLength(value.trim().split(/[\s,]+/)[0], percentOf) ?? undefined;
}

function text(e: XmlElement, context: Context, parent: Matchable | undefined): SceneNode {
  const { common, matchable } = base(e, context, parent, ['x', 'y', 'dx', 'dy']);
  let supported = true;
  const runs: TextRun[] = [];
  const walk = (children: XmlElement['children'], inherited: Style, scope: Matchable): void => {
    for (const child of children) {
      if (typeof child === 'string') {
        if (child) runs.push({ text: child, style: { ...inherited } });
        continue;
      }
      if (child.name !== 'tspan') {
        // textPath, a, title...: not modelled.
        if (child.name !== 'title' && child.name !== 'desc') supported = false;
        continue;
      }
      const { style, attrs, matchable: m } = split(child, context, scope, new Set(['x', 'y', 'dx', 'dy', 'id']));
      if (Object.keys(attrs).some((a) => a !== 'class' && a !== 'xml:space')) supported = false;
      const merged = { ...inherited, ...style };
      const x = firstNumber(child.attrs.x, context.width);
      const y = firstNumber(child.attrs.y, context.height);
      const dx = firstNumber(child.attrs.dx, context.width);
      const dy = firstNumber(child.attrs.dy, context.height);
      const startAt = runs.length;
      walk(child.children, merged, m);
      // A position belongs to the first run the tspan holds.
      const first = runs[startAt];
      if (first && startAt < runs.length) Object.assign(first, { ...(x !== undefined && { x }), ...(y !== undefined && { y }), ...(dx !== undefined && { dx }), ...(dy !== undefined && { dy }) });
    }
  };
  walk(e.children, {}, matchable);
  if (!supported) return raw(e);
  collapse(runs, e.attrs['xml:space'] === 'preserve');
  // Lists of positions (a value per letter) are kept as written; the node's position is the first.
  for (const name of ['x', 'y', 'dx', 'dy'] as const) if (/[\s,]/.test((e.attrs[name] ?? '').trim())) common.attrs[name] = e.attrs[name];
  const node: TextNode = { kind: 'text', x: firstNumber(e.attrs.x, context.width) ?? 0, y: firstNumber(e.attrs.y, context.height) ?? 0, runs: runs.filter((r) => r.text !== ''), ...common };
  const dx = firstNumber(e.attrs.dx, context.width);
  const dy = firstNumber(e.attrs.dy, context.height);
  if (dx) node.x += dx;
  if (dy) node.y += dy;
  return node;
}

function convert(e: XmlElement, context: Context, parent: Matchable | undefined): SceneNode | null {
  const name = e.name;
  if (DEFINITIONS.has(name)) {
    context.defs.push(e);
    return null;
  }
  if (name === 'g' || name === 'a') {
    const { common, matchable } = base(e, context, parent);
    const node: GroupNode = { kind: 'group', tag: name, children: children(e, context, matchable), ...common };
    return node;
  }
  if (SHAPES.has(name)) return shape(e, context, parent);
  if (name === 'text') return text(e, context, parent);
  if (name === 'image') {
    const { common } = base(e, context, parent, ['x', 'y', 'width', 'height']);
    const node: ImageNode = { kind: 'image', x: parseLength(e.attrs.x, context.width) ?? 0, y: parseLength(e.attrs.y, context.height) ?? 0, width: parseLength(e.attrs.width, context.width) ?? 0, height: parseLength(e.attrs.height, context.height) ?? 0, href: e.attrs.href ?? e.attrs['xlink:href'] ?? '', ...common };
    return node;
  }
  if (name === 'use') {
    const link = e.attrs.href ?? e.attrs['xlink:href'] ?? '';
    if (!link.startsWith('#')) return raw(e);
    const { common } = base(e, context, parent, ['x', 'y']);
    const node: UseNode = { kind: 'use', href: link.slice(1), x: parseLength(e.attrs.x, context.width) ?? 0, y: parseLength(e.attrs.y, context.height) ?? 0, ...common };
    return node;
  }
  return raw(e);
}

function children(e: XmlElement, context: Context, parent: Matchable | undefined): SceneNode[] {
  const out: SceneNode[] = [];
  for (const child of e.children) {
    if (typeof child === 'string') continue;
    const node = convert(child, context, parent);
    if (node) out.push(node);
  }
  return out;
}

/** The nodes `use` can show: drawable elements with an id inside `defs`, and each `symbol` as a group. */
function collectDefined(elements: readonly XmlElement[], context: Context, out: Record<string, SceneNode>): void {
  for (const e of elements) {
    if (e.name === 'defs') {
      for (const c of e.children) {
        if (typeof c === 'string') continue;
        if (c.name === 'defs' || c.name === 'symbol') collectDefined([c], context, out);
        else if (!DEFINITIONS.has(c.name)) {
          const node = convert(c, context, undefined);
          if (node?.id !== undefined) out[node.id] = node;
        }
      }
    } else if (e.name === 'symbol' && e.attrs.id !== undefined) {
      const group: GroupNode = { kind: 'group', tag: 'g', id: e.attrs.id, children: children(e, context, undefined), style: {}, attrs: {} };
      out[e.attrs.id] = group;
    }
  }
}

/** Finds `style` elements anywhere in the tree. */
function stylesheets(e: XmlElement, out: string[] = []): string[] {
  if (e.name === 'style' && (!e.attrs.type || e.attrs.type === 'text/css')) out.push(textContent(e));
  for (const c of e.children) if (typeof c !== 'string') stylesheets(c, out);
  return out;
}

/** Reads an SVG document. Throws SvgError when the text is not one. */
export function readSvg(source: string): Scene {
  let root: XmlElement;
  try {
    root = parseXml(source);
  } catch (e) {
    throw new SvgError((e as Error).message);
  }
  // Documents may bind the SVG namespace to a prefix (`svg:svg`): the names are read without it.
  if (root.name.endsWith(':svg')) throw new SvgError('prefixed SVG elements are not supported');
  if (root.name !== 'svg') throw new SvgError('not an SVG document');

  const box = parseNumbers(root.attrs.viewBox);
  const widthAttr = parseLength(root.attrs.width, 0);
  const heightAttr = parseLength(root.attrs.height, 0);
  const hasBox = box.length === 4 && box[2] > 0 && box[3] > 0;
  const percent = (v: string | undefined): boolean => !!v && v.trim().endsWith('%');
  const viewBox = hasBox
    ? { x: box[0], y: box[1], width: box[2], height: box[3] }
    : { x: 0, y: 0, width: widthAttr && !percent(root.attrs.width) ? widthAttr : 300, height: heightAttr && !percent(root.attrs.height) ? heightAttr : 150 };
  // A missing size is the view box's; one side missing keeps the view box's shape.
  let width = widthAttr && !percent(root.attrs.width) ? widthAttr : 0;
  let height = heightAttr && !percent(root.attrs.height) ? heightAttr : 0;
  if (!width && !height) {
    width = viewBox.width;
    height = viewBox.height;
  } else if (!width) width = (height * viewBox.width) / viewBox.height;
  else if (!height) height = (width * viewBox.height) / viewBox.width;

  const css = stylesheets(root);
  const context: Context = { rules: css.flatMap((c) => parseStylesheet(c)), width: viewBox.width, height: viewBox.height, defs: [] };
  const { style, attrs } = split(root, context, undefined, new Set(['width', 'height', 'viewBox']));
  const scene: Scene = { width, height, viewBox, style, attrs, defs: context.defs, children: [], defined: {}, stylesheet: css.length > 0 };
  const rootMatchable: Matchable = { tag: 'svg', id: root.attrs.id, classes: (root.attrs.class ?? '').split(/\s+/).filter(Boolean) };
  scene.children = children(root, context, rootMatchable);
  // Converting the definitions' content must not add to the definitions themselves.
  const kept = [...context.defs];
  collectDefined(kept, context, scene.defined);
  context.defs.length = kept.length;
  return scene;
}
