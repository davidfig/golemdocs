// A chart's title, typed into a card drawn over the sheet beside the chart (not a modal dialog), built from the same parts
// as every dialog. Enter or OK keeps it (an empty title takes it off); Escape, Cancel and a press elsewhere drop it.

import { t } from '../i18n/index.ts';
import { h } from '../ui/dom.ts';
import { dialogTitleBar } from '../ui/popup.ts';

export class ChartTitleCard {
  private readonly root: HTMLDivElement;
  private readonly input = h('input', { class: 'wm-input', attrs: { type: 'text', 'aria-label': t('sheet.chart.titleLabel'), autocomplete: 'off' } });
  private done: ((title: string | undefined) => void) | null = null;

  constructor() {
    const ok = h('button', { class: 'wm-button wm-primary', text: t('sheet.chart.ok'), attrs: { type: 'button' } });
    const cancel = h('button', { class: 'wm-button', text: t('sheet.chart.cancel'), attrs: { type: 'button' } });
    this.root = h(
      'div',
      { class: 'wm-dialog wm-over wm-link', attrs: { role: 'dialog', 'aria-label': t('sheet.chart.editTitle') } },
      dialogTitleBar(t('sheet.chart.editTitle'), () => this.end(undefined)),
      h('div', { class: 'wm-dialog-body wm-link-body' }, h('label', { text: t('sheet.chart.titleLabel') }), this.input),
      h('div', { class: 'wm-dialog-buttons' }, ok, cancel),
    );
    this.root.hidden = true;
    ok.addEventListener('click', () => this.end(this.input.value));
    cancel.addEventListener('click', () => this.end(undefined));
    // Keys stay in the card: the sheet's handlers listen on the window.
    this.root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        this.end(this.input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.end(undefined);
      }
    });
    document.addEventListener('pointerdown', (e) => !this.root.hidden && !this.root.contains(e.target as Node) && this.end(undefined), true);
    document.body.append(this.root);
  }

  /** Opens at a window point with the title ready to change; resolves with the title typed, or `undefined` if cancelled. */
  edit(title: string, clientX: number, clientY: number): Promise<string | undefined> {
    this.end(undefined);
    this.input.value = title;
    this.root.hidden = false;
    const box = this.root.getBoundingClientRect();
    this.root.style.left = `${Math.max(4, Math.min(clientX, window.innerWidth - box.width - 4))}px`;
    this.root.style.top = `${Math.max(4, Math.min(clientY, window.innerHeight - box.height - 4))}px`;
    this.input.focus();
    this.input.select();
    return new Promise((resolve) => (this.done = resolve));
  }

  private end(title: string | undefined): void {
    const done = this.done;
    this.done = null;
    this.root.hidden = true;
    done?.(title);
  }
}
