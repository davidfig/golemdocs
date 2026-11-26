// The sheet's pictures, shapes, lines and text boxes on the page (drawings.ts holds them in the worker): drawn on a canvas
// over the cells with the shared DrawingML code (drawingml/scene.ts), and picked, moved, sized, turned and typed in with its
// shape editor (drawingml/editor.ts), as on a slide. A sheet's drawings are one page: a `wsDr` holding each one's shape,
// placed at its anchor's box (page pixels, 96 a inch: 0.75 points each). A change is sent to the worker as the sheet's
// whole list of drawings, one undoable edit (typing: one for the burst).

import { el, parseXml, serializeXml, type XmlElement } from '@golemdocs/docx';
import { ShapeBuilder, type ShapeView } from '../drawingml/scene.ts';
import { ShapeEditor, type ShapeChange } from '../drawingml/editor.ts';
import { readShape, shapeFill, xfrmOf, type DrawingShape, type Frame } from '../drawingml/shape.ts';
import { readTheme, type Theme } from '../drawingml/theme.ts';
import { DEFAULT_MAP, type ColorContext } from '../drawingml/color.ts';
import { setFrame } from '../drawingml/build.ts';
import { EMU_PER_PX } from '../drawingml/ooxml.ts';
import { SlideFonts } from '../slides/fonts.ts';
import { decodeImage } from '../formats/imageCodec.ts';
export { decodeImage, toPng } from '../formats/imageCodec.ts';
import { paintScene, type ImageCache } from '../vector/paint.ts';
import { IDENTITY, type Scene, type SceneNode } from '../vector/model.ts';
import { darkPageColor, type ForcedColors } from '../webgl/program.ts';
import type { Rgba } from '../vector/style.ts';
import type { Region } from './geometry.ts';
import type { DrawingEdit, DrawingItem, DrawingRel } from './drawings.ts';
import type { DrawnPicture, EditOp } from './protocol.ts';

// What the sheet's view uses only once it has drawings, or is adding one: kept in this chunk (see AGENTS.md "Bundle size").
export { newPicture, newShape, nextShapeId } from '../drawingml/build.ts';
export { describeShape } from '../drawingml/editor.ts';
export { readShape } from '../drawingml/shape.ts';
export { SHAPE_GROUPS, isLinePreset } from '../drawingml/shapeChoices.ts';
export { shapeMenuItems, shapeName } from '../ui/shapePicker.ts';

/** Page pixels per point. */
const PX = 1 / 0.75;
const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A sheet's drawings as one page. */
export interface SheetPage {
  sheet: number;
  /** A `wsDr` holding each drawing's shape, back to front. */
  tree: XmlElement;
  /** Which drawing each shape came from (none for one made here), and the relationships it uses. */
  sources: Map<XmlElement, { source?: number; rels: Record<string, DrawingRel> }>;
  theme: Theme;
  /** Its scene and where each shape is (made when first needed, again after a change). */
  made: { scene: Scene; views: ShapeView[]; owners: XmlElement[] } | null;
}

export interface DrawingLayerDeps {
  /** What the canvas goes in (the sheet's own element, over the cells). */
  host: HTMLElement;
  fontBase: string;
  ask<T>(message: { t: 'drawings'; sheet: number } | { t: 'media'; part: string }): Promise<T>;
  /** Sends an edit; resolves with whether the worker made it (the sheet's info is the new one by then). */
  edit(op: EditOp): Promise<boolean>;
  /** A sheet's drawings' version, as the sheet's info has it now. */
  version(sheet: number): number;
  render(): void;
  readOnly(): boolean;
  /** The text area screen readers follow (the cell editor's). */
  input: HTMLTextAreaElement;
  undo(): void;
  redo(): void;
  /** The selection or the text being edited changed (the toolbar shows its formatting). */
  state(): void;
}

/** Where the cells are this frame: their regions (CSS px of the canvas, under `top`) and CSS px per point. */
interface Frame2 {
  regions: Region[];
  top: number;
  scale: number;
}

