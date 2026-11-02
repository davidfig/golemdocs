// The handles at the two ends of a selection made with a finger: a bar the height of the line with a knob on it (above the
// start, below the end), kept in place as the view scrolls and zooms. A finger that lands on one drags that end of the
// selection (main.ts, touchDown); the handles only show, they never take the pointer themselves.

import { CSS_PX_PER_POINT, type Camera } from '../view/camera.ts';
import { h } from './dom.ts';

export interface HandlePage {
  readonly x: number;
  readonly y: number;
}

export interface SelectionHandlesHost {
  camera: Camera;
  /** The page with this id, if it has been laid out. */
  page(id: number): HandlePage | undefined;
  /** Where the page with this id is in reading order. */
  order(id: number): number;
}

export type HandleEnd = 'start' | 'end';

/** One end of the selection: a page, the x of the edge and the line it is on (page points). */
interface End {
  page: number;
  x: number;
  y: number;
  height: number;
}

/** How near a finger must come to a handle (CSS pixels) to take it. */
const GRAB_PX = 28;

export class SelectionHandles {
  readonly el = h('div', { class: 'wm-sel-handles', attrs: { 'aria-hidden': 'true' } });
  private readonly start = h('div', { class: 'wm-sel-handle start' });
  private readonly end = h('div', { class: 'wm-sel-handle end' });
  private ends: { start: End; end: End } | null = null;

  constructor(
    parent: HTMLElement,
    private readonly host: SelectionHandlesHost,
  ) {
    this.el.append(this.start, this.end);
    this.el.hidden = true;
    parent.append(this.el);
  }

  /** The selection's highlight (page id, x, y, width, height per rectangle); `show` false (or nothing selected) hides the handles. */
  update(rects: Float64Array, show: boolean): void {
    this.ends = show && rects.length >= 5 ? ends(rects, (id) => this.host.order(id)) : null;
    this.el.hidden = !this.ends;
    this.position();
  }

  get shown(): boolean {
    return this.ends !== null;
  }

  /** Puts the handles where the ends are now (the view moved). */
  position(): void {
    if (!this.ends) return;
    this.place(this.start, this.ends.start);
    this.place(this.end, this.ends.end);
  }

  /** The handle a finger at this canvas point (CSS pixels) takes, if it is near one: the nearer of the two. */
  hit(x: number, y: number): HandleEnd | null {
    if (!this.ends) return null;
    let best: HandleEnd | null = null;
    let bestDistance = GRAB_PX;
    for (const which of ['start', 'end'] as const) {
      const r = this.box(this.ends[which]);
      if (!r) continue;
      // The bar and its knob, which sits off the line: above it at the start, below it at the end.
      const top = which === 'start' ? r.y - KNOB_PX : r.y;
      const bottom = which === 'end' ? r.y + r.height + KNOB_PX : r.y + r.height;
      const dx = Math.abs(x - r.x);
      const dy = y < top ? top - y : y > bottom ? y - bottom : 0;
      const distance = Math.hypot(dx, dy);
      if (distance < bestDistance) {
        best = which;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** The middle of the line at an end, in canvas CSS pixels: where the text at that end is. */
  point(which: HandleEnd): { x: number; y: number } | null {
    const r = this.ends && this.box(this.ends[which]);
    return r ? { x: r.x, y: r.y + r.height / 2 } : null;
  }

  private box(end: End): { x: number; y: number; height: number } | null {
    const { camera } = this.host;
    const page = this.host.page(end.page);
    if (!page) return null;
    const scale = camera.zoom * CSS_PX_PER_POINT;
    return { x: (page.x + end.x - camera.x) * scale, y: (page.y + end.y - camera.y) * scale, height: end.height * scale };
  }

  private place(el: HTMLElement, end: End): void {
    const r = this.box(end);
    el.hidden = !r;
    if (!r) return;
    el.style.transform = `translate(${r.x}px, ${r.y}px)`;
    el.style.height = `${r.height}px`;
  }
}

/** The knob's size, in CSS pixels (ui.css). */
const KNOB_PX = 12;

/** The first and last edges of a highlight, in reading order (pages, then lines down the page, then left to right). */
export function ends(rects: Float64Array, order: (page: number) => number): { start: End; end: End } {
  // Compares the place of two rectangles' edges: [page, line top, x].
  const compare = (a: number[], b: number[]): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const left = (i: number) => [order(rects[i]), rects[i + 2], rects[i + 1]];
  const right = (i: number) => [order(rects[i]), rects[i + 2], rects[i + 1] + rects[i + 3]];
  let start = 0;
  let end = 0;
  for (let i = 5; i < rects.length; i += 5) {
    if (compare(left(i), left(start)) < 0) start = i;
    if (compare(right(i), right(end)) > 0) end = i;
  }
  return {
    start: { page: rects[start], x: rects[start + 1], y: rects[start + 2], height: rects[start + 4] },
    end: { page: rects[end], x: rects[end + 1] + rects[end + 3], y: rects[end + 2], height: rects[end + 4] },
  };
}
