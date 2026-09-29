// Cropping a picture: a box over the picture that is dragged and resized, with a bar to pick its
// shape and apply or cancel. HTML over the canvas, like the form and pointer layers, kept over the
// picture as the view scrolls and zooms. The box is in the picture's own pixels (see dragBox in
// formats/imagePixels.ts for how handles move it).

import { boxWithAspect, clampBox, dragBox } from '../formats/imagePixels.ts';
import type { Box, Handle } from '../formats/imagePixels.ts';
import { t } from '../i18n/index.ts';
import { CSS_PX_PER_POINT, type Camera } from '../view/camera.ts';
import { h } from './dom.ts';
import './pictureTools.css';

export interface CropHost {
  camera: Camera;
  /** The picture's page: where it is, in points. */
  page(): { x: number; y: number; width: number; height: number } | undefined;
}

/** The shapes to pick from: width over height, or null for free. */
const SHAPES: [string, number | 'original' | null][] = [
  ['free', null],
  ['original', 'original'],
  ['1:1', 1],
  ['4:3', 4 / 3],
  ['3:2', 3 / 2],
  ['16:9', 16 / 9],
  ['3:4', 3 / 4],
  ['2:3', 2 / 3],
  ['9:16', 9 / 16],
];

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

interface Session {
  width: number;
  height: number;
  box: Box;
  aspect: number | null;
  done(box: Box | null): void;
}

export class CropLayer {
  readonly el = h('div', { class: 'wm-crop', attrs: { hidden: '' } });
  private readonly box = h('div', { class: 'wm-crop-box' });
  private readonly size = h('div', { class: 'wm-crop-size', attrs: { 'aria-live': 'polite' } });
  private readonly shape = h('select', { attrs: { 'aria-label': t('picture.crop.shape') } });
  private session: Session | null = null;
  private readonly keys = (e: KeyboardEvent) => {
    if (!this.session) return;
    if (e.key === 'Escape') this.finish(false);
    else if (e.key === 'Enter') this.finish(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  constructor(
    parent: HTMLElement,
    private readonly host: CropHost,
  ) {
    for (const handle of HANDLES) {
      const el = h('div', { class: 'wm-crop-handle', attrs: { 'data-handle': handle, title: t('picture.crop.handle') } });
      this.box.append(el);
      el.addEventListener('pointerdown', (e) => this.drag(e, handle));
    }
    this.box.append(this.size);
    this.box.addEventListener('pointerdown', (e) => {
      if (e.target === this.box) this.drag(e, 'move');
    });
    for (const [name, value] of SHAPES) {
      const option = h('option', { text: name === 'free' ? t('picture.crop.free') : name === 'original' ? t('picture.crop.original') : name });
      option.value = String(value);
      this.shape.append(option);
    }
    this.shape.addEventListener('change', () => this.chooseShape());
    const apply = h('button', { class: 'wm-button', text: t('picture.crop.apply'), attrs: { type: 'button' } });
    const cancel = h('button', { class: 'wm-button', text: t('picture.crop.cancel'), attrs: { type: 'button' } });
    apply.addEventListener('click', () => this.finish(true));
    cancel.addEventListener('click', () => this.finish(false));
    const bar = h('div', { class: 'wm-crop-bar' }, h('label', {}, h('span', { text: t('picture.crop.shape') }), this.shape), apply, cancel);
    this.el.append(this.box, bar);
    parent.append(this.el);
  }

  get active(): boolean {
    return this.session !== null;
  }

  /** Starts cropping a picture of this many pixels; `done` gets the box, or null when cancelled. */
  start(width: number, height: number, done: (box: Box | null) => void): void {
    this.session?.done(null);
    this.session = { width, height, box: { x: 0, y: 0, width, height }, aspect: null, done };
    // Start a little in from the edges, so the box is seen to be one.
    const inset = Math.round(Math.min(width, height) * 0.08);
    this.session.box = clampBox({ x: inset, y: inset, width: width - 2 * inset, height: height - 2 * inset }, width, height);
    this.shape.value = 'null';
    this.el.hidden = false;
    document.addEventListener('keydown', this.keys, true);
    this.position();
  }

  cancel(): void {
    this.finish(false);
  }

  private finish(apply: boolean): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.el.hidden = true;
    document.removeEventListener('keydown', this.keys, true);
    session.done(apply ? clampBox(session.box, session.width, session.height) : null);
  }

  private chooseShape(): void {
    const session = this.session;
    if (!session) return;
    const value = this.shape.value;
    session.aspect = value === 'original' ? session.width / session.height : value === 'null' ? null : Number(value);
    if (session.aspect !== null) {
      const fitted = boxWithAspect(session.box, session.aspect);
      session.box = fitted.width < 8 || fitted.height < 8 ? session.box : fitted;
    }
    this.position();
  }

  /** Where the picture's pixels are on screen: CSS pixels per picture pixel, and the picture's top-left. */
  private frame(): { scale: number; left: number; top: number } | null {
    const page = this.host.page();
    const session = this.session;
    if (!page || !session) return null;
    const { camera } = this.host;
    const perPoint = camera.zoom * CSS_PX_PER_POINT;
    return { scale: (page.width * perPoint) / session.width, left: (page.x - camera.x) * perPoint, top: (page.y - camera.y) * perPoint };
  }

  /** Puts the box where it is now (the view moved, or the box did). */
  position(): void {
    const session = this.session;
    const frame = this.frame();
    if (!session || !frame) return;
    const { box } = session;
    this.box.style.transform = `translate(${frame.left + box.x * frame.scale}px, ${frame.top + box.y * frame.scale}px)`;
    this.box.style.width = `${box.width * frame.scale}px`;
    this.box.style.height = `${box.height * frame.scale}px`;
    this.size.textContent = t('picture.crop.size', { width: Math.round(box.width), height: Math.round(box.height) });
  }

  private drag(e: PointerEvent, handle: Handle): void {
    const session = this.session;
    const frame = this.frame();
    if (!session || !frame || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const from = { x: e.clientX, y: e.clientY };
    const start = { ...session.box };
    const move = (m: PointerEvent) => {
      const dx = (m.clientX - from.x) / frame.scale;
      const dy = (m.clientY - from.y) / frame.scale;
      session.box = dragBox(start, handle, dx, dy, session, session.aspect);
      this.position();
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }
}
