// A slide as a drawing scene (docs/slides.md): the vector editor's model (vector/model.ts), so a slide is painted, written as
// SVG and as a vector PDF page by the code that does it for drawings. Its shapes are drawn by DrawingML's ShapeBuilder
// (drawingml/scene.ts); here are the slide's own parts: its background, placeholders' inherited text and prompts, tables,
// charts and SmartArt. Next to the scene comes where each shape and its text lines ended up, for the editor.
//
// Units are CSS pixels (9525 EMU each), the slide's top left at (0, 0). Pictures are named `pptx:<part>` and decoded by the
// caller (the view keeps them as bitmaps; an export turns them into data: URIs).

import type { XmlElement } from '@golemdocs/docx';
import { IDENTITY, type GroupNode, type Matrix, type Scene, type SceneNode } from '../vector/model.ts';
import { readSvg } from '../vector/svgRead.ts';
import { multiply, scaling, translation } from '../vector/matrix.ts';
import { readChart } from '../sheet/charts/model.ts';
import { defaultColor, layoutChart, type Resolved } from '../sheet/charts/scene.ts';
import { chartSvg } from '../sheet/charts/svg.ts';
import { resolveColor, colorChild, type ColorContext } from '../drawingml/color.ts';
import { px, ShapeBuilder, type ShapeSceneOptions, type ShapeText, type ShapeView as DrawingShapeView } from '../drawingml/scene.ts';
import { layoutText, type LaidText, type TextMeasure } from '../drawingml/textLayout.ts';
import { masterOfPage, type Deck, type DeckPart, type PagePart } from './deck.ts';
import { at, kid, kids, num } from './ooxml.ts';
import { backgroundFill, resolveTree, slideShapes, type ResolvedFill, type ResolvedLine, type ResolvedShape } from './shapes.ts';
import { promptText, readBody, shapeText, slideTextContext, type BodySettings, type Paragraph, type TextBody, type TextContext } from './textStyle.ts';
import { tableStyle, type CellStyle } from './tables.ts';


export interface SceneOptions extends ShapeSceneOptions {
  /** The slide's number (1-based), for slide number fields. */
  number: number;
  date?: Date;
}

/** A slide's shape where it is drawn, and its text. */
export type ShapeView = DrawingShapeView<ResolvedShape>;
export type { ShapeText };

/** A picture's href in a slide's scene: `pptx:<part>`, decoded by the caller. */
function embedHref(deck: Deck, part: DeckPart, rId: string | undefined): string | null {
  const target = deck.target(part, rId);
  return target ? `pptx:${target}` : null;
}

export interface SlideScene {
  scene: Scene;
  views: ShapeView[];
}

/** A slide's shapes: DrawingML's (drawingml/scene.ts), with placeholders' inherited text and prompts, tables, charts and SmartArt. */
class Builder extends ShapeBuilder<ResolvedShape> {
  constructor(
    readonly deck: Deck,
    readonly part: PagePart,
    readonly options: SceneOptions,
    ctx: ColorContext,
    readonly stc: TextContext,
  ) {
    super(options, ctx, stc, (rId, shape) => embedHref(deck, shape.part, rId));
  }

  protected override textOf(shape: ResolvedShape): TextBody {
    return shapeText(shape, this.stc);
  }

  /** Only the page's own placeholders show their prompt. */
  protected override promptOf(shape: ResolvedShape): Paragraph[] | null {
    return shape.part === this.part ? promptText(shape, this.stc) : null;
  }

  protected override alwaysHasText(shape: ResolvedShape): boolean {
    return !!shape.placeholder;
  }

  protected override inherited(shape: ResolvedShape): boolean {
    return shape.part !== this.part;
  }

  /** The slide's own shapes are named by id, so a show can hide those its animations bring in later. */
  protected override nodeAttrs(shape: ResolvedShape, top: ResolvedShape | null): Record<string, string> {
    return shape.part !== this.part || top ? {} : { 'data-shape': shape.id };
  }

