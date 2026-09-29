// A PDF's form fields, over its pages. The pages don't draw fields; this layer does, as HTML over
// the canvas, kept in place as the view scrolls and zooms. It has two modes:
//
//   fill: the fields are inputs: type in text boxes, tick check boxes and radio buttons, pick
//         from drop-downs.
//   edit: the fields are boxes to arrange: drag to move, drag the corner to resize, rename or
//         delete the selected one, and add text boxes, check boxes and drop-downs.
//
// Every change goes to the layout worker as the whole list of fields (see pdfAnnotator.ts), which
// keeps it with the document, puts it in the undo history and writes it into an exported PDF.

import { t } from '../i18n/index.ts';
import type { WireField } from '../layout/protocol.ts';
import { CSS_PX_PER_POINT, type Camera } from '../view/camera.ts';
import type { FormMode } from './actions.ts';
import { h } from './dom.ts';
import './formLayer.css';

export interface FormPage {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FormLayerHost {
  camera: Camera;
  canvas: HTMLCanvasElement;
  page(id: number): FormPage | undefined;
  /** The page under a point of the view (CSS px), and the point on it (points). */
  pageAt(cssX: number, cssY: number): { page: FormPage; x: number; y: number } | null;
  /** The fields are now these. Changes with the same `merge` key undo together. */
  change(fields: WireField[], merge?: string): void;
  notify(message: string): void;
}

type Box = WireField['box'];
type NewKind = 'text' | 'checkbox' | 'choice';

/** New fields' size, points. */
const NEW_SIZE: Record<NewKind, [number, number]> = { text: [160, 20], checkbox: [12, 12], choice: [120, 20] };
/** The start of a new field's name ("Text1", "Text2"...). */
const newName = (kind: NewKind): string => t(kind === 'text' ? 'panels.forms.newText' : kind === 'checkbox' ? 'panels.forms.newCheckbox' : 'panels.forms.newChoice');
/** Smallest box a field can be resized to, points. */
const MIN_SIZE = 6;

export class FormLayer {
  readonly el = h('div', { class: 'wm-forms' });
  private readonly palette: HTMLElement;
  private readonly properties = h('div', { class: 'wm-forms-properties' });
  private mode: FormMode = 'fill';
  /** The fields, or null when the document isn't a PDF shown as its pages. */
  private fields: WireField[] | null = null;
  private readonly elements = new Map<string, HTMLElement>();
  /** Edit mode: the selected field. */
  private selected: string | null = null;
  /** Edit mode: a field kind to place with the next click on a page. */
  private placing: NewKind | null = null;
  private readonly catcher = h('div', { class: 'wm-forms-catcher' });
  /** A move or resize in progress: its field's box so far. */
  private dragging: { id: string; box: Box } | null = null;
  private nextId = 1;

