// Small DOM helpers: the chrome is plain DOM, no framework.

type Child = Node | string | null | undefined | false;

export interface Props {
  class?: string;
  /** Attributes (aria-*, role, data-*, …). */
  attrs?: Record<string, string>;
  text?: string;
  title?: string;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.title) el.title = props.title;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.attrs) for (const [name, value] of Object.entries(props.attrs)) el.setAttribute(name, value);
  for (const child of children) if (child) el.append(child);
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';

/** A cross, for `iconButton`. */
export const CLOSE_ICON = 'M3 3L9 9M9 3L3 9';

/** A right-pointing chevron, for `iconButton`: turn it 90° to show something is open. */
export const CHEVRON_ICON = 'M4 2.5l4 3.5-4 3.5';

/** Keeps a note at the bottom of the window above the status bar while it shows, through `--wm-footer-clearance`. */
export function keepAboveFooter(el: HTMLElement): void {
  const footer = document.getElementById('footer');
  if (footer) new ResizeObserver(() => el.style.setProperty('--wm-footer-clearance', `${footer.offsetHeight}px`)).observe(footer);
}

/** A small button showing `path` (drawn on a 12 × 12 grid) rather than a character, so the icon is centered the same whatever the font does. Style the stroke in CSS. */
export function iconButton(className: string, path: string, label: string): HTMLButtonElement {
  const icon = document.createElementNS(SVG, 'svg');
  icon.setAttribute('viewBox', '0 0 12 12');
  icon.setAttribute('width', '12');
  icon.setAttribute('height', '12');
  icon.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS(SVG, 'path');
  shape.setAttribute('d', path);
  icon.append(shape);
  return h('button', { class: className, attrs: { type: 'button', 'aria-label': label }, title: label }, icon as unknown as Node);
}

/** One choice of a segmented control: its value, its words, and optionally a tooltip and a small picture before the words. */
export interface SegmentOption<T extends string> {
  value: T;
  text: string;
  title?: string;
  icon?: Node;
}

/**
 * A row of joined buttons of which exactly one is on (Solid | Linear | Radial, Fill | Edit): the one
 * look for choosing a mode wherever the app does it. `set` marks the current value; `onPick` runs
 * when another one is clicked.
 */
export function segmented<T extends string>(label: string, options: readonly SegmentOption<T>[], onPick: (value: T) => void): { el: HTMLElement; set(value: T): void } {
  // One choice of several: a radio group (role, aria-checked, one Tab stop on the chosen one, Left and Right to choose).
  // Up and Down are left to what holds it (a popup moves through its items with them).
  const el = h('div', { class: 'wm-segmented', attrs: { role: 'radiogroup', 'aria-label': label } });
  const buttons = options.map((option) => {
    const button = h('button', { class: 'wm-segment', title: option.title, attrs: { type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1', 'data-value': option.value } }, option.icon ?? null, h('span', { text: option.text }));
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-checked') !== 'true') onPick(option.value);
    });
    el.append(button);
    return button;
  });
  if (buttons[0]) buttons[0].tabIndex = 0;
  el.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    const at = buttons.indexOf(e.target as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const step = (e.key === 'ArrowRight') !== (getComputedStyle(el).direction === 'rtl') ? 1 : -1;
    const next = buttons[(at + step + buttons.length) % buttons.length];
    next.focus();
    next.click();
  });
  return {
    el,
    set(value) {
      const chosen = options.findIndex((option) => option.value === value);
      buttons.forEach((button, i) => {
        setAttr(button, 'aria-checked', String(i === chosen));
        button.tabIndex = i === (chosen < 0 ? 0 : chosen) ? 0 : -1;
      });
    },
  };
}

/** What `roving` moves through: the group's items that are shown and can be used. */
function rovingItems(group: HTMLElement, selector: string): HTMLElement[] {
  return [...group.querySelectorAll<HTMLElement>(selector)].filter((el) => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true' && el.getClientRects().length > 0);
}

/**
 * A group the keyboard enters at one place and moves through with the arrow keys, as ARIA's radio groups and tab lists do:
 * the item whose `current` attribute is "true" (or else the first) is the one Tab stop, the arrow keys (Up and Down too
 * with `vertical`), Home and End move the focus and press the item they land on, so choosing follows the focus. The Tab
 * stop follows `current` however it changes, by the keyboard, the mouse or the code. Used by the format dialogs' tab strips
 * and galleries and by the other dialogs' tabs (`tabList`).
 */
export function roving(group: HTMLElement, items: string, current: string, vertical = false): void {
  const sync = () => {
    const all = [...group.querySelectorAll<HTMLElement>(items)];
    const on = all.find((el) => el.getAttribute(current) === 'true') ?? rovingItems(group, items)[0];
    for (const el of all) el.tabIndex = el === on ? 0 : -1;
  };
  sync();
  new MutationObserver(sync).observe(group, { subtree: true, childList: true, attributes: true, attributeFilter: [current, 'disabled', 'hidden'] });
  group.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const list = rovingItems(group, items);
    const at = list.indexOf(e.target as HTMLElement);
    if (at < 0) return;
    const rtl = getComputedStyle(group).direction === 'rtl';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    let to: number;
    if (e.key === forward || (vertical && e.key === 'ArrowDown')) to = (at + 1) % list.length;
    else if (e.key === back || (vertical && e.key === 'ArrowUp')) to = (at - 1 + list.length) % list.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = list.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    list[to].focus();
    if (list[to].getAttribute(current) !== 'true') list[to].click();
  });
}

