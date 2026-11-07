// What the format dialogs are built from: a modal form with tabs, a drop-down list, a color button, a check box and number fields,
// all made of the shared parts (see "Consistent UI" in AGENTS.md).

import { getLocale, t } from '../../i18n/index.ts';
import type { FontChoice } from '../actions.ts';
import { h } from '../dom.ts';
import { choiceButton } from '../dropdown.ts';
import { closePopup, dialogTitleBar, openPopup, popupOpenFor } from '../popup.ts';
import { paletteContents, PALETTE } from '../toolbar.ts';
import './formatDialogs.css';

/** Lengths are in inches in English and centimetres in every other language, as in the Paragraph dialog. */
const metric = (): boolean => getLocale() !== 'en';
export const twipsPerUnit = (): number => (metric() ? 1440 / 2.54 : 1440);
export const unitName = (): string => t(metric() ? 'pageSetup.unitCm' : 'pageSetup.unitIn');
export const round = (n: number): string => String(Math.round(n * 100) / 100);

export interface Choice {
  el: HTMLButtonElement;
  value: string;
  set(value: string): void;
}

/** A drop-down list of choices. `blank` is what '' (the selection mixes this) shows. */
export function choice(label: string, options: readonly (readonly [string, string])[], value: string | undefined, onPick?: (value: string) => void): Choice {
  const names = new Map(options);
  const values = options.map(([v]) => v);
  const control = choiceButton(
    {
      label: label.replace(/[:：]$/, ''),
      fill: true,
      groups: (current) => [{ values: current === '' || values.includes(current) ? values : [current, ...values] }],
      name: (v) => names.get(v) ?? v,
    },
    (v) => {
      control.set(v);
      onPick?.(v);
    },
  );
  control.set(value ?? '');
  return control;
}

export interface ColorField {
  el: HTMLElement;
  value: string | null;
  set(color: string | null): void;
}

/** A button showing a color, with the toolbar's palette under it. Null is the "none" choice (`noneLabel`). */
export function colorField(label: string, noneLabel: string, value: string | null | undefined, onPick?: (color: string | null) => void): ColorField {
  const chip = h('span', { class: 'wm-fd-chip' });
  const name = h('span', { class: 'wm-fd-chip-name' });
  const button = h('button', { class: 'wm-dropdown wm-fd-color', title: label, attrs: { type: 'button', 'aria-label': label.replace(/[:：]$/, ''), 'aria-haspopup': 'dialog' } }, chip, name, h('span', { class: 'wm-dropdown-caret' }));
  const field: ColorField = {
    el: button,
    value: value ?? null,
    set(color) {
      field.value = color;
      chip.style.background = color ?? 'transparent';
      chip.classList.toggle('wm-fd-chip-none', !color);
      name.textContent = color ?? noneLabel;
    },
  };
  field.set(value ?? null);
  button.addEventListener('click', () => {
    if (popupOpenFor(button)) return closePopup();
    const panel = h('div', { class: 'wm-palette', attrs: { role: 'dialog', 'aria-label': label.replace(/[:：]$/, '') } });
    const { nodes } = paletteContents({
      noneLabel,
      noneStyle: 'background:#000',
      color: field.value,
      rows: PALETTE,
      used: [],
      more: true,
      choose: (color) => {
        closePopup();
        field.set(color);
        onPick?.(color);
      },
    });
    panel.append(...nodes);
    openPopup(button, panel);
  });
  return field;
}

/** A check box that can start out "mixed" (undefined), and stays so until it is touched. */
export function check(label: string, value: boolean | undefined): { input: HTMLInputElement; el: HTMLElement } {
  const input = h('input', { attrs: { type: 'checkbox' } });
  if (value === undefined) input.indeterminate = true;
  else input.checked = value;
  return { input, el: h('label', { class: 'wm-find-case' }, input, label) };
}

export function numberInput(label: string, value: string, step = '1', min?: string): HTMLInputElement {
  const input = h('input', { class: 'wm-input', attrs: { type: 'number', step, 'aria-label': label.replace(/[:：]$/, '') } });
  if (min !== undefined) input.min = min;
  input.value = value;
  return input;
}

/** A label, its control, and what goes after it (a unit), on one line. */
export const field = (label: string, control: HTMLElement, after?: string): HTMLElement => h('label', { class: 'wm-page-field' }, h('span', { text: label }), control, after === undefined ? null : h('span', { class: 'wm-page-unit', text: after }));

