// A small bar at the top of the view while a picture from a document is being edited in the image editor (the document is
// put away, and comes back with the picture when this says Done), in the look of the bar for a document someone else holds.

import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import './watchBanner.css';

export class PictureDetourBar {
  readonly el = h('div', { class: 'wm-watch', attrs: { role: 'status', hidden: '' } });
  private readonly message = h('span', { class: 'wm-watch-message' });

  constructor(parent: HTMLElement, done: () => void, cancel: () => void) {
    const doneButton = h('button', { class: 'wm-button', text: t('picture.detour.done'), attrs: { type: 'button' } });
    const cancelButton = h('button', { class: 'wm-button', text: t('picture.detour.cancel'), attrs: { type: 'button' } });
    doneButton.addEventListener('click', done);
    cancelButton.addEventListener('click', cancel);
    this.el.append(this.message, doneButton, cancelButton);
    parent.append(this.el);
  }

  /** Shows the bar for a picture from the document called `name`, or takes it away (null). */
  update(name: string | null): void {
    this.el.hidden = name === null;
    if (name !== null) this.message.textContent = t('picture.detour.message', { name });
  }
}