/**
 * A tab strip (`role="tablist"` of `role="tab"` buttons): one Tab stop on the shown tab, Left and Right (Home, End) to
 * show another. With `panes` (one per tab, in order), each tab says which pane it controls and each pane is named by its tab.
 */
export function tabList(strip: HTMLElement, panes?: readonly HTMLElement[]): void {
  const tabs = [...strip.querySelectorAll<HTMLElement>('[role="tab"]')];
  if (panes)
    tabs.forEach((tab, i) => {
      const pane = panes[i];
      if (!pane) return;
      tab.id ||= uniqueId('wm-tab');
      pane.id ||= uniqueId('wm-tabpanel');
      pane.setAttribute('role', 'tabpanel');
      tab.setAttribute('aria-controls', pane.id);
      pane.setAttribute('aria-labelledby', tab.id);
    });
  roving(strip, '[role="tab"]', 'aria-selected');
}

let lastId = 0;
/** An id no other element has, for aria-labelledby, aria-controls and aria-activedescendant. */
export const uniqueId = (prefix: string): string => `${prefix}-${++lastId}`;

/** Sets an attribute only when it changes (refreshes run often). */
export function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

export function toggleClass(el: Element, name: string, on: boolean): void {
  if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
}

/**
 * A label with a Windows-style mnemonic: "&File" → File with F underlined (the underline is
 * only shown while keyboard cues are on). Returns the element and the mnemonic key, if any.
 */
export function mnemonicLabel(label: string): { el: HTMLSpanElement; key: string | null; text: string } {
  const el = h('span', { class: 'label' });
  let key: string | null = null;
  let text = '';
  for (let i = 0; i < label.length; i++) {
    const c = label[i];
    if (c === '&' && i + 1 < label.length) {
      const next = label[++i];
      if (next === '&') {
        el.append('&');
        text += '&';
      } else {
        key ??= next.toLowerCase();
        el.append(h('u', { text: next }));
        text += next;
      }
    } else {
      el.append(c);
      text += c;
    }
  }
  el.normalize();
  return { el, key, text };
}

export const stripMnemonic = (label: string) => label.replace(/&(.)/g, '$1');

/** A modal dialog is open (a native one, or an overlay marked aria-modal): the keys are its, not the document's or a drawing's. */
export const modalOpen = (): boolean => !!document.querySelector('dialog:modal, [aria-modal="true"]');

/** A text field of the chrome itself (the font box, a comment box), not the document's hidden textarea (#input), the large-text editor's or the spreadsheet editor's. */
export function isFormField(target: EventTarget | null): boolean {
  // The box a PDF's text is edited in is one too: it has its own caret, selection and undo.
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLTextAreaElement && target.id !== 'input' && !('largeInput' in target.dataset) && !('sheetInput' in target.dataset)) ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** Whether a drag brings files from outside the page (from the desktop, say). */
export const isFileDrag = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files');

/** Keeps focus where it is when a control is pressed with the mouse (the document keeps the caret). */
export function keepFocus(el: HTMLElement): void {
  el.addEventListener('mousedown', (e) => e.preventDefault());
}

/**
 * Lets a dialog be moved by dragging its title bar (for the dialogs that stay open over the
 * document: Find, Spelling). It starts where the stylesheet puts it and moves from there.
 */
export function makeDraggable(dialog: HTMLElement, handle = '.wm-dialog-title'): void {
  const title = dialog.querySelector<HTMLElement>(handle);
  if (!title) return;
  title.style.cursor = 'move';
  title.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const box = dialog.getBoundingClientRect();
    // A dialog is positioned against the window; a panel inside the view, against its container.
    const parent = getComputedStyle(dialog).position === 'fixed' ? null : dialog.offsetParent?.getBoundingClientRect();
    const originX = parent?.left ?? 0;
    const originY = parent?.top ?? 0;
    const width = parent?.width ?? window.innerWidth;
    const height = parent?.height ?? window.innerHeight;
    const dx = e.clientX - box.left;
    const dy = e.clientY - box.top;
    const move = (m: PointerEvent) => {
      // Kept where the title bar can still be grabbed.
      const left = Math.min(Math.max(m.clientX - dx - originX, 40 - box.width), width - 40);
      const top = Math.min(Math.max(m.clientY - dy - originY, 0), height - 30);
      dialog.style.inset = `${top}px auto auto ${left}px`;
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    e.preventDefault();
  });
}
