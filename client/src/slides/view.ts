// The slides editor (docs/slides.md): a deck's slides laid out down the page on the app's camera (or in a grid, Slide Sorter),
// painted on a canvas over the view by the drawing painter, with the shapes of the slide in hand selected, moved, sized,
// turned and edited in place. A lazily loaded chunk: slides/handle.ts is all the rest of the app holds until a deck opens.

import { t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';
import { cloneElement, type XmlElement } from '@golemdocs/docx';
import { decodeImage, toPng } from '../formats/imageCodec.ts';
import { sniffImage } from '../formats/images.ts';
import { paintScene, type ImageCache } from '../vector/paint.ts';
import { apply } from '../vector/matrix.ts';
import type { Scene } from '../vector/model.ts';
import { CSS_PX_PER_POINT, type Camera } from '../view/camera.ts';
import { h } from '../ui/dom.ts';
import { attachTextInput, focusTextInput } from '../ui/textInput.ts';
import { showPopupMenu, type PopupItem } from '../ui/popupMenu.ts';
import { announce } from '../ui/announce.ts';
import { IS_MAC } from '../ui/shortcuts.ts';
import type { Region } from '../ui/focusRegions.ts';
import { SLIDE_ONLY_OPS, type Action, type FormatState, type SlidesOp } from '../ui/actions.ts';
import { readClipboard } from '../ui/clipboard.ts';
import { hexOf } from '../drawingml/color.ts';
import { ShapeEditor, type ShapeChange } from '../drawingml/editor.ts';
import { isLinePreset, SHAPE_GROUPS } from '../drawingml/shapeChoices.ts';
import { shapeMenuItems, shapeName } from '../ui/shapePicker.ts';
import { Deck, isSlidePart, masterOfPage, paragraphText, type LayoutPart, type PagePart, type SlidePart } from './deck.ts';
import { History, Transaction } from './history.ts';
import { EMU_PER_PX, at, kid, kids } from './ooxml.ts';
import { SlideFonts } from './fonts.ts';
import { colorContext, slideScene, type ShapeView, type SlideScene } from './scene.ts';
import { backgroundFill, cNvPr, placeholderOf, xfrmOf, type Frame } from './shapes.ts';
import { addSlide, changeLayout, deleteShapes, deleteSlides, duplicateShapes, duplicateSlide, isHidden, moveSlides, newPicture, newShape, newTable, reorder, resetToLayout, setHidden, setNotes, treeOf, type Order } from './edit.ts';
import { Presenter } from './present.ts';
import { backgroundOf, currentDesign, inheritedStyleOf, readOtherTheme, setBackground, setBackgroundEverywhere, setDarkPages, setThemeColors, setThemeFonts } from './design.ts';
import { showBackgroundDialog, showThemeDialog } from './designDialogs.ts';
import { deckPdf, sceneWithData } from './export.ts';
import { deckLines } from './outline.ts';
import './view.css';

export interface SlidesEditorDeps {
  camera: Camera;
  fontBase: string;
  /** Asks for a frame (something to paint changed). */
  render(): void;
  notify(message: string): void;
  openFailed(message: string): void;
  /** The app's commands for a key it would run (Ctrl+S, Ctrl+F...); true if it ran one. */
  appKey(e: KeyboardEvent): boolean;
  /** The app's own view keys (zoom); true if it took the key. */
  viewKey(e: KeyboardEvent): boolean;
  /** Lets the user pick a picture file. */
  pickImage(): Promise<File | null>;
  /** Lets the user pick a presentation or theme file (Slide › Theme › From Presentation). */
  pickDeck(): Promise<File | null>;
}

/** Gap between slides down the page, and in the sorter, in points. */
const GAP = 28;
/** A change to a slide, kept in the deck's history. */
interface SlideChange extends ShapeChange {
  tx: Transaction;
  page: PagePart;
}

interface Placed {
  slide: PagePart;
  /** In points. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The smallest view, in CSS pixels, a deck is fitted to as it opens. */
const MIN_FIT = 100;

export class SlidesEditorView {
  readonly el = h('div', { class: 'wm-slides', attrs: { hidden: '' } });
  private readonly canvas = h('canvas', { class: 'wm-slides-canvas' });
  private readonly input = h('textarea', { class: 'wm-slides-input', attrs: { 'aria-label': t('slides.editor'), autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', rows: '1', 'data-slides-input': '' } });
  private readonly notesBar = h('div', { class: 'wm-slides-notes', attrs: { hidden: '', role: 'region', 'aria-label': t('slides.notes') } });
  /** Shown in master view: what is being edited, and the way back to the slides. */
  private readonly masterBar = h('div', { class: 'wm-slides-masterbar', attrs: { hidden: '', role: 'region', 'aria-label': t('slides.masterView') } });
  private readonly notesInput = h('textarea', { class: 'wm-input wm-slides-notes-input', attrs: { 'aria-label': t('slides.notes'), placeholder: t('slides.notesPlaceholder') } });
  deck: Deck | null = null;
  fileName = '';
  readOnly = false;
  private placed: Placed[] = [];
  private sorter = false;
  private readonly scenes = new Map<PagePart, { scene: SlideScene; version: string }>();
  private readonly thumbs = new Map<PagePart, { canvas: HTMLCanvasElement; version: string }>();
  private images: Map<string, CanvasImageSource> = new Map();
  private loadingImages = new Set<string>();
  private readonly history = new History();
  /** The slide in hand (its index), and its shapes selected. */
  private current = 0;
  /** The shapes of the page in hand: selected, moved, sized, turned, their text edited (drawingml/editor.ts). */
  private readonly shapes: ShapeEditor<PagePart>;
  private contentVersion = 0;
  private painted = '';
  private fonts: SlideFonts | null = null;
  private presenter: Presenter | null = null;
  private notesShown = false;
  /** Copied shapes, for pasting within the app (the system clipboard has their text). */
  private copied: { elements: XmlElement[]; from: PagePart; key: string } | null = null;
  /** Master view: the pages are the masters and their layouts rather than the slides. */
  private masterView = false;
  /** The slide in hand when master view was opened, to go back to. */
  private slideBeforeMaster = 0;
  onEdit: (() => void) | null = null;
  onState: (() => void) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly deps: SlidesEditorDeps,
  ) {
    this.notesBar.append(this.notesInput);
    const closeMaster = h('button', { class: 'wm-button', text: t('slides.closeMaster'), attrs: { type: 'button' } });
    closeMaster.addEventListener('click', () => {
      if (this.masterView) this.toggleMasterView();
      this.focus();
    });
    this.masterBar.append(h('span', { class: 'wm-slides-masterbar-label', text: t('slides.masterView') }), closeMaster);
    this.el.append(this.canvas, this.input, this.masterBar, this.notesBar);
    parent.append(this.el);
    this.shapes = this.shapeEditor();
    this.listen();
  }

  /** The editor of the slide's shapes, driven through the slide in hand: where it is on screen, and the deck's history. */
  private shapeEditor(): ShapeEditor<PagePart> {
    const view = this;
    const screenScale = (): number => this.deps.camera.zoom * CSS_PX_PER_POINT;
    return new ShapeEditor<PagePart>({
      get readOnly() {
        return view.readOnly;
      },
      get measure() {
        return view.fonts!;
      },
      input: this.input,
      page: () => this.pages[this.current],
      views: (page) => this.viewsOf(page),
      toScreen: (page, x, y) => {
        const p = this.placed.find((q) => q.slide === page) ?? this.placed[this.current];
        const cam = this.deps.camera;
        const scale = screenScale();
        return [(p.x - cam.x) * scale + x * 0.75 * scale, (p.y - cam.y) * scale + y * 0.75 * scale];
      },
      scale: () => screenScale() * 0.75,
      // A moved shape's edges and middle snap to the slide's.
      snapLines: () => {
        const { w, h: hh } = this.slideSize;
        return { xs: [0, w / 1.5, w / 0.75], ys: [0, hh / 1.5, hh / 0.75] };
      },
      theme: (page) => (this.deck ? colorContext(this.deck, page).theme : undefined),
      change: (page, label): SlideChange => {
        const tx = new Transaction(this.deck!, label);
        return { tx, page, touch: () => tx.touch(page) };
      },
      commit: (change, options) => {
        const { tx, page } = change as SlideChange;
        this.commit(tx, options?.structure ?? false, options?.merge ? `${options.merge}:${page.name}` : undefined, options?.before);
      },
      invalidate: () => void this.contentVersion++,
      redraw: () => this.redraw(),
      render: () => this.deps.render(),
      state: () => this.onState?.(),
      leftText: () => {
        this.history.seal();
        this.contentVersion++;
        this.onState?.();
      },
      deleteSelection: () => void this.slidesOp('deleteShape'),
      undo: () => this.undo(),
      redo: () => this.redo(),
      // In master view, a change to the text of a master's or layout's placeholder is made to the text style it passes on too.
      mirrorStyle: (page, element) => (this.masterView ? inheritedStyleOf(page, element, true) : undefined),
    });
  }

  get isOpen(): boolean {
    return this.deck !== null;
  }

  /** What is shown and edited: the slides, or in master view each master followed by its layouts. */
  private get pages(): PagePart[] {
    const deck = this.deck;
    if (!deck) return [];
    if (!this.masterView) return deck.slides;
    return deck.masters.flatMap((master): PagePart[] => [master, ...deck.layoutsOf(master)]);
  }

  /** The slide in hand, or nothing in master view (for what only a slide has: notes, hiding, its layout). */
  private get currentSlide(): SlidePart | undefined {
    const page = this.pages[this.current];
    return page && isSlidePart(page) ? page : undefined;
  }

  // ---- Opening and saving ---------------------------------------------------------------------------------------------

  async open(name: string, bytes: Uint8Array): Promise<void> {
    this.fonts ??= await SlideFonts.create(this.deps.fontBase, () => this.fontsArrived());
    let deck: Deck;
    try {
      deck = await Deck.read(bytes);
    } catch (e) {
      this.deps.openFailed((e as Error).message);
      return;
    }
    this.deck = deck;
    this.fileName = name;
    this.scenes.clear();
    this.thumbs.clear();
    this.images = new Map();
    this.loadingImages.clear();
    this.history.clear();
    this.current = 0;
    this.shapes.stop();
    this.sorter = false;
    this.masterView = false;
    this.masterBar.hidden = true;
    this.layout();
    this.el.hidden = false;
    this.showNotes();
    this.painted = '';
    this.onState?.();
    this.deps.render();
    announce(t('slides.opened', { name, count: this.pages.length }));
  }

  close(): void {
    this.presenter?.close();
    this.notesFor = null;
    this.presenter = null;
    this.deck = null;
    this.el.hidden = true;
    this.scenes.clear();
    this.thumbs.clear();
    this.images = new Map();
    this.shapes.stop();
  }

  /** The deck as a `.pptx`. */
  async save(): Promise<Uint8Array> {
    if (!this.deck) throw new Error('no deck is open');
    const deck = this.deck;
    this.commitNotes();
    await this.notesSaving;
    return deck.write();
  }

  private fontsArrived(): void {
    this.contentVersion++;
    this.painted = '';
    this.onState?.();
    this.deps.render();
  }

  // ---- Where slides are ---------------------------------------------------------------------------------------------

  private get slideSize(): { w: number; h: number } {
    const deck = this.deck;
    return deck ? { w: deck.width / 12700, h: deck.height / 12700 } : { w: 960, h: 540 };
  }

  /** Puts every slide in its place: one column, or rows of the sorter's grid. */
  private layout(): void {
    const deck = this.deck;
    if (!deck) return;
    const { w, h } = this.slideSize;
    const columns = this.sorter ? Math.max(1, Math.min(6, Math.ceil(Math.sqrt(this.pages.length * 1.6)))) : 1;
    // The sorter's rows leave room under each slide for its number (a fifth of a slide's height).
    const rowGap = this.sorter ? Math.max(GAP, h / 5) : GAP;
    this.placed = this.pages.map((slide, i) => ({ slide, x: (i % columns) * (w + GAP), y: Math.floor(i / columns) * (h + rowGap), w, h }));
    this.painted = '';
  }

  bounds(): { x: number; y: number; width: number; height: number } {
    if (!this.placed.length) return { x: 0, y: 0, width: this.slideSize.w, height: this.slideSize.h };
    const right = Math.max(...this.placed.map((p) => p.x + p.w));
    const bottom = Math.max(...this.placed.map((p) => p.y + p.h));
    return { x: 0, y: 0, width: right, height: bottom };
  }

  private strip: { width: number; height: number; slide: PagePart }[] = [];

  /** The slides as pages, for the slide strip (the pages panel): the same list, and the same page for a slide, until the slides change. */
  stripPages(): readonly { width: number; height: number; slide: PagePart }[] {
    const slides = this.pages;
    if (this.strip.length !== slides.length || this.strip.some((p, i) => p.slide !== slides[i])) {
      const known = new Map(this.strip.map((p) => [p.slide, p]));
      const { w, h: hh } = this.slideSize;
      this.strip = slides.map((slide) => known.get(slide) ?? { width: w, height: hh, slide });
    }
    return this.strip;
  }

  get slideCount(): number {
    return this.pages.length;
  }

  get currentIndex(): number {
    return this.current;
  }

  /** Brings slide `index` into view and makes it the one in hand. */
  go(index: number, announceIt = true): void {
    const place = this.placed[index];
    if (!place) return;
    this.shapes.reset();
    this.current = index;
    const cam = this.deps.camera;
    const viewW = this.canvas.clientWidth || 800;
    const viewH = this.canvas.clientHeight || 600;
    if (this.sorter) {
      const pointsPerCss = 1 / (cam.zoom * CSS_PX_PER_POINT);
      cam.y = place.y + place.h / 2 - (viewH / 2) * pointsPerCss;
    } else cam.fit({ x: place.x, y: place.y, width: place.w, height: place.h }, viewW, viewH, 32);
    this.painted = '';
    this.showNotes();
    this.onState?.();
    this.deps.render();
    if (announceIt) announce(this.slideMessage(index));
  }

  /** The opening fit still waits for a window with room (a tab opened behind, a pane not shown yet). */
  private fitWaits = false;

  /** Fits the first slide to the window (when a deck opens). */
  fitFirst(viewW: number, viewH: number): void {
    const place = this.placed[0];
    if (!place) return;
    this.fitWaits = viewW < MIN_FIT || viewH < MIN_FIT;
    if (this.fitWaits) return;
    this.deps.camera.fit({ x: place.x, y: place.y, width: place.w, height: place.h }, viewW, viewH, 32);
  }

  private slideMessage(index: number): string {
    const slide = this.pages[index];
    if (this.masterView && slide) return t('slides.masterPage', { name: this.pageName(slide), n: index + 1, count: this.slideCount });
    const title = slide ? this.titleOf(slide) : '';
    return title ? t('slides.slideTitled', { n: index + 1, count: this.slideCount, title }) : t('slides.slideNumber', { n: index + 1, count: this.slideCount });
  }

  /** A master's or layout's name (`p:cSld name`), as master view labels it. */
  pageName(page: PagePart): string {
    if (isSlidePart(page)) return this.titleOf(page);
    const name = at(page.xml, 'p:cSld')?.attrs.name;
    return 'master' in page ? name || page.name.replace(/^.*\//, '').replace(/\.xml$/, '') : t('slides.masterName');
  }

  /** A slide's title: its title placeholder's text. */
  titleOf(slide: PagePart): string {
    for (const sp of kids(at(slide.xml, 'p:cSld/p:spTree'), 'p:sp')) {
      const ph = placeholderOf(sp);
      if (ph && (ph.type === 'title' || ph.type === 'ctrTitle')) return kids(kid(sp, 'p:txBody'), 'a:p').map(paragraphText).join(' ').replace(/\u000b/g, ' ').trim();
    }
    return '';
  }

  // ---- Scenes and painting ------------------------------------------------------------------------------------------

  private sceneOf(slide: PagePart, forEditor = true): SlideScene {
    const deck = this.deck!;
    const index = this.pages.indexOf(slide);
    const editing = forEditor && this.shapes.text?.page === slide ? this.shapes.text.element : null;
    const version = `${this.contentVersion}|${forEditor ? 1 : 0}|${editing ? 'e' : ''}`;
    const known = forEditor ? this.scenes.get(slide) : undefined;
    if (known && known.version === version) return known.scene;
    const fonts = this.fonts!;
    const made = slideScene(deck, slide, { measure: fonts, family: (f) => fonts.family(f), prompts: forEditor, number: index + 1, editing: editing ?? undefined });
    if (forEditor) this.scenes.set(slide, { scene: made, version });
    this.wantImages(made.scene);
    return made;
  }

  /** Starts decoding the pictures a scene shows that are not decoded yet. */
  private wantImages(scene: Scene): void {
    const deck = this.deck!;
    const visit = (nodes: Scene['children']): void => {
      for (const node of nodes) {
        if (node.kind === 'group') visit(node.children);
        else if (node.kind === 'image' && node.href.startsWith('pptx:')) {
          const href = node.href;
          if (this.images.has(href) || this.loadingImages.has(href)) continue;
          this.loadingImages.add(href);
          void deck
            .bytes(href.slice(5))
            .then((bytes) => decodeImage(bytes))
            .then((bitmap) => {
              if (this.deck !== deck) return;
              (this.images as Map<string, CanvasImageSource>).set(href, bitmap);
              this.painted = '';
              this.thumbs.clear();
              this.onState?.();
              this.deps.render();
            })
            .catch(() => undefined);
        }
      }
    };
    visit(scene.children);
  }

  /** Something in the deck changed: everything is drawn again. */
  private changed(structure = false): void {
    this.contentVersion++;
    if (structure) this.layout();
    this.thumbs.clear();
    this.painted = '';
    this.onEdit?.();
    this.onState?.();
    this.deps.render();
  }

  /** Paints the slides in view (and the selection, the caret). Cheap when nothing moved. */
  draw(darkPages: boolean): void {
    const deck = this.deck;
    if (!deck) return;
    if (this.fitWaits) this.fitFirst(this.canvas.clientWidth, this.canvas.clientHeight);
    const cam = this.deps.camera;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    const key = [cam.x, cam.y, cam.zoom, width, height, this.contentVersion, this.current, this.shapes.paintKey(), darkPages, this.sorter].join();
    if (key === this.painted) return;
    this.painted = key;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const perPoint = cam.zoom * CSS_PX_PER_POINT;
    const viewW = width / ratio / perPoint;
    const viewH = height / ratio / perPoint;
    for (let i = 0; i < this.placed.length; i++) {
      const p = this.placed[i];
      if (p.x > cam.x + viewW || p.x + p.w < cam.x || p.y > cam.y + viewH || p.y + p.h < cam.y) continue;
      const left = (p.x - cam.x) * perPoint * ratio;
      const top = (p.y - cam.y) * perPoint * ratio;
      const w = p.w * perPoint * ratio;
      const hh = p.h * perPoint * ratio;
      // A soft shadow under the slide, as pages have.
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
      ctx.shadowBlur = 8 * ratio;
      ctx.shadowOffsetY = 2 * ratio;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(left, top, w, hh);
      ctx.restore();
      // Small on screen: the slide's thumbnail, drawn once; else the slide itself.
      if (w < 360 * ratio) {
        const thumb = this.thumbnail(p.slide, Math.ceil(w));
        if (thumb) ctx.drawImage(thumb, left, top, w, hh);
      } else {
        ctx.save();
        ctx.translate(left, top);
        const scene = this.sceneOf(p.slide).scene;
        paintScene(ctx, scene, w, hh, { images: this.images as ImageCache });
        ctx.restore();
      }
      if (isHidden(p.slide)) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.fillRect(left, top, w, hh);
      }
      if (this.sorter || this.placed.length > 1) {
        // The slide in hand is outlined; each slide has its number beside it.
        if (i === this.current) {
          ctx.strokeStyle = cssVar('--wm-accent', '#2b6cd4');
          ctx.lineWidth = 3 * ratio;
          ctx.strokeRect(left - 2 * ratio, top - 2 * ratio, w + 4 * ratio, hh + 4 * ratio);
        }
        ctx.fillStyle = darkPages ? '#cccccc' : cssVar('--wm-muted', '#666666');
        ctx.font = `${12 * ratio}px system-ui, sans-serif`;
        const label = this.masterView ? ('master' in p.slide ? '    ' : '') + this.pageName(p.slide) : String(i + 1) + (isHidden(p.slide) ? ` (${t('slides.hidden')})` : '');
        ctx.textBaseline = 'top';
        // Down the page the number stands left of its slide; in the sorter, under it; in master view the page's name, above it.
        if (this.sorter) ctx.fillText(label, left, top + hh + 6 * ratio);
        else if (this.masterView) {
          ctx.textBaseline = 'bottom';
          ctx.fillText(label, left, top - 6 * ratio);
        } else {
          ctx.textAlign = 'right';
          ctx.fillText(label, left - 6 * ratio, top);
          ctx.textAlign = 'left';
        }
      }
      if (i === this.current && !this.sorter) this.shapes.decorate(ctx, p.slide, ratio);
    }
  }

  private thumbnail(slide: PagePart, width: number): HTMLCanvasElement | null {
    const bucket = width <= 200 ? 200 : width <= 400 ? 400 : 800;
    const version = `${this.contentVersion}|${bucket}`;
    const known = this.thumbs.get(slide);
    if (known && known.version === version) return known.canvas;
    const { w, h: hh } = this.slideSize;
    const canvas = known?.canvas ?? document.createElement('canvas');
    canvas.width = bucket;
    canvas.height = Math.max(1, Math.round((bucket * hh) / w));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    paintScene(ctx, this.sceneOf(slide, false).scene, canvas.width, canvas.height, { images: this.images as ImageCache });
    this.thumbs.set(slide, { canvas, version });
    return canvas;
  }

  /** A slide's picture in pixels, for the slide strip. */
  thumbnailPixels(index: number, width: number, height: number): Uint8ClampedArray<ArrayBuffer> | null {
    const slide = this.pages[index];
    if (!slide) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    paintScene(ctx, this.sceneOf(slide, false).scene, width, height, { images: this.images as ImageCache });
    if (isHidden(slide)) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.fillRect(0, 0, width, height);
    }
    return ctx.getImageData(0, 0, width, height).data;
  }

  /** The first slide as a picture (the deck's thumbnail). */
  async thumbnailBlob(): Promise<Blob | null> {
    const slide = this.deck?.slides[0];
    if (!slide) return null;
    await this.imagesSettled(slide);
    const canvas = this.thumbnail(slide, 400);
    if (!canvas) return null;
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  }

  private async imagesSettled(slide: PagePart): Promise<void> {
    this.sceneOf(slide, false);
    for (let i = 0; i < 20 && this.loadingImages.size > this.images.size; i++) await new Promise((r) => setTimeout(r, 50));
  }

  /** The deck as a PDF, a page per slide (hidden slides left out), vector, with its text. */
  async printPdf(): Promise<Uint8Array> {
    const deck = this.deck!;
    const fonts = this.fonts!;
    const scenes: Scene[] = [];
    for (const [i, slide] of deck.slides.entries()) {
      if (isHidden(slide)) continue;
      const made = slideScene(deck, slide, { measure: fonts, family: (f) => fonts.family(f), number: i + 1 });
      scenes.push(await sceneWithData(made.scene, deck));
    }
    return deckPdf(scenes, this.fileName.replace(/\.[^.]*$/, ''));
  }

  // ---- The selection, drawn ---------------------------------------------------------------------------------------

  private viewsOf(slide: PagePart): ShapeView[] {
    return this.sceneOf(slide).views;
  }

  // ---- Pointer ------------------------------------------------------------------------------------------------------
  /** The slide under a point of the canvas (CSS px), and the point in that slide's pixels. */
  private slideAt(x: number, y: number): { index: number; at: [number, number] } | null {
    const doc = this.deps.camera.toDocument(x, y);
    for (let i = 0; i < this.placed.length; i++) {
      const p = this.placed[i];
      if (doc.x >= p.x - 6 && doc.x <= p.x + p.w + 6 && doc.y >= p.y - 6 && doc.y <= p.y + p.h + 6) return { index: i, at: [(doc.x - p.x) / 0.75, (doc.y - p.y) / 0.75] };
    }
    return null;
  }

  cursorAt(x: number, y: number): string {
    if (!this.deck) return 'default';
    const handle = this.shapes.handleCursor(x, y);
    if (handle) return handle;
    const hit = this.slideAt(x, y);
    if (!hit || this.sorter) return 'default';
    return this.shapes.cursorAt(this.placed[hit.index].slide, hit.at);
  }

  press(x: number, y: number, shift: boolean, clicks: number, additive: boolean): void {
    if (!this.deck) return;
    this.focus();
    if (this.shapes.pressHandle(x, y)) return;
    const hit = this.slideAt(x, y);
    if (!hit) {
      this.shapes.reset();
      this.redraw();
      return;
    }
    if (hit.index !== this.current) {
      this.shapes.reset();
      this.current = hit.index;
      this.showNotes();
      announce(this.slideMessage(hit.index));
    }
    if (this.sorter) {
      this.redraw();
      if (clicks >= 2) {
        this.toggleSorter();
        this.go(hit.index);
      }
      return;
    }
    this.shapes.press(this.placed[hit.index].slide, hit.at, shift, clicks, additive);
  }

  /** A drag is selecting text or shapes (not moving, sizing or turning them): it scrolls at the view's edges. */
  get isSelecting(): boolean {
    return this.shapes.isSelecting;
  }

  drag(x: number, y: number, shift: boolean): void {
    const p = this.placed[this.current];
    if (!p || !this.deck) return;
    const doc = this.deps.camera.toDocument(x, y);
    this.shapes.drag(p.slide, [(doc.x - p.x) / 0.75, (doc.y - p.y) / 0.75], shift);
  }

  release(): void {
    if (this.deck) this.shapes.release();
  }

  contextMenu(clientX: number, clientY: number, x: number, y: number): void {
    if (!this.deck) return;
    const hit = this.slideAt(x, y);
    if (hit && hit.index !== this.current) {
      this.shapes.reset();
      this.current = hit.index;
    }
    const slide = this.pages[this.current];
    if (hit && slide && !this.sorter && !this.shapes.text) {
      const view = this.shapes.shapeAt(slide, hit.at);
      if (view && !this.shapes.selected.includes(view.top.element)) this.shapes.selected = [view.top.element];
    }
    this.redraw();
    const op = (o: SlidesOp): PopupItem => ({ label: t(`slides.op.${o}` as MessageKey), run: () => void this.slidesOp(o), disabled: this.readOnly });
    const items: PopupItem[] = [];
    if (this.shapes.selected.length && !this.shapes.text) {
      items.push(op('cut'), op('copy'), op('paste'), 'separator', op('deleteShape'), op('duplicateShape'), 'separator');
      items.push(...this.shapes.colorMenus(), 'separator');
      items.push({ label: t('slides.arrange'), items: [op('bringToFront'), op('bringForward'), op('sendBackward'), op('sendToBack')] });
    } else if (this.shapes.text) {
      items.push(op('cut'), op('copy'), op('paste'));
    } else if (this.masterView) {
      items.push(op('paste'), 'separator', op('background'), op('theme'), { label: t('slides.closeMaster'), run: () => this.toggleMasterView() });
    } else {
      items.push(op('paste'), 'separator', op('newSlide'), op('duplicateSlide'), op('deleteSlide'), op('hideSlide'), 'separator', { label: t('slides.op.layout'), items: this.layoutItems() }, op('resetSlide'), op('background'));
    }
    showPopupMenu(items, clientX, clientY, t('slides.editor'), () => this.focus());
  }

  // ---- Keys and typing ----------------------------------------------------------------------------------------------
  private listen(): void {
    this.input.addEventListener('keydown', (e) => this.key(e));
    attachTextInput(this.input, {
      insert: (text) => this.shapes.typed(text),
      key: (k) => {
        if (k.kind === 'delete') this.shapes.deleteKey(k.direction === 'backward', k.unit === 'word');
        else if (k.kind === 'enter') {
          if (!this.shapes.enter(k.shift) && !this.readOnly) this.shapeKey(new KeyboardEvent('keydown', { key: 'Enter' }), false);
        }
        else if (k.kind === 'undo') this.undo();
        else if (k.kind === 'redo') this.redo();
      },
      copy: () => this.shapes.copyText(),
      cut: () => this.shapes.cutText(),
      copyOther: (cut) => {
        if (this.shapes.text || !this.shapes.selected.length) return false;
        this.copyShapes(cut);
        return true;
      },
      paste: (clip) => void this.pasteText(clip.text ?? ''),
    });
    this.notesInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.commitNotes();
        this.focus();
      }
    });
    this.notesInput.addEventListener('blur', () => this.commitNotes());
  }

  private key(e: KeyboardEvent): void {
    if (!this.deck) return;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (this.shapes.text) {
      if (this.shapes.textKey(e)) {
        e.preventDefault();
        return;
      }
    } else if (this.shapeKey(e, mod)) {
      e.preventDefault();
      return;
    }
    if (this.deps.viewKey(e) || this.deps.appKey(e)) e.preventDefault();
  }

  /** Keys with no text in hand: the selected shapes' (drawingml/editor.ts), then the slides'. */
  private shapeKey(e: KeyboardEvent, mod: boolean): boolean {
    const slide = this.pages[this.current];
    if (!slide) return false;
    switch (e.key) {
      case 'Escape':
        if (this.presenter) return false;
        // Nothing selected in master view: Escape closes it, as the bar's button does.
        if (!this.shapes.selected.length && this.masterView) {
          this.toggleMasterView();
          return true;
        }
        this.shapes.selected = [];
        this.redraw();
        return true;
      case 'Enter':
      case 'F2':
        if (this.shapes.selected.length !== 1 || this.readOnly) {
          if (!this.shapes.selected.length && e.key === 'Enter' && !mod) {
            void this.slidesOp('newSlide');
            return true;
          }
          return false;
        }
        break;
      case 'Delete':
      case 'Backspace':
        if (this.readOnly) return true;
        if (!this.shapes.selected.length) {
          void this.slidesOp('deleteSlide');
          return true;
        }
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown':
        if (!this.shapes.selected.length) {
          if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') this.go(Math.max(0, this.current - 1));
          else this.go(Math.min(this.slideCount - 1, this.current + 1));
          return true;
        }
        break;
      case 'PageDown':
        this.go(Math.min(this.slideCount - 1, this.current + 1));
        return true;
      case 'PageUp':
        this.go(Math.max(0, this.current - 1));
        return true;
      case 'Home':
        if (mod || !this.shapes.selected.length) {
          this.go(0);
          return true;
        }
        return false;
      case 'End':
        if (mod || !this.shapes.selected.length) {
          this.go(this.slideCount - 1);
          return true;
        }
        return false;
      case 'F5':
        void this.slidesOp(e.shiftKey ? 'presentCurrent' : 'presentStart');
        return true;
    }
    if (this.shapes.shapeKey(e)) return true;
    if (mod && !e.altKey) {
      switch (e.key.toLowerCase()) {
        case 'a':
          this.selectAll();
          return true;
        case 'd':
          if (!this.readOnly) void this.slidesOp(this.shapes.selected.length ? 'duplicateShape' : 'duplicateSlide');
          return true;
        case 'm':
          if (!this.readOnly) void this.slidesOp('newSlide');
          return true;
        case 'z':
          e.shiftKey ? this.redo() : this.undo();
          return true;
        case 'y':
          this.redo();
          return true;
      }
    }
    return false;
  }

  // ---- Commands from the menus and toolbar --------------------------------------------------------------------------
  formatState(): FormatState {
    return this.shapes.formatState();
  }

  /** A formatting command from the toolbar or the Format menu; false if slides have no such formatting. */
  formatAction(action: Action): boolean {
    if (!this.deck) return false;
    return this.shapes.formatAction(action);
  }

  async slidesOp(op: SlidesOp): Promise<void> {
    const deck = this.deck;
    if (!deck) return;
    const slide = this.pages[this.current];
    if (op === 'editMaster') return this.toggleMasterView();
    if (op === 'presentStart' || op === 'presentCurrent') {
      if (this.masterView) this.toggleMasterView();
      return this.present(op === 'presentStart' ? 0 : this.current);
    }
    if (op === 'sorter') return this.toggleSorter();
    if (op === 'notes') return this.toggleNotes();
    if (op === 'copy') return void this.copy();
    if (op === 'cut') return void this.cut();
    if (op === 'paste') return void this.paste();
    if (this.readOnly) return;
    if (op === 'background') return this.backgroundDialog();
    if (op === 'theme') return this.themeDialog();
    // Commands about slides do nothing in master view, whose pages are masters and layouts.
    if (this.masterView && SLIDE_ONLY_OPS.has(op)) return;
    const tx = (label: string): Transaction => new Transaction(deck, label);
    const current = this.currentSlide;
    switch (op) {
      case 'newSlide': {
        const layout = this.layoutFor(current);
        if (!layout) return;
        const step = tx(t('slides.op.newSlide'));
        await addSlide(deck, layout, this.current + 1, step);
        this.commit(step, true);
        this.go(this.current + 1);
        return;
      }
      case 'duplicateSlide': {
        if (!current) return;
        const step = tx(t('slides.op.duplicateSlide'));
        await duplicateSlide(deck, current, step);
        this.commit(step, true);
        this.go(this.current + 1);
        return;
      }
      case 'deleteSlide': {
        if (!current || deck.slides.length <= 1) return;
        const step = tx(t('slides.op.deleteSlide'));
        await deleteSlides(deck, [current], step);
        this.commit(step, true);
        this.go(Math.min(this.current, this.pages.length - 1));
        return;
      }
      case 'hideSlide': {
        if (!current) return;
        const step = tx(t('slides.op.hideSlide'));
        setHidden(current, !isHidden(current), step);
        this.commit(step);
        return;
      }
      case 'moveSlideUp':
      case 'moveSlideDown': {
        if (!slide) return;
        const to = this.current + (op === 'moveSlideUp' ? -1 : 1);
        if (to < 0 || to >= this.pages.length) return;
        await this.moveSlide(this.current, to);
        return;
      }
      case 'layout':
        showPopupMenu(this.layoutItems(), this.canvas.getBoundingClientRect().left + 40, this.canvas.getBoundingClientRect().top + 40, t('slides.op.layout'), () => this.focus());
        return;
      case 'resetSlide': {
        if (!current) return;
        const step = tx(t('slides.op.resetSlide'));
        resetToLayout(current, step);
        this.commit(step);
        return;
      }
      case 'textBox':
      case 'shape':
      case 'table':
        if (op === 'shape') {
          const rect = this.canvas.getBoundingClientRect();
          showPopupMenu(
            shapeMenuItems(SHAPE_GROUPS, (c) => this.insertShape(c.preset, shapeName(c.id))),
            rect.left + 40,
            rect.top + 40,
            t('slides.op.shape'),
            () => this.focus(),
          );
        } else if (op === 'table') {
          const rect = this.canvas.getBoundingClientRect();
          const sizes: [number, number][] = [
            [2, 2],
            [3, 3],
            [4, 3],
            [5, 4],
            [6, 5],
          ];
          showPopupMenu(sizes.map(([c, r]) => ({ label: t('slides.tableSize', { columns: c, rows: r }), run: () => this.insertTable(r, c) })), rect.left + 40, rect.top + 40, t('slides.op.table'), () => this.focus());
        } else this.insertShape('textBox');
        return;
      case 'picture': {
        const file = await this.deps.pickImage();
        if (file) await this.insertPicture(new Uint8Array(await file.arrayBuffer()), file.name);
        return;
      }
      case 'deleteShape': {
        if (!slide || !this.shapes.selected.length) return;
        const step = tx(t('slides.op.deleteShape'));
        deleteShapes(slide, this.shapes.selected, step);
        this.shapes.selected = [];
        this.commit(step);
        announce(t('slides.deleted'));
        return;
      }
      case 'duplicateShape': {
        if (!slide || !this.shapes.selected.length) return;
        const step = tx(t('slides.op.duplicateShape'));
        this.shapes.selected = duplicateShapes(slide, this.shapes.selected, step);
        this.commit(step);
        return;
      }
      case 'bringToFront':
      case 'bringForward':
      case 'sendBackward':
      case 'sendToBack': {
        if (!slide || !this.shapes.selected.length) return;
        const order: Order = op === 'bringToFront' ? 'front' : op === 'bringForward' ? 'forward' : op === 'sendBackward' ? 'backward' : 'back';
        const step = tx(t(`slides.op.${op}`));
        reorder(slide, this.shapes.selected, order, step);
        this.commit(step);
        return;
      }
    }
  }

  private layoutFor(slide: SlidePart | undefined): LayoutPart | undefined {
    const deck = this.deck!;
    const master = slide?.layout.master ?? deck.masters[0];
    const layouts = deck.layoutsOf(master);
    // A new slide after the title slide takes Title and Content, as in PowerPoint; otherwise the same layout as the slide before it.
    if (slide && slide.layout.xml.attrs.type !== 'title' && kid(slide.layout.xml, 'p:cSld')) return slide.layout;
    return layouts.find((l) => l.xml.attrs.type === 'obj') ?? layouts[1] ?? layouts[0];
  }

  private layoutItems(): PopupItem[] {
    const deck = this.deck;
    const slide = this.currentSlide;
    if (!deck || !slide) return [];
    return deck.layoutsOf(slide.layout.master).map((layout) => ({
      label: (at(layout.xml, 'p:cSld')?.attrs.name ?? layout.name.replace(/^.*\//, '')) + (layout === slide.layout ? ' ✓' : ''),
      run: () => void this.changeLayout(layout),
    }));
  }

  private async changeLayout(layout: LayoutPart): Promise<void> {
    const deck = this.deck;
    const slide = this.currentSlide;
    if (!deck || !slide || this.readOnly) return;
    const step = new Transaction(deck, t('slides.op.layout'));
    await changeLayout(deck, slide, layout, step);
    this.commit(step, true);
  }

  async moveSlide(from: number, to: number): Promise<void> {
    const deck = this.deck;
    const slide = deck?.slides[from];
    if (!deck || !slide || this.readOnly || this.masterView) return;
    const step = new Transaction(deck, t('slides.undo.moveSlide'));
    await moveSlides(deck, [slide], to, step);
    this.commit(step, true);
    this.current = deck.slides.indexOf(slide);
    announce(this.slideMessage(this.current));
  }

  async deleteSlideAt(index: number): Promise<void> {
    if (!this.deck || this.readOnly || this.masterView) return;
    this.current = index;
    await this.slidesOp('deleteSlide');
  }

  /** A new shape (or, for "textBox", a text box) in the middle of the slide in hand, named `name`. */
  private insertShape(preset: string, name = ''): void {
    const deck = this.deck;
    const slide = this.pages[this.current];
    if (!deck || !slide || this.readOnly) return;
    const textBox = preset === 'textBox';
    const w = textBox ? Math.round(deck.width * 0.4) : Math.round(Math.min(deck.width, deck.height) * 0.3);
    const hh = textBox ? 369332 : isLinePreset(preset) ? 0 : w;
    const frame: Frame = { x: Math.round((deck.width - w) / 2), y: Math.round((deck.height - hh) / 2), w, h: hh, rot: 0, flipH: false, flipV: false };
    const step = new Transaction(deck, t('slides.undo.insert'));
    step.touch(slide);
    const tree = treeOf(slide);
    const element = newShape(tree, textBox ? 'rect' : preset, frame, textBox ? t('slides.textBoxName') : name, textBox);
    tree.children.push(element);
    this.shapes.selected = [element];
    this.commit(step);
    if (textBox) this.shapes.editText(slide, element, element, 'end');
    announce(t('slides.inserted'));
  }

  private insertTable(rows: number, cols: number): void {
    const deck = this.deck;
    const slide = this.pages[this.current];
    if (!deck || !slide || this.readOnly) return;
    const w = Math.round(deck.width * 0.7);
    const frame: Frame = { x: Math.round((deck.width - w) / 2), y: Math.round(deck.height * 0.3), w, h: 0, rot: 0, flipH: false, flipV: false };
    const step = new Transaction(deck, t('slides.undo.insert'));
    step.touch(slide);
    const tree = treeOf(slide);
    const element = newTable(tree, rows, cols, frame, t('slides.tableName'));
    tree.children.push(element);
    this.shapes.selected = [element];
    this.commit(step);
    announce(t('slides.inserted'));
  }

  async insertPicture(bytes: Uint8Array, name: string): Promise<void> {
    const deck = this.deck;
    const slide = this.pages[this.current];
    if (!deck || !slide || this.readOnly) return;
    let bitmap: ImageBitmap;
    let ext: string;
    try {
      // Kept as a kind PowerPoint shows, named for what the bytes are: a HEIC or BMP picture is written as another kind.
      const kind = sniffImage(bytes)?.type;
      if (kind !== 'png' && kind !== 'jpeg' && kind !== 'gif' && kind !== 'webp') bytes = (await toPng(name, bytes)).bytes;
      ext = sniffImage(bytes)?.type ?? 'png';
      bitmap = await decodeImage(bytes);
    } catch {
      this.deps.notify(t('slides.pictureUnreadable'));
      return;
    }
    if (this.deck !== deck) return;
    const media = deck.addMedia(bytes, ext);
    const scale = Math.min(1, (deck.width * 0.6) / (bitmap.width * EMU_PER_PX), (deck.height * 0.6) / (bitmap.height * EMU_PER_PX));
    const w = Math.round(bitmap.width * EMU_PER_PX * scale);
    const hh = Math.round(bitmap.height * EMU_PER_PX * scale);
    const step = new Transaction(deck, t('slides.undo.insert'));
    step.touch(slide);
    const element = newPicture(slide, media, { x: Math.round((deck.width - w) / 2), y: Math.round((deck.height - hh) / 2), w, h: hh, rot: 0, flipH: false, flipV: false }, name.replace(/\.[^.]*$/, ''), '');
    treeOf(slide).children.push(element);
    this.images.set(`pptx:${media}`, bitmap);
    this.shapes.selected = [element];
    this.commit(step);
    announce(t('slides.inserted'));
  }

  // ---- Undo ---------------------------------------------------------------------------------------------------------

  private commit(tx: Transaction, structure = false, merge?: string, before?: unknown): void {
    this.history.commit(tx, { before: before ?? null, after: null }, merge);
    this.changed(structure || tx.touched.has(this.deck!.presentation.name));
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  get hasSelection(): boolean {
    return this.shapes.hasSelection;
  }

  undo(): void {
    void this.step(true);
  }

  redo(): void {
    void this.step(false);
  }

  private async step(back: boolean): Promise<void> {
    const deck = this.deck;
    if (!deck || this.readOnly) return;
    const slideName = this.pages[this.current]?.name;
    const step = back ? this.history.undo(deck) : this.history.redo(deck);
    if (!step) return;
    this.shapes.reset();
    deck.refreshThemes();
    await deck.loadSlides();
    const index = this.pages.findIndex((s) => s.name === slideName);
    // The slide changed by the step comes into view.
    const touched = this.pages.findIndex((s) => step.before.has(s.name));
    this.current = touched >= 0 ? touched : index >= 0 ? index : Math.min(this.current, this.pages.length - 1);
    this.changed(true);
    this.showNotes();
    announce(t(back ? 'slides.undone' : 'slides.redone', { what: step.label }));
  }

  // ---- Clipboard ----------------------------------------------------------------------------------------------------

  private copyShapes(cut: boolean): void {
    const deck = this.deck;
    const slide = this.pages[this.current];
    if (!deck || !slide || !this.shapes.selected.length) return;
    const elements = this.shapes.selected.map((e) => cloneElement(e));
    const text = elements.map((e) => kids(kid(e, 'p:txBody'), 'a:p').map(paragraphText).join('\n')).filter(Boolean).join('\n\n');
    const key = `golem-slides:${Math.random().toString(36).slice(2)}`;
    this.copied = { elements, from: slide, key };
    void navigator.clipboard?.writeText(text || key).catch(() => undefined);
    this.copiedText = text || key;
    if (cut && !this.readOnly) void this.slidesOp('deleteShape');
  }

  private copiedText = '';

  async copy(): Promise<void> {
    if (this.shapes.text) {
      const text = this.shapes.copyText();
      if (text) await navigator.clipboard?.writeText(text).catch(() => undefined);
    } else this.copyShapes(false);
  }

  async cut(): Promise<void> {
    if (this.shapes.text) {
      await this.copy();
      this.shapes.cutText();
    } else this.copyShapes(true);
  }

  async paste(): Promise<void> {
    const clip = await readClipboard();
    await this.pasteText(clip?.text ?? '');
  }

  private async pasteText(text: string): Promise<void> {
    if (this.readOnly || !this.deck) return;
    const slide = this.pages[this.current];
    // Shapes copied here come back as shapes, when the clipboard still holds what was copied with them.
    if (!this.shapes.text && this.copied && slide && (text === this.copiedText || !text)) {
      const step = new Transaction(this.deck, t('slides.undo.paste'));
      const offset = this.copied.from === slide ? 228600 : 0;
      // Pictures copied to another slide need their relationships there.
      const fixed = this.copied.elements.map((e) => this.carryRelationships(cloneElement(e), this.copied!.from, slide));
      step.touch(slide);
      const tree = treeOf(slide);
      const before = tree.children.length;
      tree.children.push(...fixed);
      this.shapes.selected = duplicateShapes(slide, fixed, step, offset);
      tree.children.splice(before, fixed.length);
      this.commit(step);
      return;
    }
    if (!text) return;
    if (this.shapes.pasteText(text)) return;
    if (!slide) return;
    // Text pasted with no text in hand: a new text box holding it.
    this.insertShape('textBox');
    if (this.shapes.text) this.shapes.typed(text);
  }

  /** Copies of a shape's relationship ids (pictures, links) re-made on another slide. */
  private carryRelationships(element: XmlElement, from: PagePart, to: PagePart): XmlElement {
    if (from === to) return element;
    const walk = (e: XmlElement): void => {
      for (const [k, v] of Object.entries(e.attrs)) {
        if (!k.startsWith('r:')) continue;
        const rel = from.rels.byId(v);
        if (!rel) continue;
        const id = rel.external ? to.rels.add(rel.type, rel.target, true) : to.rels.add(rel.type, from.rels.partName(rel));
        e.attrs = { ...e.attrs, [k]: id };
      }
      for (const c of e.children) if (typeof c !== 'string') walk(c);
    };
    walk(element);
    return element;
  }

  selectAll(): void {
    this.shapes.selectAll();
  }

  insert(text: string): void {
    this.shapes.typed(text);
  }

  // ---- Views: sorter, notes, presenting ---------------------------------------------------------------------------

  get isSorter(): boolean {
    return this.sorter;
  }

  get notesOpen(): boolean {
    return this.notesShown;
  }

  // ---- Design: background and theme -------------------------------------------------------------------------------------

  /** Slide › Background: sets the background of the slide in hand (master view: the master or layout), or of every slide. */
  private async backgroundDialog(): Promise<void> {
    const deck = this.deck;
    const page = this.pages[this.current];
    if (!deck || !page || this.readOnly) return;
    this.shapes.leaveText();
    const own = backgroundOf(page);
    const shown = colorContext(deck, page);
    const fill = backgroundFill(deck, page, shown);
    const fallback = fill.kind === 'solid' && fill.color ? `#${hexOf(fill.color)}` : '#FFFFFF';
    const master = masterOfPage(page);
    const answer = await showBackgroundDialog(own, fallback, { canReset: !!at(page.xml, 'p:cSld/p:bg') && page !== master, allLabel: t('slides.background.applyAll') }, () => this.deps.pickImage());
    this.focus();
    if (!answer || this.deck !== deck) return;
    let spec = answer.spec;
    if (spec?.kind === 'picture') {
      const media = answer.picture ? await this.addPictureMedia(answer.picture.bytes, answer.picture.name) : null;
      if (!media || this.deck !== deck) return;
      spec = { kind: 'picture', media };
    }
    const step = new Transaction(deck, t('slides.background.title'));
    if (answer.scope === 'all' && spec) setBackgroundEverywhere(deck, master, spec, step);
    else setBackground(page, answer.scope === 'reset' ? null : spec, step);
    this.commit(step);
    announce(t('slides.background.done'));
  }

  /** Puts a picture's bytes in the deck (as a kind PowerPoint shows) and returns its part name; null if it can't be read. */
  private async addPictureMedia(bytes: Uint8Array, name: string): Promise<string | null> {
    const deck = this.deck!;
    try {
      const kind = sniffImage(bytes)?.type;
      if (kind !== 'png' && kind !== 'jpeg' && kind !== 'gif' && kind !== 'webp') bytes = (await toPng(name, bytes)).bytes;
      const bitmap = await decodeImage(bytes);
      const media = deck.addMedia(bytes, sniffImage(bytes)?.type ?? 'png');
      this.images.set(`pptx:${media}`, bitmap);
      return media;
    } catch {
      this.deps.notify(t('slides.pictureUnreadable'));
      return null;
    }
  }

  /** Slide › Theme: the deck's colours, fonts, and light or dark pages, for every master. */
  private async themeDialog(): Promise<void> {
    const deck = this.deck;
    const page = this.pages[this.current];
    if (!deck || !page || this.readOnly) return;
    this.shapes.leaveText();
    const master = masterOfPage(page);
    const now = currentDesign(master);
    const answer = await showThemeDialog({ ...now, name: master.theme.name }, () => this.deps.pickDeck(), async (file) => readOtherTheme(new Uint8Array(await file.arrayBuffer()), file.name.replace(/\.[^.]*$/, '')));
    this.focus();
    if (!answer || this.deck !== deck) return;
    const step = new Transaction(deck, t('slides.theme.title'));
    const themes = new Set(deck.masters.map((m) => deck.themePart(m)).filter((p) => !!p));
    for (const theme of themes) {
      setThemeColors(theme!, answer.colors, step);
      setThemeFonts(theme!, answer.fonts, step);
    }
    for (const m of deck.masters) if ((m.colorMap.bg1 === 'dk1') !== answer.dark) setDarkPages(m, answer.dark, step);
    deck.refreshThemes();
    this.commit(step);
    announce(t('slides.theme.done'));
  }

  get isMasterView(): boolean {
    return this.masterView;
  }

  /** Opens master view (the masters and their layouts, edited as slides are) on the layout of the slide in hand, or closes it. */
  toggleMasterView(): void {
    const deck = this.deck;
    if (!deck) return;
    this.shapes.leaveText();
    this.commitNotes();
    this.shapes.selected = [];
    if (!this.masterView) {
      const slide = this.currentSlide;
      this.slideBeforeMaster = this.current;
      this.masterView = true;
      this.current = Math.max(0, slide ? this.pages.indexOf(slide.layout) : 0);
    } else {
      this.masterView = false;
      this.current = Math.min(this.slideBeforeMaster, deck.slides.length - 1);
    }
    this.masterBar.hidden = !this.masterView;
    this.layout();
    this.contentVersion++;
    this.thumbs.clear();
    this.showNotes();
    this.go(this.current, false);
    announce(this.masterView ? `${t('slides.masterOn')}. ${this.slideMessage(this.current)}` : `${t('slides.masterOff')}. ${this.slideMessage(this.current)}`);
  }

  toggleSorter(): void {
    this.shapes.reset();
    this.sorter = !this.sorter;
    this.layout();
    const cam = this.deps.camera;
    const viewW = this.canvas.clientWidth || 800;
    const viewH = this.canvas.clientHeight || 600;
    if (this.sorter) cam.fit(this.bounds(), viewW, viewH, 32);
    else this.go(this.current, false);
    this.onState?.();
    this.deps.render();
    announce(this.sorter ? t('slides.sorterOn') : t('slides.sorterOff'));
  }

  private toggleNotes(): void {
    this.notesShown = !this.notesShown;
    this.showNotes();
    if (this.notesShown) this.notesInput.focus();
    this.onState?.();
  }

  private notesFor: SlidePart | null = null;
  /** The notes put in the box or last kept from it: only what is typed since is kept, once. */
  private notesKept = '';
  /** The last notes being kept (a slide's first notes take a moment: their part is made). */
  private notesSaving: Promise<void> = Promise.resolve();

  private showNotes(): void {
    this.commitNotes();
    this.notesBar.hidden = !this.notesShown || !this.deck || this.masterView;
    const slide = this.currentSlide ?? null;
    this.notesFor = slide;
    this.notesInput.value = slide ? this.deck!.notesText(slide).replace(/\u000b/g, '\n') : '';
    this.notesKept = this.notesInput.value;
    this.notesInput.readOnly = this.readOnly;
  }

  private commitNotes(): void {
    const deck = this.deck;
    const slide = this.notesFor;
    if (!deck || !slide || this.readOnly || this.notesBar.hidden) return;
    const text = this.notesInput.value;
    if (text === this.notesKept) return;
    this.notesKept = text;
    const step = new Transaction(deck, t('slides.undo.notes'));
    this.notesSaving = setNotes(deck, slide, text, step).then((done) => {
      // Another deck was opened meanwhile: this one has been saved, and its history is gone.
      if (this.deck !== deck) return;
      if (!done) return this.deps.notify(t('slides.noNotesMaster'));
      this.commit(step);
      // Shown again (the slide was left and come back to) before they were kept.
      if (this.notesFor === slide && this.notesInput.value === this.notesKept && this.notesKept !== text) this.notesInput.value = this.notesKept = text;
    });
  }

  private present(from: number): void {
    const deck = this.deck;
    if (!deck) return;
    this.shapes.leaveText();
    const fonts = this.fonts!;
    this.presenter?.close();
    this.presenter = new Presenter({
      deck,
      start: from,
      scene: (slide, number) => slideScene(deck, slide, { measure: fonts, family: (f) => fonts.family(f), number }).scene,
      images: () => this.images as ImageCache,
      want: (scene) => this.wantImages(scene),
      notes: (slide) => deck.notesText(slide).replace(/\u000b/g, '\n'),
      title: (slide) => this.titleOf(slide),
      closed: (at2) => {
        this.presenter = null;
        this.go(at2, false);
        this.focus();
      },
    });
    this.presenter.open();
  }

  // ---- The rest ---------------------------------------------------------------------------------------------------

  focus(): void {
    focusTextInput(this.input);
  }

  get hasFocus(): boolean {
    return this.el.contains(document.activeElement);
  }

  regions(): Region[] {
    return [
      {
        el: this.el,
        focus: () => {
          this.focus();
          return document.activeElement === this.input;
        },
      },
      {
        el: this.notesBar,
        focus: () => {
          if (this.notesBar.hidden) return false;
          this.notesInput.focus();
          return document.activeElement === this.notesInput;
        },
      },
    ];
  }

  footerInfo(): { slide: number; count: number } | null {
    return this.deck ? { slide: this.current + 1, count: this.slideCount } : null;
  }

  private redraw(): void {
    this.painted = '';
    this.onState?.();
    this.deps.render();
  }

  /** The text of every slide and its notes, a line per paragraph. */
  deckText(): string {
    return this.deck ? deckLines(this.deck).join('\n') : '';
  }

  /** A deck's outline and selection, for tests and the automation API. */
  debugState(): unknown {
    const deck = this.deck;
    if (!deck) return null;
    return {
      masterView: this.masterView,
      slides: this.pages.map((s) => ({ name: s.name, title: this.titleOf(s), hidden: isHidden(s), layout: isSlidePart(s) ? (at(s.layout.xml, 'p:cSld')?.attrs.name ?? '') : (at(s.xml, 'p:cSld')?.attrs.name ?? ''), shapes: kids(at(s.xml, 'p:cSld/p:spTree')).filter((e) => /^p:(sp|pic|grpSp|cxnSp|graphicFrame)$/.test(e.name)).map((e) => ({ name: cNvPr(e)?.attrs.name ?? '', text: kids(kid(e, 'p:txBody'), 'a:p').map(paragraphText).join('\n'), x: Number(kid(xfrmOf(e), 'a:off')?.attrs.x ?? NaN), y: Number(kid(xfrmOf(e), 'a:off')?.attrs.y ?? NaN) })) })),
      current: this.current,
      selected: this.shapes.selected.map((e) => cNvPr(e)?.attrs.name ?? ''),
      editing: this.shapes.text ? { anchor: this.shapes.text.anchor, focus: this.shapes.text.focus } : null,
      sorter: this.sorter,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      presenting: this.presenter?.index ?? null,
    };
  }

  /** Where a shape of the slide in hand is on screen (CSS px of the canvas), by name: its middle, and its bottom right corner (a handle). For tests. */
  screenOf(name: string): { x: number; y: number; corner: { x: number; y: number } } | null {
    const p = this.placed[this.current];
    if (!p) return null;
    const view = this.viewsOf(p.slide).find((v) => cNvPr(v.shape.element)?.attrs.name === name);
    if (!view) return null;
    const cam = this.deps.camera;
    const scale = cam.zoom * CSS_PX_PER_POINT;
    const screen = (x: number, y: number): { x: number; y: number } => {
      const [sx, sy] = apply(view.matrix, x, y);
      return { x: (p.x + sx * 0.75 - cam.x) * scale, y: (p.y + sy * 0.75 - cam.y) * scale };
    };
    return { ...screen(view.w / 2, view.h / 2), corner: screen(view.w, view.h) };
  }

  get presenting(): boolean {
    return this.presenter !== null;
  }
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

