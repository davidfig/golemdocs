// A list to pick from inside a dialog (Spelling's suggestions, the Thesaurus's meanings and synonyms):
// a field showing a few rows, with optional headings, picked with the pointer or the arrow keys.
// Enter or a double click chooses the picked row.

import { h } from './dom.ts';

/**
 * A row: a choice, a heading over the rows after it, or a row that can't be picked (a note such as "(no suggestions)").
 * A choice or a note can be indented `indent` steps, to show a tree (Move's folders).
 */
export type ListRow = string | { heading: string } | { note: string; indent?: number } | { choice: string; indent?: number };

export interface ListBox {
  readonly el: HTMLElement;
  /** Shows these rows; the first choice is picked. */
  set(rows: readonly ListRow[]): void;
  /** The picked choice, or '' when none is. */
  readonly value: string;
  /** Where the picked choice is among the choices (headings and notes not counted), or -1. */
  readonly index: number;
  /** Picks the choice at `index` among the choices. */
  pick(index: number): void;
  focus(): void;
}

/**
 * A list box. `onPick` runs when the picked row changes (by pointer or keys, not by `set` or `pick`);
 * `onChoose` when a row is chosen: Enter, or a double click.
 */
export function listBox(label: string, options: { rows?: number; onPick?: (value: string) => void; onChoose?: (value: string) => void } = {}): ListBox {
  const el = h('div', { class: 'wm-list wm-list-box', attrs: { role: 'listbox', tabindex: '0', 'aria-label': label } });
  el.style.setProperty('--wm-list-rows', String(options.rows ?? 5));
  let choices: HTMLElement[] = [];
  let picked = -1;

  const show = (index: number, notify: boolean) => {
    if (index < 0 || index >= choices.length) return;
    choices[picked]?.classList.remove('active');
    choices[picked]?.setAttribute('aria-selected', 'false');
    picked = index;
    const row = choices[index];
    row.classList.add('active');
    row.setAttribute('aria-selected', 'true');
    el.setAttribute('aria-activedescendant', row.id);
    row.scrollIntoView({ block: 'nearest' });
    if (notify) options.onPick?.(row.dataset.value ?? '');
  };

  el.addEventListener('keydown', (e) => {
    const page = Math.max(1, (options.rows ?? 5) - 1);
    const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page, Home: -Infinity, End: Infinity };
    if (e.key in step) {
      e.preventDefault();
      if (choices.length) show(Math.max(0, Math.min(choices.length - 1, (picked < 0 ? 0 : picked) + step[e.key])), true);
    } else if (e.key === 'Enter' && picked >= 0) {
      e.preventDefault();
      options.onChoose?.(choices[picked].dataset.value ?? '');
    }
  });

  const box: ListBox = {
    el,
    set(rows) {
      el.replaceChildren();
      choices = [];
      picked = -1;
      el.removeAttribute('aria-activedescendant');
      const indent = (option: HTMLElement, steps: number | undefined) => {
        if (steps) option.style.paddingLeft = `${8 + steps * 16}px`;
        return option;
      };
      for (const row of rows) {
        if (typeof row !== 'string' && 'heading' in row) {
          el.append(h('div', { class: 'wm-list-heading', text: row.heading, attrs: { role: 'presentation' } }));
          continue;
        }
        if (typeof row !== 'string' && 'note' in row) {
          el.append(indent(h('div', { class: 'wm-option disabled', text: row.note, attrs: { role: 'option', 'aria-disabled': 'true' } }), row.indent));
          continue;
        }
        const text = typeof row === 'string' ? row : row.choice;
        const index = choices.length;
        const option = indent(h('div', { class: 'wm-option', text, attrs: { role: 'option', id: `wm-list-${Math.random().toString(36).slice(2)}`, 'aria-selected': 'false' } }), typeof row === 'string' ? 0 : row.indent);
        option.dataset.value = text;
        option.addEventListener('mousedown', () => show(index, true));
        option.addEventListener('dblclick', () => options.onChoose?.(text));
        choices.push(option);
        el.append(option);
      }
      if (choices.length) show(0, false);
      el.scrollTop = 0;
    },
    get value() {
      return choices[picked]?.dataset.value ?? '';
    },
    get index() {
      return picked;
    },
    pick: (index) => show(index, false),
    focus: () => el.focus(),
  };
  return box;
}
