// Drawing ▸ Canvas Size: the size of the drawing's page in pixels, whether the shapes stay where
// they are or scale with it, a background colour, and Fit to Artwork. Applied as one undoable change.

import { MAX_SIDE, MIN_SIDE } from '../vector/canvas.ts';
import type { ResizeMode } from '../vector/canvas.ts';
import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import './pictureTools.css';
import { dialogTitleBar } from './popup.ts';

export interface CanvasState {
  width: number;
  height: number;
  /** The page's background colour, or null for none. */
  background: string | null;
}

export interface CanvasHost {
  state(): CanvasState;
  apply(width: number, height: number, mode: ResizeMode, background: string | null): void;
  fit(margin: number, background: string | null): void;
  focusEditor(): void;
}

const PRESETS = [
  { id: 'icon', width: 512, height: 512 },
  { id: 'square', width: 1000, height: 1000 },
  { id: 'letter', width: 816, height: 1056 },
  { id: 'a4', width: 794, height: 1123 },
  { id: 'hd', width: 1920, height: 1080 },
] as const;

export function showCanvasDialog(host: CanvasHost): void {
  const now = host.state();
  const number = (label: string, value: number, min: number, max: number) => {
    const el = h('input', { class: 'wm-input', attrs: { type: 'number', min: String(min), max: String(max), step: 'any', 'aria-label': label } });
    el.value = String(Math.round(value * 100) / 100);
    return el;
  };
  const width = number(t('vector.canvas.width'), now.width, MIN_SIDE, MAX_SIDE);
  const height = number(t('vector.canvas.height'), now.height, MIN_SIDE, MAX_SIDE);
  const keep = h('input', { attrs: { type: 'checkbox' } });
  keep.checked = true;
  const preset = h('select', { class: 'wm-input', attrs: { 'aria-label': t('vector.canvas.preset') } });
  const custom = h('option', { text: t('vector.canvas.presetCustom') });
  custom.value = '';
  preset.append(custom);
  for (const p of PRESETS) {
    const option = h('option', { text: `${t(`vector.canvas.preset.${p.id}`)} (${p.width} × ${p.height})` });
    option.value = p.id;
    preset.append(option);
  }
  const radio = (value: ResizeMode, label: string, checked: boolean) => {
    const input = h('input', { attrs: { type: 'radio', name: 'wm-canvas-mode', value } });
    input.checked = checked;
    return { input, el: h('label', { class: 'wm-picture-wide' }, input, ' ', label) };
  };
  const stay = radio('keep', t('vector.canvas.modeKeep'), true);
  const scale = radio('scale', t('vector.canvas.modeScale'), false);
  const hasBackground = h('input', { attrs: { type: 'checkbox' } });
  hasBackground.checked = now.background !== null;
  const color = h('input', { attrs: { type: 'color', 'aria-label': t('vector.canvas.background') } });
  color.value = /^#[0-9a-f]{6}$/i.test(now.background ?? '') ? (now.background as string) : '#ffffff';
  const margin = number(t('vector.canvas.margin'), 0, 0, MAX_SIDE);
  const fit = h('button', { class: 'wm-button', text: t('vector.canvas.fit'), attrs: { type: 'button' } });
  const message = h('div', { class: 'wm-find-message wm-picture-wide', attrs: { role: 'alert' } });

  const background = (): string | null => (hasBackground.checked ? color.value : null);
  const ratio = now.width / now.height;
  // One side follows the other while the proportions are kept.
  width.addEventListener('input', () => {
    preset.value = '';
    if (keep.checked && Number(width.value) > 0) height.value = String(Math.round((Number(width.value) / ratio) * 100) / 100);
  });
  height.addEventListener('input', () => {
    preset.value = '';
    if (keep.checked && Number(height.value) > 0) width.value = String(Math.round(Number(height.value) * ratio * 100) / 100);
  });
  preset.addEventListener('change', () => {
    const p = PRESETS.find((x) => x.id === preset.value);
    if (!p) return;
    width.value = String(p.width);
    height.value = String(p.height);
    keep.checked = false;
  });

  const body = h(
    'div',
    { class: 'wm-dialog-body wm-link-body' },
    h('div', { class: 'wm-picture-wide', text: t('vector.canvas.current', { width: Math.round(now.width), height: Math.round(now.height) }) }),
    h('label', { text: t('vector.canvas.preset') }),
    preset,
    h('label', { text: t('vector.canvas.width') }),
    h('span', {}, width, ' ', t('vector.canvas.pixels')),
    h('label', { text: t('vector.canvas.height') }),
    h('span', {}, height, ' ', t('vector.canvas.pixels')),
    h('label', { class: 'wm-picture-wide' }, keep, ' ', t('vector.canvas.keepRatio')),
    h('div', { class: 'wm-picture-wide', text: t('vector.canvas.shapes') }),
    stay.el,
    scale.el,
    h('label', { class: 'wm-picture-wide' }, hasBackground, ' ', t('vector.canvas.background'), ' ', color),
    h('label', { text: t('vector.canvas.margin') }),
    h('span', {}, margin, ' ', fit),
    message,
  );
  const ok = h('button', { class: 'wm-button', text: t('picture.ok'), attrs: { type: 'submit' } });
  const cancel = h('button', { class: 'wm-button', text: t('picture.cancel'), attrs: { type: 'button' } });
  const form = h('form', { attrs: { method: 'dialog' } }, body, h('div', { class: 'wm-dialog-buttons' }, h('span', { class: 'wm-link-actions' }, ok, cancel)));
  const title = t('vector.canvas.title');
  const dialog = h('dialog', { class: 'wm-dialog wm-link wm-picture-dialog', attrs: { 'aria-label': title } }, dialogTitleBar(title, () => dialog.close()), form);
  // Keys stay in the dialog: the document's handlers listen on the window.
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  cancel.addEventListener('click', () => dialog.close());
  fit.addEventListener('click', () => {
    host.fit(Math.max(0, Number(margin.value) || 0), background());
    dialog.close();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const w = Number(width.value);
    const hh = Number(height.value);
    const valid = (n: number) => Number.isFinite(n) && n >= MIN_SIDE && n <= MAX_SIDE;
    if (!valid(w) || !valid(hh)) {
      message.textContent = t('vector.canvas.invalid', { min: MIN_SIDE, max: MAX_SIDE });
      return;
    }
    host.apply(w, hh, scale.input.checked ? 'scale' : 'keep', background());
    dialog.close();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    host.focusEditor();
  });
  document.body.append(dialog);
  dialog.showModal();
  width.focus();
  width.select();
}
