// The vector scene: what an SVG file is once read, and what the vector editor changes. It is a
// tree of typed nodes (groups, paths, rectangles, ellipses, text, pictures) with their geometry in
// the node's own coordinates and a `transform` placing it in its parent. Paths hold absolute
// lines and cubic curves only (quadratics and arcs are converted when read), which is all the
// editor needs to handle.
//
// What the scene doesn't model (filters, masks, gradients' stops, symbols, scripts, animation...)
// is kept as raw XML in `defs`, `raw` nodes and each node's `attrs`, and written back untouched, so
// opening and saving a file doesn't lose what it had.

import type { XmlElement } from '@golemdocs/docx';

/** An affine transform [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f (the SVG matrix()). */
export type Matrix = readonly [number, number, number, number, number, number];

export type PathCommand =
  | readonly ['M', number, number]
  | readonly ['L', number, number]
  | readonly ['C', number, number, number, number, number, number]
  | readonly ['Z'];

/** CSS properties set on a node (after the stylesheet and `style` attribute are applied), by name: `fill`, `stroke-width`... Inherited values are looked up through the parents, see style.ts. */
export type Style = Record<string, string>;

interface Base {
  /** Names the node among everyone's when a drawing is edited together (see nodes.ts); never written to the file. */
  uid?: string;
  /** The `id` attribute, which other elements refer to (gradients, clip paths, `use`). */
  id?: string;
  /** Places the node's coordinates in its parent's. Absent: the identity. */
  transform?: Matrix;
  style: Style;
  /** Attributes the scene doesn't model (`class`, `data-*`...), kept in order. */
  attrs: Record<string, string>;
}

export interface GroupNode extends Base {
  kind: 'group';
  /** The element it was read from (`g`, `a`...), written back as it was. */
  tag: string;
  children: SceneNode[];
}

export interface PathNode extends Base {
  kind: 'path';
  commands: PathCommand[];
  /** The `d` attribute as read. Written back as it is until the commands change: whoever edits `commands` deletes this. */
  source?: string;
}

export interface RectNode extends Base {
  kind: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
  ry: number;
}

export interface EllipseNode extends Base {
  kind: 'ellipse';
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** A piece of text with its own position and style (an SVG `tspan`, or the text element's own). */
export interface TextRun {
  text: string;
  /** Absolute position of the run, when it sets one. */
  x?: number;
  y?: number;
  /** Offset from where the previous run ended. */
  dx?: number;
  dy?: number;
  style: Style;
}

export interface TextNode extends Base {
  kind: 'text';
  x: number;
  y: number;
  runs: TextRun[];
}

export interface ImageNode extends Base {
  kind: 'image';
  x: number;
  y: number;
  width: number;
  height: number;
  /** A data: URI or a link; links outside the file are not fetched. */
  href: string;
}

/** An instance of another element (`use`), drawn at (x, y). */
export interface UseNode extends Base {
  kind: 'use';
  /** The id of the element it shows, without the `#`. */
  href: string;
  x: number;
  y: number;
}

/** An element the scene doesn't understand (`foreignObject`, `switch`, a nested `svg`...): not drawn, kept as it was. */
export interface RawNode extends Base {
  kind: 'raw';
  element: XmlElement;
}

export type SceneNode = GroupNode | PathNode | RectNode | EllipseNode | TextNode | ImageNode | UseNode | RawNode;

export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Scene {
  /** The drawing's size in CSS pixels (the `width` and `height` of the svg element, or the view box when it has none). */
  width: number;
  height: number;
  viewBox: ViewBox;
  /** Style set on the svg element itself, which everything inherits. */
  style: Style;
  /** The svg element's other attributes (namespaces, `preserveAspectRatio`...), in order. */
  attrs: Record<string, string>;
  /** `defs` content and other non-drawing elements (`style`, `title`, `metadata`, `linearGradient`...), kept as XML. */
  defs: XmlElement[];
  children: SceneNode[];
  /**
   * The drawable elements in `defs` and `symbol`s that have an id (what `use` shows), read into nodes.
   * Derived from `defs` when the file is read: the XML in `defs` is what is written back.
   */
  defined: Record<string, SceneNode>;
  /** Whether the file has a stylesheet: node styles are then written inline (`style="..."`), which wins over it. */
  stylesheet: boolean;
}

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function emptyScene(width = 512, height = 512): Scene {
  return { width, height, viewBox: { x: 0, y: 0, width, height }, style: {}, attrs: { xmlns: 'http://www.w3.org/2000/svg' }, defs: [], children: [], defined: {}, stylesheet: false };
}
