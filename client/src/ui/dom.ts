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

/** A text field of the chrome itself (the font box, a comment box), not the document's hidden textarea (#input). */
export function isFormField(target: EventTarget | null): boolean {
  // The box a PDF's text is edited in is one too: it has its own caret, selection and undo.
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLTextAreaElement && target.id !== 'input') ||
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