  protected override other(node: GroupNode, view: ShapeView, shape: ResolvedShape, matrix: Matrix, top: ResolvedShape): void {
    if (shape.kind === 'table') this.table(node, view, shape);
    else if (shape.kind === 'chart') this.chart(node, shape, view.w, view.h);
    else if (shape.kind === 'diagram') this.diagram(node, shape, matrix, top);
    else super.other(node, view, shape, matrix, top);
  }

  // ---- Tables, charts, diagrams -----------------------------------------------------------------------------------------

  table(node: GroupNode, view: ShapeView, shape: ResolvedShape): void {
    const tbl = at(shape.element, 'a:graphic/a:graphicData/a:tbl');
    if (!tbl) return;
    const cols = kids(kid(tbl, 'a:tblGrid'), 'a:gridCol').map((c) => px(num(c, 'w') ?? 0));
    const rows = kids(tbl, 'a:tr');
    const style = tableStyle(this.deck, kid(tbl, 'a:tblPr'), this.ctx);
    const cells: NonNullable<ShapeView['cells']> = [];
    const heights = rows.map((r) => px(num(r, 'h') ?? 0));
    const lefts = cols.reduce<number[]>((acc, _, i) => (acc.push(i ? acc[i - 1] + cols[i - 1] : 0), acc), []);
    const base = kid(this.deck.presentation.xml, 'p:defaultTextStyle');
    // First pass: lay out each cell's text and grow rows to fit.
    const laidOut: { r: number; c: number; tc: XmlElement; span: number; rowSpan: number; cell: CellStyle; settings: BodySettings; paragraphs: Paragraph[] }[] = [];
    rows.forEach((tr, r) => {
      kids(tr, 'a:tc').forEach((tc, c) => {
        if (tc.attrs.hMerge === '1' || tc.attrs.vMerge === '1') return;
        const span = Number(tc.attrs.gridSpan) || 1;
        const rowSpan = Number(tc.attrs.rowSpan) || 1;
        const cell = style.cell(r, c, rows.length, cols.length);
        const tcPr = kid(tc, 'a:tcPr');
        const settings: BodySettings = {
          insets: { l: num(tcPr, 'marL') ?? 91440, r: num(tcPr, 'marR') ?? 91440, t: num(tcPr, 'marT') ?? 45720, b: num(tcPr, 'marB') ?? 45720 },
          anchor: tcPr?.attrs.anchor === 'ctr' ? 'ctr' : tcPr?.attrs.anchor === 'b' ? 'b' : 't',
          anchorCtr: false,
          wrap: true,
          vert: tcPr?.attrs.vert ?? 'horz',
          autofit: 'none',
          fontScale: 1,
          lineReduction: 0,
          rot: 0,
          columns: 1,
        };
        const paragraphs = readBody(kid(tc, 'a:txBody'), [base, cell.text], settings, this.stc);
        const width = cols.slice(c, c + span).reduce((a, b) => a + b, 0);
        const laid = layoutText(paragraphs, { width: Math.max(0, width - px(settings.insets.l) - px(settings.insets.r)), measure: this.options.measure });
        const needed = laid.height + px(settings.insets.t) + px(settings.insets.b);
        if (rowSpan === 1 && needed > heights[r]) heights[r] = needed;
        laidOut.push({ r, c, tc, span, rowSpan, cell, settings, paragraphs });
      });
    });
    const tops = heights.reduce<number[]>((acc, _, i) => (acc.push(i ? acc[i - 1] + heights[i - 1] : 0), acc), []);
    const borders: SceneNode[] = [];
    for (const item of laidOut) {
      const x = lefts[item.c] ?? 0;
      const y = tops[item.r] ?? 0;
      const cw = cols.slice(item.c, item.c + item.span).reduce((a, b) => a + b, 0);
      const ch = heights.slice(item.r, item.r + item.rowSpan).reduce((a, b) => a + b, 0);
      const tcPr = kid(item.tc, 'a:tcPr');
      const ownFill = tcPr ? kids(tcPr).find((k) => ['a:noFill', 'a:solidFill', 'a:gradFill'].includes(k.name)) : undefined;
      const fill = ownFill ? this.readFill(ownFill) : item.cell.fill;
      if (fill && fill.kind !== 'none') node.children.push({ kind: 'rect', x, y, width: cw, height: ch, rx: 0, ry: 0, style: this.fillStyle(fill), attrs: {} });
      const edge = (name: string, fallback: ResolvedLine | null, x1: number, y1: number, x2: number, y2: number): void => {
        const ln = kid(tcPr, name);
        const line = ln ? this.readLine(ln) : fallback;
        if (!line?.color) return;
        borders.push({ kind: 'path', commands: [['M', x1, y1], ['L', x2, y2]], style: { fill: 'none', ...this.lineStyle(line) }, attrs: {} });
      };
      edge('a:lnL', item.cell.left, x, y, x, y + ch);
      edge('a:lnR', item.cell.right, x + cw, y, x + cw, y + ch);
      edge('a:lnT', item.cell.top, x, y, x + cw, y);
      edge('a:lnB', item.cell.bottom, x, y + ch, x + cw, y + ch);
      const placed = this.placeText(item.paragraphs, item.settings, { l: x, t: y, r: x + cw, b: y + ch });
      const text: ShapeText = { body: { settings: item.settings, paragraphs: item.paragraphs, element: kid(item.tc, 'a:txBody') ?? null }, ...placed, prompt: false };
      if (!this.options.skipText?.(item.tc)) node.children.push(...this.drawText(text, 1));
      cells.push({ row: item.r, col: item.c, x, y, w: cw, h: ch, text, element: item.tc });
    }
    node.children.push(...borders);
    view.cells = cells;
  }

