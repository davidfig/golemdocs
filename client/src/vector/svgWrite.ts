// A Scene as SVG text. Styles are written as presentation attributes (`fill="red"`), or inline
// `style` when the file has a stylesheet, whose rules the inline style wins over; paths that
// haven't been edited keep the `d` they were read with.

import { cloneElement, el, serializeXml } from '@golemdocs/docx';
import type { XmlElement, XmlNode } from '@golemdocs/docx';
import { fmt, isIdentity, serializeTransform } from './matrix.ts';
import type { Scene, SceneNode, Style, TextRun } from './model.ts';
import { serializePath } from './pathData.ts';
import { PRESENTATION } from './style.ts';

interface Options {
  /** Write the style of every node inline. */
  inlineStyle: boolean;
  /** `xlink:href` instead of `href`, for readers that predate SVG 2. */
  xlink: boolean;
}

function styleAttributes(style: Style, options: Options): Record<string, string> {
  const out: Record<string, string> = {};
  const inline: string[] = [];
  // In name order, so the same style is always written the same way.
  for (const [name, value] of Object.entries(style).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!options.inlineStyle && PRESENTATION.has(name)) out[name] = value;
    else inline.push(`${name}:${value}`);
  }
  if (inline.length) out.style = inline.join(';');
  return out;
}

function common(node: SceneNode, options: Options): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (node.id !== undefined) attrs.id = node.id;
  if (node.transform && !isIdentity(node.transform)) attrs.transform = serializeTransform(node.transform);
  Object.assign(attrs, node.attrs);
  Object.assign(attrs, styleAttributes(node.style, options));
  return attrs;
}

/** A line break and indent between the children of a structural element, which readers ignore. */
function spaced(children: XmlElement[], depth: number): XmlNode[] {
  const out: XmlNode[] = [];
  for (const c of children) out.push(`\n${'  '.repeat(depth + 1)}`, c);
  out.push(`\n${'  '.repeat(depth)}`);
  return out;
}

function textRunAttrs(run: TextRun, options: Options): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['x', 'y', 'dx', 'dy'] as const) if (run[name] !== undefined) out[name] = fmt(run[name]);
  return { ...out, ...styleAttributes(run.style, options) };
}

function writeNode(node: SceneNode, options: Options, depth: number): XmlElement {
  const link = options.xlink ? 'xlink:href' : 'href';
  switch (node.kind) {
    case 'group':
      return el(node.tag, common(node, options), spaced(node.children.map((c) => writeNode(c, options, depth + 1)), depth));
    case 'path':
      return el('path', { d: node.source ?? serializePath(node.commands), ...common(node, options) });
    case 'rect':
      return el('rect', {
        x: node.x ? fmt(node.x) : undefined,
        y: node.y ? fmt(node.y) : undefined,
        width: fmt(node.width),
        height: fmt(node.height),
        rx: node.rx ? fmt(node.rx) : undefined,
        ry: node.ry && node.ry !== node.rx ? fmt(node.ry) : undefined,
        ...common(node, options),
      });
    case 'ellipse':
      return node.rx === node.ry
        ? el('circle', { cx: fmt(node.cx), cy: fmt(node.cy), r: fmt(node.rx), ...common(node, options) })
        : el('ellipse', { cx: fmt(node.cx), cy: fmt(node.cy), rx: fmt(node.rx), ry: fmt(node.ry), ...common(node, options) });
    case 'text': {
      const attrs = common(node, options);
      const children: XmlNode[] = node.runs.map((run) => {
        const runAttrs = textRunAttrs(run, options);
        return Object.keys(runAttrs).length ? el('tspan', runAttrs, [run.text]) : run.text;
      });
      // x and y come first; a list of positions kept from the file (see svgRead) is already in the attributes.
      return el('text', { x: attrs.x ?? fmt(node.x), y: attrs.y ?? fmt(node.y), ...attrs }, children);
    }
    case 'image':
      return el('image', { x: node.x ? fmt(node.x) : undefined, y: node.y ? fmt(node.y) : undefined, width: fmt(node.width), height: fmt(node.height), [link]: node.href, ...common(node, options) });
    case 'use':
      return el('use', { [link]: `#${node.href}`, x: node.x ? fmt(node.x) : undefined, y: node.y ? fmt(node.y) : undefined, ...common(node, options) });
    case 'raw':
      return cloneElement(node.element);
  }
}

/** The scene as an SVG document. */
export function writeSvg(scene: Scene): string {
  const options: Options = { inlineStyle: scene.stylesheet, xlink: 'xmlns:xlink' in scene.attrs };
  const { viewBox: v } = scene;
  const attrs: Record<string, string> = { ...scene.attrs };
  if (!attrs.xmlns) attrs.xmlns = 'http://www.w3.org/2000/svg';
  const root = el(
    'svg',
    {
      ...attrs,
      width: fmt(scene.width),
      height: fmt(scene.height),
      viewBox: `${fmt(v.x)} ${fmt(v.y)} ${fmt(v.width)} ${fmt(v.height)}`,
      ...styleAttributes(scene.style, options),
    },
    spaced([...scene.defs.map((d) => cloneElement(d)), ...scene.children.map((c) => writeNode(c, options, 1))], 0),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n${serializeXml(root, false)}\n`;
}
