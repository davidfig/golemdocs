// A message that appears over the window for a few seconds, for things that went wrong or can't be
// done: the status line lives in the debug overlay, which most people never see.

import { h } from './dom.ts';
import './toast.css';

const SHOWN_MS = 6000;

let el: HTMLDivElement | null = null;
let timer = 0;

/** Shows `message` at the bottom of the window (replacing any showing); a click dismisses it. */
export function showToast(message: string): void {
  if (!el) {
    el = h('div', { class: 'wm-toast', attrs: { role: 'alert' } });
    el.addEventListener('click', () => {
      if (el) el.hidden = true;
    });
    document.body.append(el);
  }
  el.textContent = message;
  el.hidden = false;
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    if (el) el.hidden = true;
  }, SHOWN_MS);
}