/** Tabs over panes; returns the tab strip. */
export function tabStrip(panes: readonly (readonly [string, HTMLElement])[]): HTMLElement {
  const strip = h('div', { class: 'wm-find-tabs', attrs: { role: 'tablist' } });
  const buttons = panes.map(([label], i) => {
    const button = h('button', { class: 'wm-find-tab', text: label, attrs: { type: 'button', role: 'tab' } });
    button.addEventListener('click', () => show(i));
    strip.append(button);
    return button;
  });
  const show = (i: number) => {
    buttons.forEach((button, k) => button.setAttribute('aria-selected', String(k === i)));
    panes.forEach(([, pane], k) => (pane.hidden = k !== i));
  };
  show(0);
  return strip;
}

export interface FormSpec<T> {
  title: string;
  className: string;
  /** Under the title bar (the tab strip). */
  top?: HTMLElement;
  body: (HTMLElement | null)[];
  /** The answer, or null with `message` filled in when what was entered won't do. */
  read(message: HTMLElement): T | null;
  /** Where the keyboard starts. */
  first: () => HTMLElement;
  /** More buttons, on the left. */
  left?: HTMLElement[];
  okText?: string;
}

/** A modal form. Resolves with `read`'s answer on OK, or `undefined` when it is closed any other way. `done` closes it from a button of its own. */
export function showForm<T>(spec: FormSpec<T>, done?: (finish: (answer: T) => void) => void): Promise<T | undefined> {
  return new Promise((resolve) => {
    const message = h('div', { class: 'wm-find-message', attrs: { role: 'alert' } });
    const ok = h('button', { class: 'wm-button', text: spec.okText ?? t('paragraph.ok'), attrs: { type: 'submit' } });
    const cancel = h('button', { class: 'wm-button', text: t('paragraph.cancel'), attrs: { type: 'button' } });
    const buttons = spec.left?.length
      ? h('div', { class: 'wm-dialog-buttons spread' }, h('span', { class: 'wm-link-actions' }, ...spec.left), h('span', { class: 'wm-link-actions' }, ok, cancel))
      : h('div', { class: 'wm-dialog-buttons' }, h('span', { class: 'wm-link-actions' }, ok, cancel));
    const form = h('form', { attrs: { method: 'dialog', novalidate: '' } }, spec.top ?? null, h('div', { class: 'wm-dialog-body wm-link-body' }, ...spec.body, message), buttons);
    const dialog = h('dialog', { class: `wm-dialog wm-link wm-fd ${spec.className}`, attrs: { 'aria-label': spec.title } }, dialogTitleBar(spec.title, () => dialog.close()), form);
    // A complaint goes as soon as something is being done about it.
    form.addEventListener('input', () => (message.textContent = ''));
    let answer: T | undefined;
    const finish = (value: T) => {
      answer = value;
      dialog.close();
    };
    done?.(finish);
    // Keys stay in the dialog: the document's handlers listen on the window.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      message.textContent = '';
      const value = spec.read(message);
      if (value !== null) finish(value);
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(answer);
    });
    document.body.append(dialog);
    dialog.showModal();
    spec.first().focus();
  });
}

/** Paints an element the way this font looks, for a sample. */
export function paintFont(el: HTMLElement, font: FontChoice): void {
  const { style } = el;
  style.fontFamily = font.family ? `${JSON.stringify(font.family)}, system-ui` : '';
  style.fontWeight = font.bold ? 'bold' : 'normal';
  style.fontStyle = font.italic ? 'italic' : 'normal';
  // A sample stays small enough to fit its box.
  style.fontSize = `${Math.min(font.size ?? 11, 28)}pt`;
  style.color = font.color ?? '';
  const lines = [font.underline && font.underline !== 'none' ? 'underline' : '', font.strike || font.doubleStrike ? 'line-through' : ''].filter(Boolean).join(' ');
  style.textDecorationLine = lines || 'none';
  style.textDecorationStyle = font.underline === 'double' || font.doubleStrike ? 'double' : 'solid';
  style.textDecorationColor = font.underlineColor ?? '';
  style.fontVariantCaps = font.smallCaps ? 'small-caps' : 'normal';
  style.textTransform = font.caps ? 'uppercase' : 'none';
  style.letterSpacing = font.spacing ? `${font.spacing / 20}pt` : '';
  style.verticalAlign = font.superscript ? 'super' : font.subscript ? 'sub' : font.position ? `${font.position / 2}pt` : '';
}