export class DrawingLayer {
  readonly canvas = document.createElement('canvas');
  readonly editor: ShapeEditor<SheetPage>;
  private readonly pages = new Map<number, SheetPage>();
  /** The version of each sheet's drawings loaded (or being loaded). */
  private readonly versions = new Map<number, number>();
  private readonly images = new Map<string, CanvasImageSource>();
  private readonly loadingImages = new Map<string, Promise<void>>();
  private fonts: SlideFonts | null = null;
  private sheet = -1;
  private frame: Frame2 = { regions: [], top: 0, scale: 1 };
  /** While a pane's selection is drawn: the pane every point goes through. */
  private through: Region | null = null;
  /** Edits of each sheet's drawings this page sent and the worker has not answered yet: until then the page is what it
   * shows (its elements are the ones being edited), and the version their answer brings is taken as this page's own. */
  private readonly own = new Map<number, number>();
  /** A typing burst not yet sent: sent when it ends. */
  private pending: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: DrawingLayerDeps) {
    this.canvas.className = 'wm-sheet-drawings';
    deps.host.prepend(this.canvas);
    const layer = this;
    this.editor = new ShapeEditor<SheetPage>({
      get readOnly() {
        return deps.readOnly();
      },
      get measure() {
        return layer.fonts!;
      },
      input: deps.input,
      page: () => this.pages.get(this.sheet),
      views: (page) => this.made(page).views,
      toScreen: (_page, x, y) => this.toScreen(x, y),
      scale: () => this.frame.scale * 0.75,
      theme: (page) => page.theme,
      change: (page): ShapeChange & { page: SheetPage } => ({ page, touch: () => undefined }),
      commit: (change, options) => this.commit((change as ShapeChange & { page: SheetPage }).page, !!options?.merge),
      invalidate: () => this.invalidate(),
      redraw: () => deps.render(),
      render: () => deps.render(),
      state: () => deps.state(),
      leftText: () => this.flush(),
      deleteSelection: () => this.deleteSelection(),
      undo: () => deps.undo(),
      redo: () => deps.redo(),
    });
  }

  /** Whether the sheet in view has drawings (or one is being made). */
  get active(): boolean {
    return (this.pages.get(this.sheet)?.sources.size ?? 0) > 0;
  }

  /** The page in hand, if its drawings have come. */
  get page(): SheetPage | undefined {
    return this.pages.get(this.sheet);
  }

  /** The sheet in view and its drawings' version (from the sheet's info): they are asked for again when it changed. */
  sync(sheet: number, drawings: { count: number; version: number } | undefined): void {
    if (sheet !== this.sheet) {
      this.editor.selected = [];
      this.sheet = sheet;
    }
    if ((this.own.get(sheet) ?? 0) > 0) return;
    const version = drawings?.version ?? 0;
    if (this.versions.get(sheet) === version) return;
    this.versions.set(sheet, version);
    if (!drawings) {
      this.pages.delete(sheet);
      this.deps.render();
      return;
    }
    void this.load(sheet, version);
  }

  private async load(sheet: number, version: number): Promise<void> {
    this.fonts ??= await SlideFonts.create(this.deps.fontBase, () => {
      for (const p of this.pages.values()) p.made = null;
      this.deps.render();
    });
    const reply = await this.deps.ask<{ items: DrawingItem[]; theme: string | null }>({ t: 'drawings', sheet });
    if (this.versions.get(sheet) !== version) return;
    const old = this.pages.get(sheet);
    const page: SheetPage = { sheet, tree: el('xdr:wsDr', { 'xmlns:xdr': XDR, 'xmlns:a': A, 'xmlns:r': R }), sources: new Map(), theme: old?.theme ?? readTheme(reply.theme ? parseXml(reply.theme) : undefined), made: null };
    reply.items.forEach((item, source) => {
      const anchor = parseXml(item.xml);
      const shape = anchor.children.find((k): k is XmlElement => typeof k !== 'string' && /:(sp|pic|cxnSp|grpSp|graphicFrame)$/.test(k.name));
      if (!shape) return;
      // The shape drawn where its anchor puts it (Excel's own position for it is the anchor's, not the shape's).
      placeAt(shape, item.box);
      page.tree.children.push(shape);
      page.sources.set(shape, { source, rels: item.rels });
    });
    // The selection is kept across a reload by the shapes' places in the list.
    const kept = old ? this.editor.selected.map((e) => old.tree.children.indexOf(e)).filter((i) => i >= 0) : [];
    this.pages.set(sheet, page);
    if (old) this.editor.selected = kept.map((i) => page.tree.children[i]).filter((e): e is XmlElement => !!e && typeof e !== 'string');
    this.deps.render();
  }

  /** The page's scene and views, made when first needed. */
  private made(page: SheetPage, whole = false): NonNullable<SheetPage['made']> {
    if (page.made && !whole) return page.made;
    // `whole`: every shape's text drawn, the one being typed in too (for a printout), and not kept.
    const text = whole ? null : this.editor.text;
    const fonts = this.fonts!;
    const ctx: ColorContext = { theme: page.theme, map: DEFAULT_MAP };
    const builder = new ShapeBuilder<DrawingShape>({ measure: fonts, family: (f) => fonts.family(f), editing: text?.element, skipText: text ? (e) => e === text.element : undefined }, ctx, { ctx }, (rId, shape) => {
      const rel = rId ? this.relsOf(page, shape.element)?.[rId] : undefined;
      if (!rel || rel.external) return null;
      const href = `xlsx:${rel.target}`;
      this.wantImage(href, rel.target);
      return href;
    });
    const children: SceneNode[] = [];
    // The shape each of the scene's nodes is.
    const owners: XmlElement[] = [];
    for (const e of page.tree.children) {
      if (typeof e === 'string') continue;
      const node = builder.shape(readShape(e), IDENTITY, null);
      if (!node) continue;
      children.push(node);
      owners.push(e);
    }
    let width = 1;
    let height = 1;
    for (const v of builder.views) {
      width = Math.max(width, v.matrix[4] + v.w + 2);
      height = Math.max(height, v.matrix[5] + v.h + 2);
    }
    const scene: Scene = { width, height, viewBox: { x: 0, y: 0, width, height }, style: {}, attrs: {}, defs: builder.defs, children, defined: {}, stylesheet: false };
    const made = { scene, views: builder.views, owners };
    if (!whole) page.made = made;
    return made;
  }

  /** The relationships of the drawing a shape is part of (a group's children use their group's). */
  private relsOf(page: SheetPage, element: XmlElement): Record<string, DrawingRel> | undefined {
    for (const [shape, info] of page.sources) if (shape === element || contains(shape, element)) return info.rels;
    return undefined;
  }

  private wantImage(href: string, part: string): void {
    if (this.images.has(href) || this.loadingImages.has(href)) return;
    const loading = this.deps
      .ask<{ bytes: ArrayBuffer | null }>({ t: 'media', part })
      .then((reply) => (reply.bytes ? decodeImage(new Uint8Array(reply.bytes)) : null))
      .then((bitmap) => {
        if (!bitmap) return;
        this.images.set(href, bitmap);
        this.deps.render();
      })
      .catch(() => undefined);
    this.loadingImages.set(href, loading);
  }

  /** A picture added here: shown at once from its bytes, under the name its relationship has for it until it is saved. */
  addImage(name: string, image: CanvasImageSource): void {
    this.images.set(`xlsx:${name}`, image);
  }

  // ---- Where things are ----------------------------------------------------------------------------------------------

  /** The region a canvas point (CSS px) is in, or the one that scrolls both ways. */
  private regionAt(x: number, y: number): Region | undefined {
    const { regions, top } = this.frame;
    return regions.find((r) => x >= r.x && x < r.x + r.width && y >= top + r.y && y < top + r.y + r.height) ?? regions[regions.length - 1];
  }

  /**
   * A page point (page px) on the canvas (CSS px), through the region that shows it: a frozen pane for a point in its
   * rows and columns, else the one that scrolls both ways.
   */
  toScreen(x: number, y: number): [number, number] {
    const { regions, top, scale } = this.frame;
    const px = x / PX;
    const py = y / PX;
    const shows = (r: Region) => px >= r.originX && px < r.originX + r.width / scale && py >= r.originY && py < r.originY + r.height / scale;
    const r = this.through ?? regions.find(shows) ?? regions[regions.length - 1];
    if (!r) return [0, 0];
    return [r.x + (x / PX - r.originX) * scale, top + r.y + (y / PX - r.originY) * scale];
  }

  /** A canvas point (CSS px) as a page point (page px), through the region it is in. */
  toPage(x: number, y: number): [number, number] {
    const r = this.regionAt(x, y);
    const { top, scale } = this.frame;
    if (!r) return [0, 0];
    return [((x - r.x) / scale + r.originX) * PX, ((y - top - r.y) / scale + r.originY) * PX];
  }

  // ---- Drawing ---------------------------------------------------------------------------------------------------------

  /** Draws the drawings (and the editor's selection, handles and caret) over the cells, for this frame. */
  paint(regions: Region[], top: number, scale: number, width: number, height: number, darkPages = false, forced: ForcedColors | null = null): void {
    this.frame = { regions, top, scale };
    const dpr = window.devicePixelRatio || 1;
    const c = this.canvas;
    const w = Math.round(width * dpr);
    const h = Math.round(height * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      c.style.width = `${width}px`;
      c.style.height = `${height}px`;
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const page = this.page;
    if (!page || !this.fonts || !page.tree.children.length) return;
    const { scene, owners } = this.made(page);
    // Under Dark Pages a line, or a shape with no fill (a text box), shows its colours as the cells do: it is drawn on
    // them. A filled shape keeps its own, as a picture and a chart do.
    const recolor = recolorFor(darkPages, forced);
    const ctx0: ColorContext = { theme: page.theme, map: DEFAULT_MAP };
    const nodes = scene.children.map((node, i) => {
      const shape = readShape(owners[i]);
      const onCells = !!recolor && (shape.kind === 'connector' || (shape.kind === 'shape' && shapeFill(shape, ctx0).kind === 'none'));
      return { node, recolor: onCells ? recolor : undefined };
    });
    for (const r of regions) {
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.beginPath();
      ctx.rect(r.x, top + r.y, r.width, r.height);
      ctx.clip();
      // Page pixels to canvas CSS px in this region.
      const s = scale / PX;
      ctx.translate(r.x - r.originX * scale, top + r.y - r.originY * scale);
      ctx.scale(s, s);
      for (const { node, recolor } of nodes) paintScene(ctx, { ...scene, children: [node] }, scene.width, scene.height, { images: this.images as ImageCache, recolor });
      ctx.restore();
    }
    // The editor's selection, handles and caret (it works in device pixels itself), drawn in each pane as the shapes are:
    // a shape across a frozen pane's edge shows its frame on both sides of it, each part where that pane has it.
    for (const r of regions) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x * dpr, (top + r.y) * dpr, r.width * dpr, r.height * dpr);
      ctx.clip();
      this.through = r;
      this.editor.decorate(ctx, page, dpr);
      this.through = null;
      ctx.restore();
    }
  }

  // ---- Changes -------------------------------------------------------------------------------------------------------

  /** The XML changed during a gesture: drawn again from it. */
  invalidate(): void {
    const page = this.page;
    if (page) page.made = null;
    this.deps.render();
  }

  /** A change made: the page drawn again, and sent to the worker (typing when it pauses). */
  private commit(page: SheetPage, typing: boolean): void {
    page.made = null;
    this.deps.render();
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    if (typing) {
      this.pending = setTimeout(() => this.send(page), 600);
      return;
    }
    this.send(page);
  }

  /** Sends a typing burst still waiting. */
  flush(): void {
    if (!this.pending) return;
    clearTimeout(this.pending);
    this.pending = null;
    const page = this.page;
    if (page) this.send(page);
  }

  /** The page's drawings to the worker, as the sheet's whole list (`media`: pictures added with them). */
  send(page: SheetPage, media?: { name: string; bytes: ArrayBuffer }[]): void {
    const edits: DrawingEdit[] = [];
    for (const shape of page.tree.children) {
      if (typeof shape === 'string') continue;
      const info = page.sources.get(shape) ?? { rels: {} };
      const frame = readShape(shape).frame;
      const box = { x: frame.x / EMU_PER_PX / PX, y: frame.y / EMU_PER_PX / PX, width: Math.max(1, frame.w / EMU_PER_PX / PX), height: Math.max(1, frame.h / EMU_PER_PX / PX) };
      const copy = parseXml(serializeXml(shape));
      Object.assign(copy.attrs, { 'xmlns:xdr': XDR, 'xmlns:a': A, 'xmlns:r': R });
      edits.push({ shape: serializeXml(copy), box, rels: info.rels, ...(info.source !== undefined && { source: info.source }) });
    }
    // The worker's list is this one from now on: each shape is the drawing at its place in it.
    let i = 0;
    for (const shape of page.tree.children) if (typeof shape !== 'string') page.sources.set(shape, { source: i++, rels: page.sources.get(shape)?.rels ?? {} });
    const sheet = page.sheet;
    this.own.set(sheet, (this.own.get(sheet) ?? 0) + 1);
    void this.deps.edit({ kind: 'drawings', edits, ...(media && { media }) }).then((made) => {
      this.own.set(sheet, Math.max(0, (this.own.get(sheet) ?? 1) - 1));
      // Made: the version it brought is what this page shows. Not made (a protected sheet): loaded as the worker has it.
      if (made) this.versions.set(sheet, this.deps.version(sheet));
      else this.versions.delete(sheet);
      this.deps.render();
    });
  }

  /** Adds a shape (made by `build.ts`) to the page in hand, picked, and sends it (with a new picture's bytes). */
  add(shape: XmlElement, rels: Record<string, DrawingRel>, media?: { name: string; bytes: ArrayBuffer }[]): void {
    const page = this.pages.get(this.sheet) ?? this.emptyPage();
    page.tree.children.push(shape);
    page.sources.set(shape, { rels });
    page.made = null;
    this.editor.selected = [shape];
    this.send(page, media);
    this.deps.render();
  }

  /** A sheet with no drawings yet gets an empty page, in the workbook's theme once it has come. */
  private emptyPage(): SheetPage {
    const page: SheetPage = { sheet: this.sheet, tree: el('xdr:wsDr', { 'xmlns:xdr': XDR, 'xmlns:a': A, 'xmlns:r': R }), sources: new Map(), theme: readTheme(undefined), made: null };
    this.pages.set(this.sheet, page);
    void this.deps.ask<{ theme: string | null }>({ t: 'drawings', sheet: this.sheet }).then((reply) => {
      if (reply.theme) {
        page.theme = readTheme(parseXml(reply.theme));
        page.made = null;
        this.deps.render();
      }
    });
    return page;
  }

  /** Delete, Backspace or Cut with shapes selected: they go. */
  deleteSelection(): void {
    const page = this.page;
    if (!page || !this.editor.selected.length) return;
    page.tree.children = page.tree.children.filter((e) => typeof e === 'string' || !this.editor.selected.includes(e));
    for (const e of this.editor.selected) page.sources.delete(e);
    this.editor.selected = [];
    page.made = null;
    this.send(page);
    this.deps.render();
  }

  /**
   * What a press at a canvas point (CSS px) is on: the picked shape's handles (sizing or turning starts), a shape, or
   * nothing of the drawings'.
   */
  hit(x: number, y: number): 'handle' | 'shape' | null {
    const page = this.page;
    if (!page || !this.fonts) return null;
    if (this.editor.selected.length && this.editor.pressHandle(x, y)) return 'handle';
    return this.editor.shapeAt(page, this.toPage(x, y)) ? 'shape' : null;
  }

  /** Bring to Front or Send to Back: the picked shapes moved to the end or the start of the page, in their order. */
  reorder(front: boolean): void {
    const page = this.page;
    if (!page || !this.editor.selected.length) return;
    const picked = page.tree.children.filter((e) => typeof e !== 'string' && this.editor.selected.includes(e));
    const rest = page.tree.children.filter((e) => typeof e === 'string' || !this.editor.selected.includes(e));
    page.tree.children = front ? [...rest, ...picked] : [...picked, ...rest];
    page.made = null;
    this.send(page);
    this.deps.render();
  }

  /** Whether a canvas point (CSS px) is over a shape (for the pointer's shape). */
  onDrawing(x: number, y: number): boolean {
    const page = this.page;
    return !!page && !!this.fonts && !!this.editor.shapeAt(page, this.toPage(x, y));
  }

  /** Where each drawing of the page in hand is (points: x, y, width, height), for the tests. */
  boxes(): number[][] {
    const page = this.page;
    if (!page) return [];
    return page.tree.children.flatMap((e) => {
      if (typeof e === 'string') return [];
      const f = readShape(e).frame;
      return [[f.x, f.y, f.w, f.h].map((v) => Math.round((v / EMU_PER_PX / PX) * 100) / 100)];
    });
  }

  /**
   * A sheet's pictures and shapes each drawn on its own, with its pictures loaded, for a printout, a PDF or a thumbnail:
   * `perPoint` pixels a point (at most `limit` a side), and where each goes, in points. Drawn as they are in the file,
   * whatever the theme.
   */
  async drawn(sheet: number, perPoint = 3, limit = 3000): Promise<DrawnPicture[]> {
    await this.ready();
    const version = this.deps.version(sheet);
    if (!this.pages.has(sheet) || ((this.own.get(sheet) ?? 0) === 0 && this.versions.get(sheet) !== version)) {
      this.versions.set(sheet, version);
      await this.load(sheet, version);
    }
    const page = this.pages.get(sheet);
    if (!page) return [];
    const { scene, owners } = this.made(page, true);
    await Promise.all(this.loadingImages.values());
    const out: DrawnPicture[] = [];
    for (const [i, node] of scene.children.entries()) {
      const e = owners[i];
      // Its box turned as it is, and a little over for its line and arrowheads.
      const f = readShape(e).frame;
      const [w, h] = [f.w / EMU_PER_PX, f.h / EMU_PER_PX];
      const turn = (f.rot * Math.PI) / 180;
      const bw = Math.abs(w * Math.cos(turn)) + Math.abs(h * Math.sin(turn));
      const bh = Math.abs(w * Math.sin(turn)) + Math.abs(h * Math.cos(turn));
      const pad = 12;
      const x0 = f.x / EMU_PER_PX + w / 2 - bw / 2 - pad;
      const y0 = f.y / EMU_PER_PX + h / 2 - bh / 2 - pad;
      const [pw, ph] = [bw + 2 * pad, bh + 2 * pad];
      const res = Math.min(perPoint / PX, limit / pw, limit / ph);
      const cw = Math.max(1, Math.ceil(pw * res));
      const ch = Math.max(1, Math.ceil(ph * res));
      const canvas = new OffscreenCanvas(cw, ch);
      const ctx = canvas.getContext('2d')!;
      ctx.scale(res, res);
      ctx.translate(-x0, -y0);
      paintScene(ctx, { ...scene, children: [node] }, scene.width, scene.height, { images: this.images as ImageCache });
      const data = new Uint8Array(ctx.getImageData(0, 0, cw, ch).data.buffer);
      out.push({ x: x0 / PX, y: y0 / PX, width: pw / PX, height: ph / PX, pixels: { width: cw, height: ch, channels: 4, data } });
    }
    return out;
  }

  /** The fonts and measures shapes are laid out with (made with the first page). */
  async ready(): Promise<void> {
    this.fonts ??= await SlideFonts.create(this.deps.fontBase, () => this.invalidate());
  }

  /** The sheet in view and where its cells are now (as `sync` and `paint` are told each frame), for placing a shape before the next frame. */
  place(sheet: number, regions: Region[], top: number, scale: number): void {
    if (sheet !== this.sheet) {
      this.editor.selected = [];
      this.sheet = sheet;
    }
    this.frame = { regions, top, scale };
  }

  /** The page in hand's frame for a new shape: centred on a canvas point, `w`×`h` page px. */
  frameAt(x: number, y: number, w: number, h: number): Frame {
    const [px, py] = this.toPage(x, y);
    return { x: Math.round((px - w / 2) * EMU_PER_PX), y: Math.round((py - h / 2) * EMU_PER_PX), w: Math.round(w * EMU_PER_PX), h: Math.round(h * EMU_PER_PX), rot: 0, flipH: false, flipV: false };
  }

  /** The id the next shape added to the page in hand gets. */
  get tree(): XmlElement {
    return (this.pages.get(this.sheet) ?? this.emptyPage()).tree;
  }
}