  readFill(element: XmlElement): ResolvedFill | null {
    if (element.name === 'a:noFill') return { kind: 'none' };
    const color = resolveColor(colorChild(element), this.ctx);
    return color ? { kind: 'solid', color } : null;
  }

  readLine(ln: XmlElement): ResolvedLine | null {
    if (kid(ln, 'a:noFill')) return null;
    const color = resolveColor(colorChild(kid(ln, 'a:solidFill')), this.ctx);
    if (!color) return null;
    return { color, width: num(ln, 'w') ?? 12700, dash: kid(ln, 'a:prstDash')?.attrs.val ?? 'solid', cap: 'butt', join: 'miter', head: null, tail: null, compound: 'sng' };
  }

  chart(node: GroupNode, shape: ResolvedShape, w: number, h: number): void {
    const rId = at(shape.element, 'a:graphic/a:graphicData/c:chart')?.attrs['r:id'];
    const part = this.deck.target(shape.part, rId);
    const xml = part ? this.deck.part(part)?.xml : undefined;
    const accents = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'].map((a) => {
      const c = this.ctx.theme.colors[a] ?? { r: 0x44, g: 0x72, b: 0xc4, a: 1 };
      return (c.r << 16) | (c.g << 8) | c.b;
    });
    const chart = xml ? readChart(xml, [0, 0, 0, 0, ...accents]) : null;
    if (!chart) {
      node.children.push({ kind: 'rect', x: 0, y: 0, width: w, height: h, rx: 0, ry: 0, style: { fill: '#ffffff', stroke: '#d9d9d9' }, attrs: {} });
      return;
    }
    let n = 0;
    const series: Resolved[][] = chart.groups.map((g) => g.series.map((s) => ({ name: s.name, cats: s.cats, vals: s.vals, xs: s.xs, color: s.color ?? defaultColor(accents, n++), series: s })));
    const pt = 0.75;
    const laid = layoutChart(chart, series, w * pt, h * pt, accents);
    const scene = readSvg(chartSvg({ width: w * pt, height: h * pt, ...laid }));
    node.children.push({ kind: 'group', tag: 'g', transform: scaling(1 / pt), style: {}, attrs: {}, children: scene.children });
  }

  diagram(node: GroupNode, shape: ResolvedShape, matrix: Matrix, top: ResolvedShape): void {
    // SmartArt: its drawing part holds the shapes as last laid out, in the frame's coordinates.
    const drawings = shape.part.rels.list.filter((r) => r.type.endsWith('/diagramDrawing'));
    const frames = kids(at(shape.part.xml, 'p:cSld/p:spTree'), 'p:graphicFrame').filter((f) => at(f, 'a:graphic/a:graphicData')?.attrs.uri?.endsWith('/diagram'));
    const index = Math.max(0, frames.indexOf(shape.element));
    const rel = drawings[index] ?? drawings[0];
    const xml = rel ? this.deck.part(shape.part.rels.partName(rel))?.xml : undefined;
    const tree = xml ? kids(xml).find((k) => k.name.endsWith(':spTree')) : undefined;
    if (!tree) return;
    const asP = renamePrefix(tree, 'p');
    const shapes = resolveTree(asP, shape.part, this.deck);
    const origin = translation(-px(shape.frame.x), -px(shape.frame.y));
    const inner: GroupNode = { kind: 'group', tag: 'g', transform: origin, style: {}, attrs: {}, children: [] };
    for (const child of shapes) {
      const made = this.shape(child, multiply(matrix, origin), top);
      if (made) inner.children.push(made);
    }
    node.children.push(inner);
  }
}

