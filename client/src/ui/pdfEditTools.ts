// The tools of Edit PDF mode that work on a page's content: add text, a picture or a shape, white
// something out, and move, resize, restyle or delete what is selected. The palette (a section of the
// form palette, see formLayer.ts) holds the tools and the selection's settings; the layer over
// the pages holds the frame around a selected picture or shape, and takes the clicks and drags
// that place something new. Every change goes to the layout worker (see layout/pdfAnnotator.ts).

import { t } from '../i18n/index.ts';
import type { WireBox, WireCommand, WirePickedObject, WirePickedText } from '../layout/protocol.ts';
import { CSS_PX_PER_POINT, type Camera } from '../view/camera.ts';
import { h, isFormField, modalOpen } from './dom.ts';
import './pdfEditTools.css';

export interface ToolPage {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PdfEditToolsHost {
  camera: Camera;
  canvas: HTMLCanvasElement;
  page(id: number): ToolPage | undefined;
  /** The page under a point of the view (CSS px), and the point on it (points). */
  pageAt(cssX: number, cssY: number): { page: ToolPage; x: number; y: number } | null;
  send(command: WireCommand): void;
  notify(message: string): void;
  /** The families the app has a font file for, which text can be set in. */
  families(): Promise<string[]>;
}

type Tool = 'text' | 'check' | 'cross' | 'date' | 'rect' | 'ellipse' | 'line' | 'whiteout' | 'redact';
type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Tools only Edit PDF mode has (Fill In puts text and marks on a page, and nothing else). */
const EDIT_ONLY: (Tool | 'picture')[] = ['picture', 'rect', 'ellipse', 'line', 'whiteout', 'redact'];

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
/** A drag shorter than this (points) places a default-sized shape instead. */
const MIN_DRAG = 4;
/** What a check mark or cross measures, points. */
const MARK_SIZE = 14;
/** What a shape clicked into place measures, points. */
const DEFAULT_SHAPE: [number, number] = [120, 70];
/** Widest a picture is when it is added, points. */
const PICTURE_WIDTH = 300;

const toolLabel = (tool: Tool | 'picture'): string => t(`chrome.pdfEdit.tool.${tool}` as const);

export class PdfEditTools {
  /** The palette section. */
  readonly el = h('section', { class: 'wm-pdftools-section' });
  private readonly layer = h('div', { class: 'wm-pdftools' });
  private readonly catcher = h('div', { class: 'wm-pdftools-catcher' });
  private readonly rubber = h('div', { class: 'wm-pdftools-rubber' });
  private readonly frame = h('div', { class: 'wm-pdftools-frame' });
  private readonly hint = h('p', { class: 'wm-forms-hint' });
  private readonly properties = h('div', { class: 'wm-forms-properties' });
  private readonly buttons = new Map<Tool | 'picture', HTMLButtonElement>();
  private readonly file = h('input', { attrs: { type: 'file', accept: 'image/*', hidden: '' } });
  private tool: Tool | null = null;
  private text: WirePickedText | null = null;
  private object: WirePickedObject | null = null;
  /** A move or resize in progress: the frame's box so far. */
  private dragging: WireBox | null = null;

  constructor(
    parent: HTMLElement,
    private readonly host: PdfEditToolsHost,
  ) {
    const tools = h('div', { class: 'wm-forms-adds' });
    const add = (tool: Tool | 'picture') => {
      const button = h('button', { class: 'wm-forms-add', text: toolLabel(tool), attrs: { type: 'button', 'data-tool': tool } });
      if (tool === 'whiteout') button.title = t('chrome.pdfEdit.whiteout.tip');
      if (tool === 'redact') button.title = t('chrome.pdfEdit.redact.tip');
      button.addEventListener('click', () => (tool === 'picture' ? this.file.click() : this.choose(this.tool === tool ? null : tool)));
      this.buttons.set(tool, button);
      tools.append(button);
    };
    for (const tool of ['text', 'check', 'cross', 'date', 'picture', 'rect', 'ellipse', 'line', 'whiteout', 'redact'] as const) add(tool);
    for (const tool of EDIT_ONLY) this.buttons.get(tool)!.classList.add('wm-pdftools-edit-only');
    this.el.append(h('h3', { class: 'wm-pdftools-edit-only', text: t('chrome.pdfEdit.content') }), tools, this.hint, this.properties, this.file, this.pagesSection());
    this.file.addEventListener('change', () => {
      const file = this.file.files?.[0];
      this.file.value = '';
      if (file) void this.addPicture(file);
    });

    this.layer.append(this.catcher, this.rubber, this.frame);
    parent.append(this.layer);
    this.layer.hidden = true;
    this.catcher.hidden = this.rubber.hidden = this.frame.hidden = true;
    for (const handle of HANDLES) {
      const el = h('span', { class: `wm-pdftools-handle wm-pdftools-handle-${handle}`, attrs: { 'data-handle': handle } });
      this.frame.append(el);
    }
    this.frame.addEventListener('pointerdown', (e) => this.beginDrag(e));
    this.catcher.addEventListener('pointerdown', (e) => this.place(e));
    this.layer.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        host.canvas.dispatchEvent(new WheelEvent('wheel', e));
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => this.key(e), true);
    this.el.classList.add('wm-pdftools-fill');
    void host.families().then((list) => {
      this.families = list;
      delete this.properties.dataset.key;
      this.sync();
    }, () => {});
    this.sync();
  }

