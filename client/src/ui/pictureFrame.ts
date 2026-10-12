// The frame around the picture selected in a document: four handles to resize it (its shape is kept),
// drawn over the canvas like the crop box and kept over the picture as the view scrolls and zooms.
// Moving the picture is done on the canvas itself (see main.ts); this only shows it and resizes.

import { dragBox } from '../formats/imagePixels.ts';
import type { Box, Handle } from '../formats/imagePixels.ts';
import { CSS_PX_PER_POINT, type Camera } from '../view/camera.ts';
import { h } from './dom.ts';
import './pictureFrame.css';

/** The selected picture: its page and where it is on it, in points. */
export interface FramedPicture {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  floating: boolean;
}

export interface PictureFrameHost {
  camera: Camera;
  /** Where a page (by id) is, in points of the view, if it has been laid out. */
  page(id: number): { x: number; y: number } | undefined;
  /** The picture was resized: its new place on its page (points). */
  resized(box: Box, picture: FramedPicture): void;
}

const CORNERS: Handle[] = ['nw', 'ne', 'se', 'sw'];
/** No picture is kept inside anything: the page's edges are not the frame's. */
const UNBOUNDED = { width: 1e6, height: 1e6 };

export class PictureFrame {
  readonly el = h('div', { class: 'wm-picture-frame', attrs: { hidden: '' } });
  private picture: FramedPicture | null = null;
  /** The box being dragged, in points on the page (null when not resizing). */
  private dragging: Box | null = null;
  /** How far the picture is being carried by the pointer, CSS pixels. */
  private carried = { x: 0, y: 0 };

  constructor(
    parent: HTMLElement,
    private readonly host: PictureFrameHost,
  ) {
    for (const handle of CORNERS) {
      const el = h('div', { class: 'wm-picture-handle', attrs: { 'data-handle': handle } });
      this.el.append(el);
      el.addEventListener('pointerdown', (e) => this.drag(e, handle));
    }
    parent.append(this.el);
  }

  /** Shows the frame around a picture, or takes it away (null). */
  update(picture: FramedPicture | null): void {
    this.picture = picture;
    this.dragging = null;
    this.carried = { x: 0, y: 0 };
    this.el.hidden = !picture;
    this.position();
  }

  /** The picture is framed. */
  get active(): boolean {
    return this.picture !== null;
  }

  /** The picture is being carried by the pointer this far (CSS pixels): the frame goes along. */
  shift(x: number, y: number): void {
    this.carried = { x, y };
    this.position();
  }

  /** Puts the frame where the picture is now (the view moved, or it is being resized). */
  position(): void {
    const picture = this.picture;
    const page = picture && this.host.page(picture.page);
    if (!picture || !page) {
      this.el.style.display = 'none';
      return;
    }
    const { camera } = this.host;
    const scale = camera.zoom * CSS_PX_PER_POINT;
    const box = this.dragging ?? picture;
    this.el.style.display = '';
    this.el.style.transform = `translate(${(page.x + box.x - camera.x) * scale + this.carried.x}px, ${(page.y + box.y - camera.y) * scale + this.carried.y}px)`;
    this.el.style.width = `${box.width * scale}px`;
    this.el.style.height = `${box.height * scale}px`;
  }

  private drag(e: PointerEvent, handle: Handle): void {
    const picture = this.picture;
    if (!picture || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const scale = this.host.camera.zoom * CSS_PX_PER_POINT;
    const from = { x: e.clientX, y: e.clientY };
    const start: Box = { x: picture.x, y: picture.y, width: picture.width, height: picture.height };
    const move = (m: PointerEvent) => {
      this.dragging = dragBox(start, handle, (m.clientX - from.x) / scale, (m.clientY - from.y) / scale, UNBOUNDED, start.width / start.height, 12);
      this.position();
    };
    const up = (u: Event) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      const box = this.dragging;
      this.dragging = null;
      this.position();
      if (box && u.type === 'pointerup') this.host.resized(box, picture);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }
}
