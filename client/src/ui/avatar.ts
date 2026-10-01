// A person's picture in a circle, with their initial under it: the initial is what shows for
// someone with no picture, and while the picture loads or if it can't (it is another site's image).

import { h } from './dom.ts';

/** `size` is the diameter in CSS pixels. */
export function avatar(picture: string | null | undefined, name: string | null | undefined, size: number): HTMLElement {
  const el = h('span', { class: 'wm-avatar', text: [...(name?.trim() ?? '')][0]?.toUpperCase() ?? '', attrs: { 'aria-hidden': 'true' } });
  el.style.setProperty('--wm-avatar', `${size}px`);
  if (picture) {
    // No referrer, so the picture's host isn't told which document the person is looking at.
    const img = h('img', { attrs: { src: picture, alt: '', referrerpolicy: 'no-referrer', draggable: 'false' } });
    img.addEventListener('error', () => img.remove());
    el.append(img);
  }
  return el;
}
