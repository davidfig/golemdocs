// Other people's mouse pointers, over the document: an arrow in their color with their name, kept
// in place as the view scrolls and zooms. HTML over the canvas, like the form layer; the pointers
// come from the room (see ops multiplayer.ts) as a page's position in display order and a point on it.

import { CSS_PX_PER_POINT, type Camera } from '../view/camera.ts';
import { avatar } from './avatar.ts';
import { h } from './dom.ts';
import './pointerLayer.css';

export interface PointerPage {
  readonly x: number;
  readonly y: number;
}

export interface PointerLayerHost {
  camera: Camera;
  /** The page at this position in display order, if it has been laid out. */
  page(index: number): PointerPage | undefined;
}

export interface RemotePointer {
  page: number;
  x: number;
  y: number;
  color: number;
  name: string;
  /** Their profile picture, shown beside the name (null: just the name). */
  picture: string | null;
}

const css = (color: number) => `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;

export class PointerLayer {
  readonly el = h('div', { class: 'wm-pointers', attrs: { 'aria-hidden': 'true' } });
  private pointers: RemotePointer[] = [];
  /** One element per person, reused while they stay (keyed by position in the list, then name). */
  private readonly elements: HTMLElement[] = [];

  constructor(
    parent: HTMLElement,
    private readonly host: PointerLayerHost,
  ) {
    parent.append(this.el);
  }

  update(pointers: RemotePointer[]): void {
    this.pointers = pointers;
    while (this.elements.length < pointers.length) {
      const el = h('div', { class: 'wm-pointer' });
      el.innerHTML = '<svg width="16" height="20" viewBox="0 0 16 20"><path d="M1 1 L1 15 L5 11.5 L8 18 L10.5 17 L7.6 10.6 L13 10.6 Z" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>';
      el.append(h('span', { class: 'wm-pointer-name' }));
      this.el.append(el);
      this.elements.push(el);
    }
    this.elements.forEach((el, i) => {
      const p = pointers[i];
      el.hidden = !p;
      if (!p) return;
      el.style.setProperty('--wm-pointer', css(p.color));
      const label = el.lastElementChild as HTMLElement;
      // Rebuilt only when the person changes, so the picture isn't fetched again on every mouse move.
      const who = `${p.name}\n${p.picture ?? ''}`;
      if (label.dataset.who !== who) {
        label.dataset.who = who;
        label.replaceChildren(...(p.picture ? [avatar(p.picture, p.name, 14)] : []), h('span', { text: p.name }));
      }
    });
    this.position();
  }

  /** Puts each pointer where it is now (the view moved). */
  position(): void {
    const { camera } = this.host;
    const scale = camera.zoom * CSS_PX_PER_POINT;
    this.pointers.forEach((p, i) => {
      const el = this.elements[i];
      const page = this.host.page(p.page);
      if (!el) return;
      if (!page) {
        el.style.display = 'none';
        return;
      }
      el.style.display = '';
      el.style.transform = `translate(${(page.x + p.x - camera.x) * scale}px, ${(page.y + p.y - camera.y) * scale}px)`;
    });
  }
}
