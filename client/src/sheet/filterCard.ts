// The AutoFilter's card, drawn over the sheet below a column's button (not a modal dialog): sort the filter's rows by the
// column, or tick the values to show. Built from the same parts as every dialog (title bar, body, buttons). Escape, Cancel
// and a press elsewhere close it.

import { t } from '../i18n/index.ts';
import { h } from '../ui/dom.ts';
import { dialogTitleBar } from '../ui/popup.ts';

export interface FilterChoice {
  /** The values to show (null: all of them). */
  values: string[] | null;
  blanks: boolean;
}

export interface FilterCardRequest {
  values: string[];
  /** Some cells of the column are empty. */
  blanks: boolean;
  /** What the column shows now (null: everything). */
  shown: string[] | null;
  shownBlanks: boolean;
  /** Where to put the card (window point under the button). */
  clientX: number;
  clientY: number;
  sort(descending: boolean): void;
  apply(choice: FilterChoice): void;
}

export class FilterCard {
  private readonly root: HTMLDivElement;
  private readonly list = h('div', { class: 'wm-sheet-filter-list', attrs: { role: 'group' } });
  private request: FilterCardRequest | null = null;
  private boxes: { value: string | null; box: HTMLInputElement; label: HTMLElement }[] = [];
  private all!: HTMLInputElement;

  constructor() {
    const ascending = h('button', { class: 'wm-button', text: t('sheet.op.sortAscending'), attrs: { type: 'button' } });
    const descending = h('button', { class: 'wm-button', text: t('sheet.op.sortDescending'), attrs: { type: 'button' } });
    const ok = h('button', { class: 'wm-button', text: t('sheet.filter.ok'), attrs: { type: 'button' } });
    const cancel = h('button', { class: 'wm-button', text: t('sheet.filter.cancel'), attrs: { type: 'button' } });
    this.root = h(
      'div',
      { class: 'wm-dialog wm-over wm-sheet-filter', attrs: { role: 'dialog', 'aria-label': t('sheet.op.filter') } },
      dialogTitleBar(t('sheet.op.filter'), () => this.hide()),
      h('div', { class: 'wm-dialog-body wm-sheet-filter-body' }, h('div', { class: 'wm-sheet-filter-sort' }, ascending, descending), this.list),
      h('div', { class: 'wm-dialog-buttons' }, ok, cancel),
    );
    this.root.hidden = true;
    ascending.addEventListener('click', () => this.sort(false));
    descending.addEventListener('click', () => this.sort(true));
    ok.addEventListener('click', () => this.ok());
    cancel.addEventListener('click', () => this.hide());
    this.root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hide();
      } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') {
        e.preventDefault();
        this.ok();
      }
    });
    document.addEventListener('pointerdown', (e) => !this.root.hidden && !this.root.contains(e.target as Node) && this.hide(), true);
    document.body.append(this.root);
  }

  get shown(): boolean {
    return !this.root.hidden;
  }

  show(request: FilterCardRequest): void {
    this.request = request;
    const shown = request.shown && new Set(request.shown.map((v) => v.toLowerCase()));
    const row = (label: string, checked: boolean) => {
      const box = h('input', { attrs: { type: 'checkbox' } });
      box.checked = checked;
      return { box, label: h('label', { class: 'wm-sheet-check' }, box, h('span', { text: label })) };
    };
    const all = row(t('sheet.filter.selectAll'), !request.shown);
    this.all = all.box;
    this.boxes = request.values.map((value) => ({ value, ...row(value, !shown || shown.has(value.toLowerCase())) }));
    if (request.blanks) this.boxes.push({ value: null, ...row(t('sheet.filter.blanks'), !request.shown || request.shownBlanks) });
    this.list.replaceChildren(all.label, ...this.boxes.map((b) => b.label));
    this.all.addEventListener('change', () => this.boxes.forEach((b) => (b.box.checked = this.all.checked)));
    for (const b of this.boxes) b.box.addEventListener('change', () => (this.all.checked = this.boxes.every((x) => x.box.checked)));
    this.root.hidden = false;
    const box = this.root.getBoundingClientRect();
    this.root.style.left = `${Math.max(4, Math.min(request.clientX - box.width + 16, window.innerWidth - box.width - 4))}px`;
    this.root.style.top = `${Math.max(4, Math.min(request.clientY + 2, window.innerHeight - box.height - 4))}px`;
    this.all.focus();
  }

  hide(): void {
    this.root.hidden = true;
    this.request = null;
  }

  private sort(descending: boolean): void {
    const request = this.request;
    this.hide();
    request?.sort(descending);
  }

  private ok(): void {
    const request = this.request;
    if (!request) return;
    const every = this.boxes.every((b) => b.box.checked);
    const values = this.boxes.filter((b) => b.box.checked && b.value !== null).map((b) => b.value!);
    const blanks = this.boxes.some((b) => b.value === null && b.box.checked);
    this.hide();
    request.apply(every ? { values: null, blanks: true } : { values, blanks });
  }
}