  private mode: 'fill' | 'edit' = 'fill';
  /** The app's font families (once known), for the font picker. */
  private families: string[] = [];

  /** Fill In mode shows only the tools that put something on a page; Edit PDF shows all. */
  setMode(mode: 'fill' | 'edit'): void {
    this.mode = mode;
    this.el.classList.toggle('wm-pdftools-fill', mode === 'fill');
    if (this.tool && mode === 'fill' && EDIT_ONLY.includes(this.tool)) this.tool = null;
    this.sync();
  }

  get placing(): boolean {
    return this.tool !== null;
  }

  /** What the worker says is picked or selected now. */
  update(text: WirePickedText | null, object: WirePickedObject | null): void {
    this.text = text;
    this.object = object;
    if (text || object) this.tool = null;
    this.sync();
    this.position();
  }

  /** Keeps the frame over its page (call on every frame the view may have moved). */
  position(): void {
    const object = this.object;
    const page = object && this.host.page(object.pageId);
    this.frame.hidden = !object || !page;
    if (!object || !page) return;
    const box = this.dragging ?? object.box;
    const { camera } = this.host;
    const scale = camera.zoom * CSS_PX_PER_POINT;
    const css = this.frame.style;
    css.transform = `translate(${(page.x + box.x - camera.x) * scale}px, ${(page.y + box.y - camera.y) * scale}px)`;
    css.width = `${box.width * scale}px`;
    css.height = `${box.height * scale}px`;
  }

  // --- pages ----------------------------------------------------------------------------------

  private pagesSection(): HTMLElement {
    const ops = ['rotateLeft', 'rotateRight', 'moveUp', 'moveDown', 'insert', 'duplicate', 'delete'] as const;
    const buttons = ops.map((op) => {
      const button = h('button', { class: 'wm-forms-add', text: t(`chrome.pdfEdit.page.${op}` as const), attrs: { type: 'button', 'data-op': op } });
      button.addEventListener('click', () => this.pageOp(op));
      return button;
    });
    return h('div', { class: 'wm-pdftools-pages wm-pdftools-edit-only' }, h('h3', { text: t('chrome.pdfEdit.pages') }), h('div', { class: 'wm-forms-adds' }, ...buttons), h('p', { class: 'wm-forms-hint', text: t('chrome.pdfEdit.pages.hint') }));
  }

  /** The page the page buttons act on: the one with something selected on it, else the one in the middle of the view. */
  private targetPage(): ToolPage | null {
    const selected = this.text?.pageId ?? this.object?.pageId;
    const page = selected !== undefined ? this.host.page(selected) : undefined;
    if (page) return page;
    const rect = this.layer.getBoundingClientRect();
    return (this.host.pageAt(rect.width / 2, rect.height / 2) ?? this.host.pageAt(rect.width / 2, rect.height / 3))?.page ?? null;
  }

  private pageOp(op: Exclude<Extract<WireCommand, { kind: 'pdfPageOp' }>['op'], 'move'>): void {
    const page = this.targetPage();
    if (!page) return;
    if (this.text || this.object) this.host.send({ kind: 'pdfPutDown' });
    this.host.send({ kind: 'pdfPageOp', page: page.id, op });
  }

  // --- choosing and placing -----------------------------------------------------------------

  private choose(tool: Tool | null): void {
    if (tool && (this.text || this.object)) this.host.send({ kind: 'pdfPutDown' });
    this.tool = tool;
    this.sync();
  }

