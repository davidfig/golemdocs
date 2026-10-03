// The picture tools' dialogs: Resize (a new size in pixels) and Adjust Colors (brightness, contrast
// and saturation, with a preview). Modal dialogs like the others.

import { decodeImage, makeCanvas } from '../formats/imageCodec.ts';
import { MAX_SIDE, NO_ADJUSTMENTS, adjustPixels, isNeutral, resizedTo } from '../formats/imagePixels.ts';
import type { Adjustments } from '../formats/imagePixels.ts';
import { t } from '../i18n/index.ts';
import { h } from './dom.ts';
import './pictureTools.css';
import { dialogTitleBar } from './popup.ts';

function dialogShell(title: string, body: HTMLElement, ok: HTMLElement, extra: HTMLElement[] = []): { dialog: HTMLDialogElement; form: HTMLFormElement; cancel: HTMLButtonElement } {
  const cancel = h('button', { class: 'wm-button', text: t('picture.cancel'), attrs: { type: 'button' } });
  const form = h('form', { attrs: { method: 'dialog' } }, body, h('div', { class: 'wm-dialog-buttons' }, h('span', { class: 'wm-link-actions' }, ...extra, ok, cancel)));
  const dialog = h('dialog', { class: 'wm-dialog wm-link wm-picture-dialog', attrs: { 'aria-label': title } }, dialogTitleBar(title, () => dialog.close()), form);
  // Keys stay in the dialog: the document's handlers listen on the window.
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  cancel.addEventListener('click', () => dialog.close());
  return { dialog, form, cancel };
}

/** Asks for a picture's new size: resolves with it, or `undefined` on Cancel. */
export function showResizeDialog(width: number, height: number): Promise<{ width: number; height: number } | undefined> {
  return new Promise((resolve) => {
    const number = (label: string, value: number) => {
      const el = h('input', { class: 'wm-input', attrs: { type: 'number', min: '1', max: String(MAX_SIDE), step: '1', 'aria-label': label } });
      el.value = String(value);
      return el;
    };
    const w = number(t('picture.resize.width'), width);
    const hh = number(t('picture.resize.height'), height);
    const keep = h('input', { attrs: { type: 'checkbox', checked: '' } });
    keep.checked = true;
    const message = h('div', { class: 'wm-find-message wm-picture-wide', attrs: { role: 'alert' } });
    const body = h(
      'div',
      { class: 'wm-dialog-body wm-link-body' },
      h('label', { text: t('picture.resize.width') }),
      h('span', {}, w, ' ', t('picture.resize.pixels')),
      h('label', { text: t('picture.resize.height') }),
      h('span', {}, hh, ' ', t('picture.resize.pixels')),
      h('label', { class: 'wm-picture-wide' }, keep, ' ', t('picture.resize.keep')),
      h('div', { class: 'wm-picture-wide', text: t('picture.resize.original', { width, height }) }),
      message,
    );
    const ok = h('button', { class: 'wm-button', text: t('picture.ok'), attrs: { type: 'submit' } });
    const { dialog, form } = dialogShell(t('picture.resize.title'), body, ok);
    // One side follows the other while the shape is kept.
    w.addEventListener('input', () => {
      if (keep.checked && Number(w.value) > 0) hh.value = String(resizedTo(width, height, { width: Number(w.value) }, true).height);
    });
    hh.addEventListener('input', () => {
      if (keep.checked && Number(hh.value) > 0) w.value = String(resizedTo(width, height, { height: Number(hh.value) }, true).width);
    });
    let result: { width: number; height: number } | undefined;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const size = { width: Number(w.value), height: Number(hh.value) };
      const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_SIDE;
      if (!valid(size.width) || !valid(size.height)) {
        message.textContent = t('picture.resize.bad', { max: MAX_SIDE });
        return;
      }
      result = size;
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    w.select();
  });
}

/** Asks how to adjust a picture's colours, showing the result on a small copy of it. Resolves with the adjustments, or `undefined` on Cancel. */
export function showAdjustDialog(bytes: Uint8Array): Promise<Adjustments | undefined> {
  return new Promise((resolve) => {
    const values: Adjustments = { ...NO_ADJUSTMENTS };
    const preview = h('canvas', { class: 'wm-picture-preview wm-picture-wide' });
    const rows: HTMLElement[] = [];
    const inputs: HTMLInputElement[] = [];
    const readouts: HTMLElement[] = [];
    let base: ImageData | null = null;
    const draw = () => {
      if (!base) return;
      const copy = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
      adjustPixels(copy.data, values);
      preview.getContext('2d')!.putImageData(copy, 0, 0);
    };
    for (const key of ['brightness', 'contrast', 'saturation'] as const) {
      const range = h('input', { attrs: { type: 'range', min: '-100', max: '100', step: '1', value: '0', 'aria-label': t(`picture.adjust.${key}`) } });
      const readout = h('span', { class: 'wm-picture-value', text: '0' });
      range.addEventListener('input', () => {
        values[key] = Number(range.value);
        readout.textContent = range.value;
        draw();
      });
      inputs.push(range);
      readouts.push(readout);
      rows.push(h('label', { text: t(`picture.adjust.${key}`) }), h('span', { class: 'wm-picture-slider' }, range, readout));
    }
    const body = h('div', { class: 'wm-dialog-body wm-link-body' }, preview, ...rows);
    // A grid of label, then slider and value.
    body.querySelectorAll<HTMLElement>('.wm-picture-slider').forEach((el) => {
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.gap = '8px';
    });
    const ok = h('button', { class: 'wm-button', text: t('picture.ok'), attrs: { type: 'submit' } });
    const reset = h('button', { class: 'wm-button', text: t('picture.adjust.reset'), attrs: { type: 'button' } });
    const { dialog, form } = dialogShell(t('picture.adjust.title'), body, ok, [reset]);
    reset.addEventListener('click', () => {
      Object.assign(values, NO_ADJUSTMENTS);
      inputs.forEach((input) => (input.value = '0'));
      readouts.forEach((r) => (r.textContent = '0'));
      draw();
    });
    let result: Adjustments | undefined;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      result = isNeutral(values) ? undefined : { ...values };
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    // The preview is a copy of the picture at a size that stays quick to redraw.
    decodeImage(bytes).then((bitmap) => {
      const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
      const { canvas, context } = makeCanvas(bitmap.width * scale, bitmap.height * scale);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      preview.width = canvas.width;
      preview.height = canvas.height;
      base = context.getImageData(0, 0, canvas.width, canvas.height);
      draw();
    }, () => {
      // A picture the browser can't decode: no preview, the sliders still work.
    });
  });
}
