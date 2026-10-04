// A vector drawing shown at the view's zoom: the page of a drawing is a picture of it (see
// formats/vectorDoc.ts), good for thumbnails and for the moment the drawing is opening, and this
// layer paints the drawing itself over that page on a canvas, so it stays sharp however far it is
// zoomed in. Like the other layers, it follows the camera and takes no pointer input; the editor
// (vectorEditor.ts) draws what it needs over the drawing through `decorate`.

import { decodeImage } from '../formats/imageCodec.ts';
import { viewBoxMatrix } from '../vector/geometry.ts';
import { apply, invert } from '../vector/matrix.ts';
import type { Scene } from '../vector/model.ts';
import { loadImages, paintScene } from '../vector/paint.ts';
import type { ImageCache } from '../vector/paint.ts';
import { CSS_PX_PER_POINT, type Camera } from '../view/camera.ts';
import { h } from './dom.ts';
import './vectorLayer.css';

/** Where the drawing is on screen, and the conversions between the screen and its coordinates. */
export interface VectorFrame {
  /** CSS pixels on screen per pixel of the drawing (its width and height, not its view box). */
  scale: number;
  /** The drawing's top-left corner, in CSS pixels from the layer's. */
  left: number;
  top: number;
  /** A point in the drawing's own coordinates (the view box's) as CSS pixels from the layer's top-left. */
  toScreen(x: number, y: number): [number, number];
  /** The reverse. */
  fromScreen(x: number, y: number): [number, number];
  /** CSS pixels on screen per unit of the drawing's own coordinates. */
  unit: number;
}

export interface VectorHost {
  camera: Camera;
  /** The drawing's page: where it is, in points. */
  page(): { x: number; y: number; width: number; height: number } | undefined;
  /** The layer has something new to show (the pictures it was waiting for arrived). */
  changed(): void;
}

export class VectorLayer {
  readonly el = h('div', { class: 'wm-vector', attrs: { hidden: '' } });
  private readonly canvas = h('canvas', { class: 'wm-vector-canvas' });
  private _scene: Scene | null = null;
  private images: ImageCache = new Map();
  /** What was last painted, so a frame where nothing moved costs nothing. */
  private painted = '';
  /** Counts scenes shown, so pictures that arrive for an earlier one are ignored. */
  private version = 0;
  /** Painted over the drawing, in CSS pixels of the layer. */
  decorate: ((ctx: CanvasRenderingContext2D, frame: VectorFrame) => void) | null = null;
  /** Changes whenever what `decorate` paints does. */
  decorationVersion = 0;
  /** The drawing is one inside another document: everything else is dimmed, and the drawing is cut off at its edge. */
  private _focus = false;

  constructor(
    parent: HTMLElement,
    private readonly host: VectorHost,
  ) {
    this.el.append(this.canvas);
    parent.append(this.el);
  }

  get scene(): Scene | null {
    return this._scene;
  }

  get focus(): boolean {
    return this._focus;
  }

  set focus(on: boolean) {
    if (on === this._focus) return;
    this._focus = on;
    this.painted = '';
    this.host.changed();
  }

  /** Whether a point of the screen is outside the drawing's page. */
  outside(clientX: number, clientY: number): boolean {
    const frame = this.frame();
    const scene = this._scene;
    if (!frame || !scene) return true;
    const box = this.el.getBoundingClientRect();
    const x = clientX - box.left - frame.left;
    const y = clientY - box.top - frame.top;
    return x < 0 || y < 0 || x > scene.width * frame.scale || y > scene.height * frame.scale;
  }

  /** The drawing shown; null stops showing one. */
  show(scene: Scene | null): void {
    this._scene = scene;
    this.images = new Map();
    this.painted = '';
    const version = ++this.version;
    this.el.hidden = !scene;
    if (!scene) return;
    void loadImages(scene, (bytes) => decodeImage(bytes)).then((images) => {
      if (version !== this.version) return;
      this.images = images;
      this.painted = '';
      this.host.changed();
    });
  }

  /** The drawing changed (the editor's own copy of it): painted again, with the pictures it already has. */
  update(scene: Scene): void {
    this._scene = scene;
    this.painted = '';
    this.host.changed();
  }

  /** Asks for the layer to be painted again, as it is. */
  invalidate(): void {
    this.painted = '';
    this.host.changed();
  }

  /** Where the drawing is on screen; null when there is none or no page to put it on. */
  frame(): VectorFrame | null {
    const scene = this._scene;
    const page = this.host.page();
    if (!scene || !page) return null;
    const { camera } = this.host;
    const perPoint = camera.zoom * CSS_PX_PER_POINT;
    const scale = (page.width * perPoint) / scene.width;
    const left = (page.x - camera.x) * perPoint;
    const top = (page.y - camera.y) * perPoint;
    const vb = viewBoxMatrix(scene);
    const back = invert(vb) ?? vb;
    return {
      scale,
      left,
      top,
      unit: scale * Math.sqrt(Math.abs(vb[0] * vb[3] - vb[1] * vb[2])),
      toScreen: (x, y) => {
        const [px, py] = apply(vb, x, y);
        return [left + px * scale, top + py * scale];
      },
      fromScreen: (x, y) => apply(back, (x - left) / scale, (y - top) / scale),
    };
  }

  /** Paints the drawing where the view has its page (the view moved, or the drawing changed). */
  position(): void {
    const { scene } = this;
    const frame = this.frame();
    const page = this.host.page();
    if (!scene || !frame || !page) return;
    const { camera } = this.host;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.el.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.el.clientHeight * ratio));
    const key = [camera.x, camera.y, camera.zoom, width, height, page.x, page.y, page.width, page.height, this._focus, this.decorationVersion].join();
    if (key === this.painted) return;
    this.painted = key;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (this._focus) {
      // Everything but the drawing is dimmed (the document shows through, darker).
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      ctx.rect(ratio * frame.left, ratio * frame.top, ratio * frame.scale * scene.width, ratio * frame.scale * scene.height);
      ctx.fill('evenodd');
    }
    ctx.setTransform(ratio * frame.scale, 0, 0, ratio * frame.scale, ratio * frame.left, ratio * frame.top);
    // The page is white under the drawing, and covers the picture of it.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, scene.width, scene.height);
    ctx.save();
    if (this._focus) {
      ctx.beginPath();
      ctx.rect(0, 0, scene.width, scene.height);
      ctx.clip();
    }
    paintScene(ctx, scene, scene.width, scene.height, { images: this.images });
    ctx.restore();
    if (this.decorate) {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      this.decorate(ctx, frame);
    }
  }
}
