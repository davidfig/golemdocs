// The drop-down list every toolbar setting uses (stroke style, line width, fill type, the Draw tools' options): a button showing the
// current choice with a small sample of it, and a list of choices below it, each with its sample, in groups with headings when there
// are many. Build every list of choices with this, never with a native <select>, so they all look and behave the same: see
// "Consistent UI" in AGENTS.md.

import type { Action, ChromeState } from './actions.ts';
import type { CommandRegistry } from './commands.ts';
import { h } from './dom.ts';
import { closePopup, openPopup, popupOpenFor } from './popup.ts';
import type { Control } from './toolbar.ts';

export interface DropdownGroup {
  /** A heading above the choices (none for a plain list). */
  heading?: string;
  values: readonly string[];
}

export interface DropdownSpec {
  /** What the control is called (its tooltip and accessible name). */
  label: string;
  /** The choices; given the current one, so a value that is not on the list (a shape's own width) can be added to it. */
  groups(current: string): readonly DropdownGroup[];
  current(state: ChromeState): string;
  /** What a choice is called. */
  name(value: string): string;
  /** A small picture of a choice, shown beside its name; none for text only. */
  sample?(value: string): Node | null;
  /** What picking a choice asks the host to do. */
  action(value: string): Action;
  /** The button's width in pixels (the default fits a short name). */
  width?: number;
}

/** A line as thick as `width` pixels, up to what fits in a sample, for a list of line widths or thicknesses. */
export function lineSample(width: number): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 42 10');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('wm-brush-preview');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('d', 'M2 5H40');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', String(Math.min(width, 10)));
  svg.append(line);
  return svg;
}

/** What a choice button shows and offers (a drop-down list's look, without the toolbar's command). */
export interface ChoiceSpec {
  label: string;
  groups(current: string): readonly DropdownGroup[];
  name(value: string): string;
  sample?(value: string): Node | null;
  width?: number;
}

/**
 * The drop-down list itself: a button showing the current choice, and the list of choices below it; `pick` is told the
 * choice picked. The toolbar's `dropdown` is this with a command; a dialog uses it as it is.
 */
export function choiceButton(spec: ChoiceSpec, pick: (value: string) => void): { el: HTMLButtonElement; value: string; set(value: string): void } {
  const { label } = spec;
  const text = h('span', { class: 'wm-dropdown-name' });
  const sample = h('span', { class: 'wm-dropdown-sample' });
  const button = h('button', { class: 'wm-dropdown', title: label, attrs: { type: 'button', 'aria-label': label, 'aria-haspopup': 'listbox', 'aria-expanded': 'false' } }, sample, text, h('span', { class: 'wm-dropdown-caret' }));
  if (spec.width) button.style.width = `${spec.width}px`;
  const control = {
    el: button,
    value: '',
    set(value: string) {
      control.value = value;
      text.textContent = spec.name(value);
      sample.replaceChildren(...(spec.sample?.(value) ? [spec.sample(value)!] : []));
      sample.hidden = !spec.sample;
    },
  };
  button.addEventListener('click', () => {
    if (popupOpenFor(button)) return closePopup();
    const list = h('div', { class: 'wm-list wm-dropdown-list', attrs: { role: 'listbox', 'aria-label': label } });
    let chosenRow: HTMLElement | null = null;
    for (const group of spec.groups(control.value)) {
      if (group.heading) list.append(h('div', { class: 'wm-list-heading', text: group.heading }));
      for (const value of group.values) {
        const chosen = value === control.value;
        const picture = spec.sample?.(value);
        const row = h('div', { class: chosen ? 'wm-option wm-dropdown-row chosen' : 'wm-option wm-dropdown-row', attrs: { role: 'option', 'aria-selected': String(chosen) } }, ...(picture ? [h('span', { class: 'wm-dropdown-sample' }, picture)] : []), h('span', { text: spec.name(value) }));
        if (chosen) chosenRow = row;
        row.addEventListener('click', () => {
          closePopup();
          pick(value);
        });
        list.append(row);
      }
    }
    openPopup(button, list);
    (chosenRow as HTMLElement | null)?.scrollIntoView({ block: 'center' });
  });
  return control;
}

export function dropdown(spec: DropdownSpec, registry: CommandRegistry): Control {
  const choice = choiceButton(spec, (value) => {
    registry.perform(spec.action(value), spec.label);
    registry.focusEditor();
  });
  // On a toolbar the keyboard moves between controls its own way.
  choice.el.tabIndex = -1;
  return {
    el: choice.el,
    refresh: (state) => {
      const current = spec.current(state);
      choice.set(current);
      choice.el.disabled = !registry.allows(spec.action(current));
    },
  };
}
