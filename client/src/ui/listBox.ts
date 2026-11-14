// A list to pick from inside a dialog (Spelling's suggestions, the Thesaurus's meanings and synonyms):
// a field showing a few rows, with optional headings, picked with the pointer or the arrow keys.
// Enter or a double click chooses the picked row.

import { h, uniqueId } from './dom.ts';

/**
 * Marks `row` as the picked option of a list whose rows don't take the focus themselves: it alone is `aria-selected`, and
 * `owner` (the list, or the text box that steers it, as in the command palette) points at it with `aria-activedescendant`,
 * so a screen reader reads each row as it is picked. Shared by `listBox`, the command palette and Customize Toolbars.
 */
export function pickOption(list: HTMLElement, row: HTMLElement | null, owner: HTMLElement = list): void {
  for (const option of list.querySelectorAll<HTMLElement>('[role="option"][aria-selected="true"]')) if (option !== row) option.setAttribute('aria-selected', 'false');
  if (!row) {
    owner.removeAttribute('aria-activedescendant');
    return;
  }
  row.id ||= uniqueId('wm-option');
  row.setAttribute('aria-selected', 'true');
  owner.setAttribute('aria-activedescendant', row.id);
}

/** A heading over the rows after it, and the group they go in, so a screen reader says which group a row is in. */
export function optionGroup(heading: string): { heading: HTMLElement; group: HTMLElement } {
  const el = h('div', { class: 'wm-list-heading', text: heading, attrs: { id: uniqueId('wm-list-heading'), role: 'presentation' } });
  const group = h('div', { class: 'wm-list-group', attrs: { role: 'group', 'aria-labelledby': el.id } }, el);
  return { heading: el, group };
}

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
    picked = index;
    const row = choices[index];
    row.classList.add('active');
    pickOption(el, row);
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
      // Rows under a heading go in a group named by it.
      let into: HTMLElement = el;
      for (const row of rows) {
        if (typeof row !== 'string' && 'heading' in row) {
          const { group } = optionGroup(row.heading);
          el.append(group);
          into = group;
          continue;
        }
        if (typeof row !== 'string' && 'note' in row) {
          into.append(indent(h('div', { class: 'wm-option disabled', text: row.note, attrs: { role: 'option', 'aria-disabled': 'true' } }), row.indent));
          continue;
        }
        const text = typeof row === 'string' ? row : row.choice;
        const index = choices.length;
        const option = indent(h('div', { class: 'wm-option', text, attrs: { role: 'option', 'aria-selected': 'false' } }), typeof row === 'string' ? 0 : row.indent);
        option.dataset.value = text;
        option.addEventListener('mousedown', () => show(index, true));
        option.addEventListener('dblclick', () => options.onChoose?.(text));
        choices.push(option);
        into.append(option);
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