/** A drawing part's shapes (`dsp:sp`...) read as a slide's (`p:sp`...), which they are in all but name. */
function renamePrefix(element: XmlElement, prefix: string): XmlElement {
  const colon = element.name.indexOf(':');
  const local = element.name.slice(colon + 1);
  const name = colon > 0 && !element.name.startsWith('a:') && !element.name.startsWith('r:') ? `${prefix}:${local}` : element.name;
  return { name, attrs: element.attrs, children: element.children.map((c) => (typeof c === 'string' ? c : renamePrefix(c, prefix))) };
}

/** The colour context a slide's shapes use. */
export function colorContext(deck: Deck, slide: PagePart): ColorContext {
  return { theme: masterOfPage(slide).theme, map: deck.colorMap(slide) };
}

/** A slide drawn as a scene, with where its shapes and text are. */
export function slideScene(deck: Deck, slide: PagePart, options: SceneOptions): SlideScene {
  const ctx = colorContext(deck, slide);
  const tc = slideTextContext(deck, slide, ctx, options.number, options.date ?? new Date());
  const builder = new Builder(deck, slide, options, ctx, tc);
  const width = px(deck.width);
  const height = px(deck.height);
  const children: SceneNode[] = [];
  const bg = backgroundFill(deck, slide, ctx);
  if (bg.kind === 'picture' && bg.blip) {
    const group: GroupNode = { kind: 'group', tag: 'g', style: {}, attrs: {}, children: [] };
    const chain: DeckPart[] = 'layout' in slide ? [slide, slide.layout, slide.layout.master] : 'master' in slide ? [slide, slide.master] : [slide];
    const owner = chain.find((p) => at(p.xml, 'p:cSld/p:bg/p:bgPr/a:blipFill')) ?? slide;
    builder.blipInto(group, bg.blip, embedHref(deck, owner, kid(bg.blip, 'a:blip')?.attrs['r:embed']), width, height);
    children.push({ kind: 'rect', x: 0, y: 0, width, height, rx: 0, ry: 0, style: { fill: '#ffffff' }, attrs: { 'data-bg': '1' } }, { ...group, attrs: { 'data-bg': '1' } });
  } else children.push({ kind: 'rect', x: 0, y: 0, width, height, rx: 0, ry: 0, style: bg.kind === 'none' ? { fill: '#ffffff' } : builder.fillStyle(bg), attrs: { 'data-bg': '1' } });
  for (const shape of slideShapes(deck, slide)) {
    const node = builder.shape(shape, IDENTITY, null);
    if (node) children.push(node);
  }
  const scene: Scene = {
    width,
    height,
    viewBox: { x: 0, y: 0, width, height },
    style: {},
    attrs: { xmlns: 'http://www.w3.org/2000/svg' },
    defs: builder.defs,
    children,
    defined: {},
    stylesheet: false,
  };
  return { scene, views: builder.views };
}

/** Lays out a text body alone (the notes, an outline), with a given width. */
export function layoutBody(body: TextBody, width: number, measure: TextMeasure): LaidText {
  return layoutText(body.paragraphs, { width, measure });
}

