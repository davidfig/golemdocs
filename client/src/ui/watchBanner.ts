// A small bar at the top of the view for a document edited by one person at a time (a PDF or a picture: see ROOM_POLICY in
// @golemdocs/ops), shown while someone else holds it: it says who (or that it is this person's other device), that their changes
// appear each time they save, and offers to take it over. Holding it, or alone, there is nothing to say.

import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import './watchBanner.css';

export interface WatchState {
  /** Someone else holds the document. */
  watching: boolean;
  /** Who: their name, and whether it is this person's own account (another device). */
  holder: { name: string; mine: boolean } | null;
  /** This person may edit it, and so take it over (not a viewer). */
  canTakeOver: boolean;
}

export class WatchBanner {
  readonly el = h('div', { class: 'wm-watch', attrs: { role: 'status', hidden: '' } });
  private readonly message = h('span', { class: 'wm-watch-message' });
  private readonly button = h('button', { class: 'wm-button', text: t('room.takeOver'), attrs: { type: 'button' } });

  constructor(parent: HTMLElement, takeOver: () => void) {
    this.el.append(this.message, this.button);
    this.button.addEventListener('click', takeOver);
    parent.append(this.el);
  }

  update(state: WatchState): void {
    const show = state.watching && state.holder !== null;
    this.el.hidden = !show;
    if (!show) return;
    this.message.textContent = state.holder!.mine ? t('room.watchingMine') : t('room.watching', { name: state.holder!.name });
    this.button.hidden = !state.canTakeOver;
  }
}
