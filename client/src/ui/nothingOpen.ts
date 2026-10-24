// What the editor shows once its document is closed (File › Close): no document, only a way to make
// one or open one. It covers the editor, as the loading screen does, so nothing of the closed
// document shows and nothing behind it can be clicked or typed into.

import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import './nothingOpen.css';

export class NothingOpenScreen {
  private readonly root: HTMLElement;
  private readonly message: HTMLElement;
  private readonly newButton: HTMLButtonElement;
  private readonly openButton: HTMLButtonElement;

  constructor(parent: HTMLElement, actions: { newDocument(): void; open(): void }) {
    this.message = h('div', { class: 'wm-nothing-open-message' });
    this.newButton = h('button', { class: 'wm-button wm-primary', attrs: { type: 'button' } });
    this.openButton = h('button', { class: 'wm-button', attrs: { type: 'button' } });
    this.newButton.addEventListener('click', () => actions.newDocument());
    this.openButton.addEventListener('click', () => actions.open());
    this.root = h('div', { class: 'wm-nothing-open' }, h('div', { class: 'wm-nothing-open-box' }, this.message, h('div', { class: 'wm-nothing-open-buttons' }, this.newButton, this.openButton)));
    this.root.hidden = true;
    parent.append(this.root);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  show(): void {
    // Set here rather than once, so a change of language shows.
    this.message.textContent = t('app.nothingOpen');
    this.newButton.textContent = t('app.nothingOpenNew');
    this.openButton.textContent = t('app.nothingOpenOpen');
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }
}