  constructor(
    parent: HTMLElement,
    private readonly host: FormLayerHost,
  ) {
    this.palette = this.buildPalette();
    this.el.append(this.catcher);
    parent.append(this.el, this.palette);
    this.el.hidden = this.palette.hidden = true;
    // Scrolling over a field scrolls the document.
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      host.canvas.dispatchEvent(new WheelEvent('wheel', e));
    }, { passive: false });
    this.catcher.addEventListener('pointerdown', (e) => this.place(e));
    host.canvas.addEventListener('pointerdown', () => {
      if (this.mode === 'edit' && this.selected) this.select(null);
    });
    window.addEventListener('keydown', (e) => this.key(e), true);
  }

  /** Shows these fields (null: none, the document isn't a PDF's pages). */
  update(fields: readonly WireField[] | null): void {
    if (this.dragging) return; // the drag's end sends its own list
    this.fields = fields ? [...fields] : null;
    if (this.selected && !this.fields?.some((f) => f.id === this.selected)) this.selected = null;
    if (!this.fields) this.placing = null;
    this.render();
  }

  setMode(mode: FormMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.selected = null;
    this.placing = null;
    for (const el of this.elements.values()) el.remove();
    this.elements.clear();
    this.render();
  }

  /** Keeps the fields over their pages (call on every frame the view may have moved). */
  position(): void {
    if (!this.fields) return;
    const scale = this.host.camera.zoom * CSS_PX_PER_POINT;
    for (const field of this.fields) {
      const el = this.elements.get(field.id);
      if (!el) continue;
      const page = this.host.page(field.pageId);
      if (!page) {
        el.style.display = 'none';
        continue;
      }
      const box = this.dragging?.id === field.id ? this.dragging.box : field.box;
      const left = (page.x + box.x - this.host.camera.x) * scale;
      const top = (page.y + box.y - this.host.camera.y) * scale;
      el.style.display = '';
      el.style.transform = `translate(${left}px, ${top}px)`;
      el.style.width = `${box.width * scale}px`;
      el.style.height = `${box.height * scale}px`;
      el.style.fontSize = `${fontSize(field, box) * scale}px`;
    }
  }

  // --- Drawing ------------------------------------------------------------------------------

  private render(): void {
    const on = this.fields !== null;
    this.el.hidden = !on;
    this.palette.hidden = !on || this.mode !== 'edit';
    this.el.classList.toggle('wm-forms-edit', this.mode === 'edit');
    this.catcher.hidden = !this.placing;
    this.palette.classList.toggle('wm-forms-placing', this.placing !== null);
    const fields = this.fields ?? [];
    const keep = new Set(fields.map((f) => f.id));
    for (const [id, el] of this.elements) {
      if (keep.has(id)) continue;
      el.remove();
      this.elements.delete(id);
    }
    for (const field of fields) {
      let el = this.elements.get(field.id);
      if (!el || el.dataset.kind !== this.kindKey(field)) {
        const made = this.mode === 'edit' ? this.editBox(field) : this.input(field);
        made.dataset.kind = this.kindKey(field);
        if (el) el.replaceWith(made);
        else this.el.append(made);
        this.elements.set(field.id, made);
        el = made;
      }
      if (this.mode === 'edit') this.syncEditBox(el, field);
      else this.syncInput(el, field);
    }
    // Tab order follows the list.
    let previous: Element = this.catcher;
    for (const field of fields) {
      const el = this.elements.get(field.id)!;
      if (previous.nextElementSibling !== el) previous.after(el);
      previous = el;
    }
    this.syncProperties();
    this.position();
  }

  /** What decides an element's shape: rebuilt when it changes. */
  private kindKey(f: WireField): string {
    return `${this.mode}:${f.kind}:${f.multiline ? 'm' : ''}`;
  }

  // --- Fill mode ----------------------------------------------------------------------------

  private input(field: WireField): HTMLElement {
    const id = field.id;
    if (field.kind === 'checkbox' || field.kind === 'radio') {
      const el = h('button', { class: `wm-field wm-field-${field.kind}`, attrs: { type: 'button', role: field.kind } });
      el.addEventListener('click', () => {
        const f = this.field(id);
        if (!f || f.readOnly || !f.onState) return;
        const on = f.value === f.onState;
        // A radio button stays on when clicked again; a check box turns off.
        this.setValue(f, f.kind === 'radio' ? f.onState : on ? '' : f.onState);
      });
      return el;
    }
    if (field.kind === 'choice') {
      const el = h('select', { class: 'wm-field wm-field-choice' });
      el.addEventListener('change', () => {
        const f = this.field(id);
        if (f) this.setValue(f, el.value);
      });
      return el;
    }
    const el = field.multiline ? h('textarea', { class: 'wm-field wm-field-text' }) : h('input', { class: 'wm-field wm-field-text', attrs: { type: 'text' } });
    el.spellcheck = false;
    el.addEventListener('input', () => {
      const f = this.field(id);
      if (f) this.setValue(f, el.value, `value:${f.name}`);
    });
    return el;
  }

  private syncInput(el: HTMLElement, field: WireField): void {
    el.title = field.name;
    el.setAttribute('aria-label', field.name);
    if (el instanceof HTMLButtonElement) {
      const on = !!field.onState && field.value === field.onState;
      el.setAttribute('aria-checked', String(on));
      el.textContent = on ? (field.kind === 'radio' ? '●' : '✓') : '';
      el.disabled = !!field.readOnly;
    } else if (el instanceof HTMLSelectElement) {
      const options = field.options ?? [];
      const list = options.some((o) => o.value === field.value) || !field.value ? options : [{ value: field.value, label: field.value }, ...options];
      const key = JSON.stringify(list);
      if (el.dataset.options !== key) {
        el.dataset.options = key;
        el.replaceChildren(h('option', { text: '', attrs: { value: '' } }), ...list.map((o) => h('option', { text: o.label, attrs: { value: o.value } })));
      }
      if (el.value !== field.value) el.value = field.value;
      el.disabled = !!field.readOnly;
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      // Leave what's being typed alone: the worker's copy may be a keystroke behind.
      if (document.activeElement !== el && el.value !== field.value) el.value = field.value;
      el.readOnly = !!field.readOnly;
      if (field.maxLength) el.maxLength = field.maxLength;
      else el.removeAttribute('maxlength');
    }
  }

  /** Sets a field's value, shared by every widget with its name. */
  private setValue(field: WireField, value: string, merge?: string): void {
    if (!this.fields) return;
    this.fields = this.fields.map((f) => (f.name === field.name ? { ...f, value } : f));
    this.host.change(this.fields, merge);
    this.render();
  }

  // --- Edit mode ----------------------------------------------------------------------------

  private editBox(field: WireField): HTMLElement {
    const id = field.id;
    const handle = h('span', { class: 'wm-field-handle' });
    const el = h('div', { class: `wm-field-box wm-field-box-${field.kind}` }, h('span', { class: 'wm-field-name' }), handle);
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.select(id);
      this.drag(e, id, e.target === handle ? 'resize' : 'move');
    });
    el.addEventListener('dblclick', () => {
      const input = this.properties.querySelector<HTMLInputElement>('.wm-forms-name');
      input?.focus();
      input?.select();
    });
    return el;
  }

  private syncEditBox(el: HTMLElement, field: WireField): void {
    el.classList.toggle('wm-field-selected', field.id === this.selected);
    const label = el.querySelector('.wm-field-name')!;
    const text = field.kind === 'radio' ? `${field.name} (${field.onState})` : field.name;
    if (label.textContent !== text) label.textContent = text;
    el.title = t('panels.forms.fieldTitle', { kind: kindLabel(field.kind), name: field.name });
  }

  /** Moves or resizes a field with the pointer; sent when the pointer is released. */
  private drag(start: PointerEvent, id: string, how: 'move' | 'resize'): void {
    const field = this.field(id);
    if (!field) return;
    const target = start.currentTarget as HTMLElement;
    target.setPointerCapture(start.pointerId);
    const scale = this.host.camera.zoom * CSS_PX_PER_POINT;
    const from = field.box;
    this.dragging = { id, box: { ...from } };
    const page = this.host.page(field.pageId);
    const move = (e: PointerEvent) => {
      const dx = (e.clientX - start.clientX) / scale;
      const dy = (e.clientY - start.clientY) / scale;
      let box: Box;
      if (how === 'move') box = { ...from, x: from.x + dx, y: from.y + dy };
      else box = { ...from, width: Math.max(MIN_SIZE, from.width + dx), height: Math.max(MIN_SIZE, from.height + dy) };
      // Keep it on its page.
      if (page) {
        box.width = Math.min(box.width, page.width);
        box.height = Math.min(box.height, page.height);
        box.x = Math.min(Math.max(box.x, 0), page.width - box.width);
        box.y = Math.min(Math.max(box.y, 0), page.height - box.height);
      }
      this.dragging = { id, box };
      this.position();
    };
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      const box = this.dragging?.box;
      this.dragging = null;
      if (box && (box.x !== from.x || box.y !== from.y || box.width !== from.width || box.height !== from.height)) this.replaceField(id, { box });
      else this.position();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }

  private select(id: string | null): void {
    if (this.selected === id) return;
    this.selected = id;
    this.render();
  }

  private replaceField(id: string, change: Partial<WireField>, merge?: string): void {
    if (!this.fields) return;
    this.fields = this.fields.map((f) => (f.id === id ? { ...f, ...change } : f));
    this.host.change(this.fields, merge);
    this.render();
  }

  private remove(id: string): void {
    if (!this.fields) return;
    this.fields = this.fields.filter((f) => f.id !== id);
    if (this.selected === id) this.selected = null;
    this.host.change(this.fields);
    this.render();
  }

  private buildPalette(): HTMLElement {
    const add = (kind: NewKind, label: string) => {
      const button = h('button', { class: 'wm-forms-add', text: label, attrs: { type: 'button', 'data-kind': kind } });
      button.addEventListener('click', () => {
        this.placing = this.placing === kind ? null : kind;
        this.render();
      });
      return button;
    };
    const hint = h('p', { class: 'wm-forms-hint', text: t('panels.forms.dragHint') });
    return h(
      'aside',
      { class: 'wm-forms-palette', attrs: { 'aria-label': t('panels.forms.editForm') } },
      h('h2', { text: t('panels.forms.editForm') }),
      h('div', { class: 'wm-forms-adds' }, add('text', kindLabel('text')), add('checkbox', kindLabel('checkbox')), add('choice', kindLabel('choice'))),
      hint,
      this.properties,
    );
  }

  /** The selected field's name and settings, in the palette. */
  private syncProperties(): void {
    const field = this.selected ? this.field(this.selected) : undefined;
    const key = field ? JSON.stringify([field.id, field.name, field.kind, field.multiline, field.options]) : '';
    if (this.properties.dataset.key === key && this.properties.contains(document.activeElement)) return;
    this.properties.dataset.key = key;
    if (this.placing) {
      this.properties.replaceChildren(h('p', { class: 'wm-forms-hint', text: t(`panels.forms.place.${this.placing}` as const) }));
      return;
    }
    if (!field) {
      this.properties.replaceChildren(h('p', { class: 'wm-forms-hint', text: this.fields?.length ? t('panels.forms.selectHint') : t('panels.forms.noFields') }));
      return;
    }
    const id = field.id;
    const name = h('input', { class: 'wm-forms-name', attrs: { type: 'text', 'aria-label': t('panels.forms.fieldName') } });
    name.value = field.name;
    name.spellcheck = false;
    const rename = () => {
      const f = this.field(id);
      const next = name.value.trim();
      if (!f || next === f.name) return;
      if (!next) {
        name.value = f.name;
        return;
      }
      if (this.fields!.some((o) => o.name === next && o.name !== f.name)) {
        this.host.notify(`There's already a field named “${next}”`);
        name.value = f.name;
        return;
      }
      // Every widget of the field takes the new name.
      this.fields = this.fields!.map((o) => (o.name === f.name ? { ...o, name: next } : o));
      this.host.change(this.fields);
      this.render();
    };
    name.addEventListener('change', rename);
    name.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') name.blur();
      if (e.key === 'Escape') {
        name.value = this.field(id)?.name ?? '';
        name.blur();
      }
    });
    const rows: HTMLElement[] = [h('label', { class: 'wm-forms-row' }, h('span', { text: t('panels.forms.name') }), name)];
    if (field.kind === 'text') {
      const multi = h('input', { attrs: { type: 'checkbox' } });
      multi.checked = !!field.multiline;
      multi.addEventListener('change', () => this.replaceField(id, { multiline: multi.checked }));
      rows.push(h('label', { class: 'wm-forms-check' }, multi, h('span', { text: t('panels.forms.severalLines') })));
    }
    if (field.kind === 'choice') {
      const options = h('textarea', { class: 'wm-forms-options', attrs: { rows: '4', 'aria-label': t('panels.forms.options') } });
      options.value = (field.options ?? []).map((o) => o.label).join('\n');
      options.addEventListener('keydown', (e) => e.stopPropagation());
      options.addEventListener('change', () => {
        const f = this.field(id);
        if (!f) return;
        const labels = options.value.split('\n').map((s) => s.trim()).filter(Boolean);
        const old = new Map((f.options ?? []).map((o) => [o.label, o.value]));
        this.replaceField(id, { options: labels.map((label) => ({ value: old.get(label) ?? label, label })) });
      });
      rows.push(h('label', { class: 'wm-forms-row wm-forms-column' }, h('span', { text: t('panels.forms.options') }), options));
    }
    const remove = h('button', { class: 'wm-forms-delete', text: t('panels.forms.deleteField'), attrs: { type: 'button' } });
    remove.addEventListener('click', () => this.remove(id));
    rows.push(remove);
    this.properties.replaceChildren(h('p', { class: 'wm-forms-kind', text: kindLabel(field.kind) }), ...rows);
  }

  /** Places a new field where the page was clicked. */
  private place(e: PointerEvent): void {
    const kind = this.placing;
    if (!kind || !this.fields) return;
    e.preventDefault();
    const rect = this.el.getBoundingClientRect();
    const at = this.host.pageAt(e.clientX - rect.left, e.clientY - rect.top);
    this.placing = null;
    if (!at || at.x < 0 || at.y < 0 || at.x > at.page.width || at.y > at.page.height) {
      this.render();
      return;
    }
    const [width, height] = NEW_SIZE[kind];
    const box = { x: Math.min(at.x, at.page.width - width), y: Math.min(at.y, at.page.height - height), width, height };
    const taken = new Set(this.fields.map((f) => f.name));
    let n = 1;
    while (taken.has(`${newName(kind)}${n}`)) n++;
    // Its page index and rect are worked out by the worker, from its page id and box.
    const field: WireField = {
      id: `new-${Date.now().toString(36)}-${this.nextId++}`,
      name: `${newName(kind)}${n}`,
      kind,
      page: 0,
      rect: [0, 0, 0, 0],
      value: '',
      pageId: at.page.id,
      box,
      ...(kind === 'checkbox' && { onState: 'Yes' }),
      ...(kind === 'choice' && { combo: true, options: [] }),
    };
    this.fields = [...this.fields, field];
    this.selected = field.id;
    this.host.change(this.fields);
    this.render();
  }

  private key(e: KeyboardEvent): void {
    if (!this.fields || this.mode !== 'edit') return;
    const target = e.target as HTMLElement | null;
    if (target && target !== document.body && target.id !== 'input' && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (e.key === 'Escape' && (this.placing || this.selected)) {
      this.placing = null;
      this.selected = null;
      this.render();
    } else if (this.selected && (e.key === 'Delete' || e.key === 'Backspace')) {
      this.remove(this.selected);
    } else if (this.selected && e.key.startsWith('Arrow')) {
      const f = this.field(this.selected);
      const page = f && this.host.page(f.pageId);
      if (!f || !page) return;
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const box = { ...f.box, x: Math.min(Math.max(f.box.x + dx, 0), page.width - f.box.width), y: Math.min(Math.max(f.box.y + dy, 0), page.height - f.box.height) };
      this.replaceField(f.id, { box }, `nudge:${f.id}`);
    } else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  private field(id: string): WireField | undefined {
    return this.fields?.find((f) => f.id === id);
  }
}

const kindLabel = (kind: WireField['kind']): string => t(`panels.forms.kind.${kind}` as const);

/** Text size in points: the field's own, or what fits its box. */
function fontSize(field: WireField, box: Box): number {
  if (field.kind === 'checkbox' || field.kind === 'radio') return Math.min(box.width, box.height) * 0.8;
  if (field.fontSize) return field.fontSize;
  if (field.multiline) return Math.min(10, box.height * 0.7);
  return Math.min(12, Math.max(4, box.height * 0.7));
}