/** Puts a shape at a box (points): its frame's offset and size, keeping its turn and flips (a group's children move with it). */
function placeAt(shape: XmlElement, box: { x: number; y: number; width: number; height: number }): void {
  const frame = readShape(shape, [], false).frame;
  const next: Frame = { ...frame, x: Math.round(box.x * PX * EMU_PER_PX), y: Math.round(box.y * PX * EMU_PER_PX), w: Math.round(box.width * PX * EMU_PER_PX), h: Math.round(box.height * PX * EMU_PER_PX) };
  if (!xfrmOf(shape) || frame.x !== next.x || frame.y !== next.y || frame.w !== next.w || frame.h !== next.h) setFrame(shape, next);
}

function contains(parent: XmlElement, element: XmlElement): boolean {
  for (const k of parent.children) if (typeof k !== 'string' && (k === element || contains(k, element))) return true;
  return false;
}

/**
 * How the drawings' colours show, as the cells' do (`pageColor` in DARK_PAGES_GLSL): under a contrast theme, light ones
 * become the page's colour and the rest the text's; under Dark Pages, flipped to the dark page's. Null: as they are.
 */
export function recolorFor(darkPages: boolean, forced: ForcedColors | null): ((c: Rgba) => Rgba) | undefined {
  const split = (v: number, a: number): Rgba => [(v >> 16) & 255, (v >> 8) & 255, v & 255, a];
  if (forced) return ([r, g, b, a]) => split((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6 ? forced.page : forced.text, a);
  if (darkPages) return ([r, g, b, a]) => split(darkPageColor((r << 16) | (g << 8) | b), a);
  return undefined;
}