  /** A click (text) or drag (a shape) on a page places something new. */
  private place(e: PointerEvent): void {
    const tool = this.tool;
    if (!tool || e.button !== 0) return;
    e.preventDefault();
    const rect = this.layer.getBoundingClientRect();
    const start = this.host.pageAt(e.clientX - rect.left, e.clientY - rect.top);
    if (!start) {
      this.choose(null);
      return;
    }
    if (tool === 'text' || tool === 'date') {
      this.tool = null;
      this.host.send({ kind: 'pdfAddText', page: start.page.id, x: start.x, y: start.y, ...(tool === 'date' && { text: new Date().toLocaleDateString() }) });
      this.sync();
      return;
    }
    if (tool === 'check' || tool === 'cross') {
      this.tool = null;
      const box = { x: Math.max(0, start.x - MARK_SIZE / 2), y: Math.max(0, start.y - MARK_SIZE / 2), width: MARK_SIZE, height: MARK_SIZE };
      this.host.send({ kind: 'pdfAddShape', page: start.page.id, shape: tool, box });
      this.sync();
      return;
    }
    const catcher = this.catcher;
    catcher.setPointerCapture(e.pointerId);
    const { page } = start;
    const clamp = (x: number, y: number) => ({ x: Math.min(Math.max(x, 0), page.width), y: Math.min(Math.max(y, 0), page.height) });
    let end = { x: start.x, y: start.y };
    const box = (): WireBox => ({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) });
    const show = () => {
      const scale = this.host.camera.zoom * CSS_PX_PER_POINT;
      const b = box();
      const css = this.rubber.style;
      this.rubber.hidden = false;
      css.transform = `translate(${(page.x + b.x - this.host.camera.x) * scale}px, ${(page.y + b.y - this.host.camera.y) * scale}px)`;
      css.width = `${b.width * scale}px`;
      css.height = `${b.height * scale}px`;
    };
    const move = (ev: PointerEvent) => {
      const at = this.host.pageAt(ev.clientX - rect.left, ev.clientY - rect.top);
      // Off the page, the drag goes on along its edge; dragging over another page can't be told from that page's coordinates, so it's held.
      const scale = this.host.camera.zoom * CSS_PX_PER_POINT;
      end = at && at.page.id === page.id ? clamp(at.x, at.y) : clamp(start.x + (ev.clientX - e.clientX) / scale, start.y + (ev.clientY - e.clientY) / scale);
      show();
    };
    const done = (ev: PointerEvent) => {
      catcher.removeEventListener('pointermove', move);
      catcher.removeEventListener('pointerup', done);
      catcher.removeEventListener('pointercancel', done);
      this.rubber.hidden = true;
      if (ev.type === 'pointercancel') return;
      let b = box();
      let rising = (end.x - start.x) * (end.y - start.y) < 0;
      if (b.width < MIN_DRAG && b.height < MIN_DRAG) {
        const [w, h] = tool === 'line' ? [DEFAULT_SHAPE[0], 0] : DEFAULT_SHAPE;
        b = { x: Math.min(start.x, page.width - w), y: Math.min(start.y, page.height - h), width: w, height: h };
        rising = false;
      }
      this.tool = null;
      this.host.send({ kind: 'pdfAddShape', page: page.id, shape: tool, box: b, flip: rising });
      this.sync();
    };
    catcher.addEventListener('pointermove', move);
    catcher.addEventListener('pointerup', done);
    catcher.addEventListener('pointercancel', done);
  }

  /** Adds a picture from a file, centered on the page in the middle of the view. */
  private async addPicture(file: File): Promise<void> {
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(file);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
      let data: Uint8Array = bytes;
      // Other kinds (WebP, GIF...) go in as PNG: a PDF holds JPEG and Flate pictures.
      if (!isJpeg && !isPng) {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
        data = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
      }
      const rect = this.layer.getBoundingClientRect();
      const at = this.host.pageAt(rect.width / 2, rect.height / 2) ?? this.host.pageAt(rect.width / 2, rect.height / 3);
      if (!at) return;
      const natural = bitmap.width * 0.75;
      const width = Math.min(natural, PICTURE_WIDTH, at.page.width * 0.8);
      const height = width * (bitmap.height / bitmap.width);
      const box: WireBox = { x: Math.max(0, at.x - width / 2), y: Math.max(0, at.y - height / 2), width, height };
      let binary = '';
      for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
      this.host.send({ kind: 'pdfAddImage', page: at.page.id, box, data: btoa(binary) });
    } catch (e) {
      this.host.notify(t('chrome.pdfEdit.pictureFailed', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      bitmap?.close();
    }
  }

  // --- moving and resizing ------------------------------------------------------------------

  private beginDrag(start: PointerEvent): void {
    const object = this.object;
    if (!object || start.button !== 0) return;
    start.preventDefault();
    start.stopPropagation();
    const handle = (start.target as HTMLElement).dataset.handle as Handle | undefined;
    const from = object.box;
    const page = this.host.page(object.pageId);
    const scale = this.host.camera.zoom * CSS_PX_PER_POINT;
    this.frame.setPointerCapture(start.pointerId);
    this.dragging = { ...from };
    const line = object.shape?.shape === 'line';
    const min = line ? 0 : 2;
    const move = (e: PointerEvent) => {
      const dx = (e.clientX - start.clientX) / scale;
      const dy = (e.clientY - start.clientY) / scale;
      let { x, y, width, height } = from;
      if (!handle) {
        x += dx;
        y += dy;
      } else {
        if (handle.includes('e')) width = Math.max(min, from.width + dx);
        if (handle.includes('s')) height = Math.max(min, from.height + dy);
        if (handle.includes('w')) {
          width = Math.max(min, from.width - dx);
          x = from.x + from.width - width;
        }
        if (handle.includes('n')) {
          height = Math.max(min, from.height - dy);
          y = from.y + from.height - height;
        }
      }
      // Kept on the page.
      if (page && !handle) {
        x = Math.min(Math.max(x, 0), Math.max(0, page.width - width));
        y = Math.min(Math.max(y, 0), Math.max(0, page.height - height));
      }
      this.dragging = { x, y, width, height };
      this.position();
    };
    const end = () => {
      this.frame.removeEventListener('pointermove', move);
      this.frame.removeEventListener('pointerup', end);
      this.frame.removeEventListener('pointercancel', end);
      const box = this.dragging;
      this.dragging = null;
      const changed = box && (Math.abs(box.x - from.x) > 0.01 || Math.abs(box.y - from.y) > 0.01 || Math.abs(box.width - from.width) > 0.01 || Math.abs(box.height - from.height) > 0.01);
      if (box && changed) {
        // Shown where it was dropped until the worker's answer puts it there for real.
        this.object = { ...object, box };
        this.host.send({ kind: 'pdfMove', box });
      }
      this.position();
    };
    this.frame.addEventListener('pointermove', move);
    this.frame.addEventListener('pointerup', end);
    this.frame.addEventListener('pointercancel', end);
  }

  private key(e: KeyboardEvent): void {
    // Keys typed in a box, or pressed in a dialog, are theirs.
    if (isFormField(e.target) || modalOpen()) return;
    if (e.key === 'Escape' && (this.tool || this.object)) {
      if (this.tool) this.choose(null);
      else this.host.send({ kind: 'pdfPutDown' });
    } else if (this.object && (e.key === 'Delete' || e.key === 'Backspace')) {
      this.host.send({ kind: 'delete', direction: 'backward' });
    } else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // --- the palette --------------------------------------------------------------------------

  private sync(): void {
    this.layer.hidden = false;
    this.catcher.hidden = this.tool === null;
    this.catcher.style.cursor = this.tool === 'text' ? 'text' : 'crosshair';
    for (const [tool, button] of this.buttons) button.classList.toggle('wm-pdftools-on', tool === this.tool);
    const placeText = this.tool === 'text' || this.tool === 'date' || this.tool === 'check' || this.tool === 'cross';
    this.hint.textContent = placeText ? t('chrome.pdfEdit.placeText') : this.tool ? t('chrome.pdfEdit.placeShape') : this.text || this.object ? '' : this.mode === 'fill' ? t('chrome.pdfEdit.fillHint') : t('chrome.pdfEdit.selectHint');
    this.syncProperties();
  }

  private syncProperties(): void {
    const { text, object } = this;
    const key = JSON.stringify([this.mode, this.families.length, text && [text.id, text.added, text.style], object && [object.id, object.kind, object.shape]]);
    // A control being used is left alone: the worker's answer to it would rebuild it under the pointer.
    if (this.properties.dataset.key === key) return;
    if (this.properties.dataset.key !== undefined && this.properties.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'number') return;
    this.properties.dataset.key = key;
    if (text) return this.properties.replaceChildren(...this.textProperties(text));
    if (object) return this.properties.replaceChildren(...this.objectProperties(object));
    this.properties.replaceChildren();
  }

  private textProperties(text: WirePickedText): HTMLElement[] {
    const { style } = text;
    const send = (change: Partial<Extract<WireCommand, { kind: 'pdfStyle' }>>) => this.host.send({ kind: 'pdfStyle', ...change });
    // The app's own fonts, then the three every PDF viewer has; and the text's current font if it is none of these.
    const standard = ['Helvetica', 'Times', 'Courier'];
    const choices = [...this.families, ...standard];
    if (!choices.includes(style.family)) choices.unshift(style.family);
    const family = h('select', { attrs: { 'aria-label': t('chrome.pdfEdit.font') } }, ...choices.map((f) => h('option', { text: f, attrs: { value: f } })));
    family.value = style.family;
    family.addEventListener('change', () => send({ font: family.value }));
    const toggle = (label: string, on: boolean, change: (on: boolean) => void) => {
      const box = h('input', { attrs: { type: 'checkbox' } });
      box.checked = on;
      box.addEventListener('change', () => change(box.checked));
      return h('label', { class: 'wm-forms-check' }, box, h('span', { text: label }));
    };
    const size = h('input', { class: 'wm-pdftools-number', attrs: { type: 'number', min: '1', max: '400', step: '0.5', 'aria-label': t('chrome.pdfEdit.size') } });
    size.value = String(Math.round(style.size * 10) / 10);
    size.addEventListener('change', () => {
      const value = Number(size.value);
      if (value >= 1 && value <= 400) send({ size: value });
    });
    size.addEventListener('keydown', (e) => e.stopPropagation());
    const color = h('input', { class: 'wm-pdftools-color', attrs: { type: 'color', 'aria-label': t('chrome.pdfEdit.color') } });
    color.value = hex(style.color);
    color.addEventListener('change', () => send({ color: color.value }));
    return [
      h('p', { class: 'wm-forms-kind', text: t('chrome.pdfEdit.text') }),
      h('label', { class: 'wm-forms-row' }, h('span', { text: t('chrome.pdfEdit.font') }), family),
      h('div', { class: 'wm-pdftools-row' }, toggle(t('chrome.pdfEdit.bold'), style.bold, (bold) => send({ bold })), toggle(t('chrome.pdfEdit.italic'), style.italic, (italic) => send({ italic }))),
      h('label', { class: 'wm-forms-row' }, h('span', { text: t('chrome.pdfEdit.size') }), size),
      h('label', { class: 'wm-forms-row' }, h('span', { text: t('chrome.pdfEdit.color') }), color),
      h('p', { class: 'wm-forms-hint', text: t('chrome.pdfEdit.styleHint') }),
      ...(text.added ? [this.deleteButton()] : []),
    ];
  }

  private objectProperties(object: WirePickedObject): HTMLElement[] {
    const rows: HTMLElement[] = [h('p', { class: 'wm-forms-kind', text: t(`chrome.pdfEdit.kind.${object.kind}` as const) })];
    const shape = object.shape;
    if (shape) {
      const send = (change: Partial<Extract<WireCommand, { kind: 'pdfShape' }>>) => this.host.send({ kind: 'pdfShape', ...change });
      const colorRow = (label: string, value: string | null, fallback: string, change: (v: string | null) => void, optional: boolean) => {
        const input = h('input', { class: 'wm-pdftools-color', attrs: { type: 'color', 'aria-label': label } });
        input.value = value ?? fallback;
        input.disabled = value === null;
        input.addEventListener('change', () => change(input.value));
        const on = h('input', { attrs: { type: 'checkbox', 'aria-label': label } });
        on.checked = value !== null;
        on.hidden = !optional;
        on.addEventListener('change', () => change(on.checked ? input.value : null));
        return h('label', { class: 'wm-forms-row' }, h('span', { text: label }), h('span', { class: 'wm-pdftools-pair' }, on, input));
      };
      rows.push(colorRow(t('chrome.pdfEdit.stroke'), shape.stroke, '#000000', (stroke) => send({ stroke }), shape.fill !== null || shape.shape !== 'line'));
      if (shape.shape !== 'line') rows.push(colorRow(t('chrome.pdfEdit.fill'), shape.fill, '#ffff00', (fill) => send({ fill }), true));
      const width = h('input', { class: 'wm-pdftools-number', attrs: { type: 'number', min: '0.25', max: '40', step: '0.25', 'aria-label': t('chrome.pdfEdit.width') } });
      width.value = String(shape.width);
      width.addEventListener('change', () => {
        const value = Number(width.value);
        if (value > 0 && value <= 40) send({ width: value });
      });
      width.addEventListener('keydown', (e) => e.stopPropagation());
      if (shape.stroke !== null) rows.push(h('label', { class: 'wm-forms-row' }, h('span', { text: t('chrome.pdfEdit.width') }), width));
    }
    rows.push(this.deleteButton());
    return rows;
  }

  private deleteButton(): HTMLElement {
    const remove = h('button', { class: 'wm-forms-delete', text: t('chrome.pdfEdit.delete'), attrs: { type: 'button' } });
    remove.addEventListener('click', () => this.host.send({ kind: 'delete', direction: 'backward' }));
    return remove;
  }
}

/** RGB 0–1 as #rrggbb. */
function hex(color: readonly number[]): string {
  return `#${color.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
}
