// A screen over the editor while a document is being opened, so the document that was open before
// never shows through: it says which file is loading and how far along it is.

import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import './loadingScreen.css';

export class LoadingScreen {
  private readonly root: HTMLElement;
  private readonly name: HTMLElement;
  private readonly detail: HTMLElement;

  constructor(parent: HTMLElement) {
    this.name = h('div', { class: 'wm-loading-name' });
    this.detail = h('div', { class: 'wm-loading-detail' });
    this.root = h('div', { class: 'wm-loading', attrs: { role: 'status', 'aria-live': 'polite' } }, h('div', { class: 'wm-loading-box' }, h('div', { class: 'wm-loading-spinner', attrs: { 'aria-hidden': 'true' } }), this.name, this.detail));
    this.root.hidden = true;
    parent.append(this.root);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  /**
   * Covers the editor, saying that `name` is being opened. Its box shows after a moment, so a quick load just looks like the document
   * arriving; `now` shows it at once, for a load that has already kept the person waiting (the viewer's page downloaded the file first).
   */
  show(name: string, now = false): void {
    this.name.textContent = name;
    this.detail.textContent = t('app.loading', { name });
    this.root.classList.toggle('wm-loading-now', now);
    this.root.hidden = false;
  }

  /** What is happening now (reading, laying out…). */
  update(text: string): void {
    if (this.visible) this.detail.textContent = text;
  }

  hide(): void {
    this.root.hidden = true;
  }
}
