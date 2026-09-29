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

/** Keeps focus where it is when a control is pressed with the mouse (the document keeps the caret). */
export function keepFocus(el: HTMLElement): void {
  el.addEventListener('mousedown', (e) => e.preventDefault());
}
