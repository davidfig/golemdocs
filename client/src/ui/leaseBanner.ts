// A small bar at the top of the view for a document that only one person at a time may edit (a drawing, in a room shared
// with others): it says who is editing, and offers the right to edit to the others. The one who has it is told so only briefly,
// by its being gone: nothing is in the way.

import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import './leaseBanner.css';

export interface LeaseState {
  /** Only one person at a time may edit this document. */
  exclusive: boolean;
  /** This person may edit now. */
  mine: boolean;
  /** The name of whoever may (null: nobody). */
  holder: string | null;
  /** Others are in the room with this person. */
  shared: boolean;
}

export class LeaseBanner {
  readonly el = h('div', { class: 'wm-lease', attrs: { role: 'status', hidden: '' } });
  private readonly message = h('span', { class: 'wm-lease-message' });
  private readonly button = h('button', { class: 'wm-button', attrs: { type: 'button' } });

  constructor(parent: HTMLElement, request: () => void) {
    this.el.append(this.message, this.button);
    this.button.addEventListener('click', request);
    parent.append(this.el);
  }

  update(state: LeaseState): void {
    // Alone, or with the right to edit, there is nothing to say.
    const show = state.exclusive && state.shared && !state.mine;
    this.el.hidden = !show;
    if (!show) return;
    this.message.textContent = state.holder === null ? t('room.leaseFree') : t('room.leaseHeld', { name: state.holder });
    this.button.textContent = state.holder === null ? t('room.leaseEdit') : t('room.leaseTakeOver');
  }
}
