// The effects' dialogs: what each needs to know, as a form. Preview plays a few seconds of the result.

import { t } from '../../i18n/index.ts';
import { choiceButton } from '../../ui/dropdown.ts';
import { h } from '../../ui/dom.ts';
import { dialogTitleBar } from '../../ui/popup.ts';

export type Value = number | string | boolean;

export type Field =
  | { key: string; label: string; kind: 'number'; value: number; min: number; max: number; step?: number }
  | { key: string; label: string; kind: 'slider'; value: number; min: number; max: number }
  | { key: string; label: string; kind: 'choice'; value: string; choices: readonly { value: string; label: string }[] }
  | { key: string; label: string; kind: 'check'; value: boolean }
  | { key: string; label: string; kind: 'text'; value: string };

export interface FormOptions {
  /** What the dialog says before its fields. */
  note?: string;
  /** Plays the result with these values; `stop` ends it. */
  preview?: { play(values: Record<string, Value>): Promise<void>; stop(): void };
  /** Says what is wrong with the values, or null. */
  check?(values: Record<string, Value>): string | null;
  /** Another answer, given as null values with this button (a label's Delete). */
  remove?: string;
}

/** Asks for the fields' values. Resolves with them, `'remove'`, or null when cancelled. */
export function askForm(title: string, fields: readonly Field[], options: FormOptions = {}): Promise<Record<string, Value> | 'remove' | null> {
  return new Promise((resolve) => {
    const readers = new Map<string, () => Value | null>();
    const rows: HTMLElement[] = [];
    let first: HTMLElement | null = null;
    for (const field of fields) {
      if (field.kind === 'choice') {
        const choice = choiceButton({ label: field.label, fill: true, groups: () => [{ values: field.choices.map((c) => c.value) }], name: (v) => field.choices.find((c) => c.value === v)?.label ?? v }, (v) => choice.set(v));
        choice.set(field.value);
        readers.set(field.key, () => choice.value);
        rows.push(h('label', { text: field.label }), choice.el);
        first ??= choice.el;
      } else if (field.kind === 'check') {
        const input = h('input', { attrs: { type: 'checkbox' } });
        input.checked = field.value;
        readers.set(field.key, () => input.checked);
        rows.push(h('label', { class: 'wm-picture-wide' }, input, ' ', field.label));
      } else if (field.kind === 'slider') {
        const input = h('input', { attrs: { type: 'range', min: String(field.min), max: String(field.max), step: '1', 'aria-label': field.label } });
        input.value = String(field.value);
        const readout = h('span', { class: 'wm-picture-value', text: String(field.value) });
        input.addEventListener('input', () => (readout.textContent = input.value));
        readers.set(field.key, () => Number(input.value));
        rows.push(h('label', { text: field.label }), h('span', { class: 'wm-picture-slider' }, input, readout));
        first ??= input;
      } else {
        const input = h('input', { class: 'wm-input', attrs: { type: 'text', 'aria-label': field.label, autocomplete: 'off', ...(field.kind === 'number' ? { inputmode: 'decimal', spellcheck: 'false' } : {}) } });
        input.value = String(field.value);
        readers.set(field.key, () => {
          if (field.kind === 'text') return input.value;
          const value = Number(input.value.trim().replace(',', '.'));
          return input.value.trim() && Number.isFinite(value) && value >= field.min && value <= field.max ? value : null;
        });
        rows.push(h('label', { text: field.label }), input);
        first ??= input;
      }
    }
    const message = h('div', { class: 'wm-find-message wm-picture-wide', attrs: { role: 'alert' } });
    const ok = h('button', { class: 'wm-button wm-primary', text: t('media.audio.ok'), attrs: { type: 'submit' } });
    const cancel = h('button', { class: 'wm-button', text: t('menus.dialog.cancel'), attrs: { type: 'button' } });
    const extra: HTMLElement[] = [];
    let previewing = false;
    let play: HTMLButtonElement | null = null;
    const stop = (): void => {
      previewing = false;
      options.preview?.stop();
      if (play) play.textContent = t('media.audio.preview');
    };
    if (options.preview) {
      const { preview } = options;
      play = h('button', { class: 'wm-button', text: t('media.audio.preview'), attrs: { type: 'button' } });
      const button = play;
      button.addEventListener('click', () => {
        if (previewing) return stop();
        const values = read();
        if (!values) return;
        previewing = true;
        button.textContent = t('media.audio.stopPreview');
        void preview.play(values).then(
          () => previewing && stop(),
          (e: unknown) => {
            stop();
            message.textContent = (e as Error).message;
          },
        );
      });
      extra.push(button);
    }
    let answer: Record<string, Value> | 'remove' | null = null;
    if (options.remove) {
      const remove = h('button', { class: 'wm-button', text: options.remove, attrs: { type: 'button' } });
      remove.addEventListener('click', () => {
        answer = 'remove';
        done();
      });
      extra.push(remove);
    }
    const ended = (): void => {
      stop();
      dialog.remove();
      resolve(answer);
    };
    // Answered as it closes, not at its close event: the editor has the focus back before that, and the next key with it.
    const done = (): void => {
      dialog.close();
      ended();
    };
    const form = h(
      'form',
      { attrs: { method: 'dialog' } },
      h('div', { class: 'wm-dialog-body wm-link-body' }, ...(options.note ? [h('p', { class: 'wm-picture-wide', text: options.note })] : []), ...rows, message),
      extra.length ? h('div', { class: 'wm-dialog-buttons spread' }, h('span', { class: 'wm-link-actions' }, ...extra), h('span', { class: 'wm-link-actions' }, ok, cancel)) : h('div', { class: 'wm-dialog-buttons' }, ok, cancel),
    );
    const dialog = h('dialog', { class: 'wm-dialog wm-link wm-picture-dialog', attrs: { 'aria-label': title } }, dialogTitleBar(title, done), form);
    const read = (): Record<string, Value> | null => {
      const values: Record<string, Value> = {};
      for (const field of fields) {
        const value = readers.get(field.key)!();
        if (value === null) {
          const limits = field as { min: number; max: number };
          message.textContent = t('media.audio.numberBetween', { field: field.label, min: limits.min, max: limits.max });
          return null;
        }
        values[field.key] = value;
      }
      const problem = options.check?.(values);
      message.textContent = problem ?? '';
      return problem ? null : values;
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const values = read();
      if (!values) return;
      answer = values;
      done();
    });
    cancel.addEventListener('click', done);
    // Keys stay in the dialog: the editor's handlers listen on what is under it.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    dialog.addEventListener('close', ended); // Escape
    document.body.append(dialog);
    dialog.showModal();
    (first ?? ok).focus();
    if (first instanceof HTMLInputElement && first.type === 'text') first.select();
  });
}
