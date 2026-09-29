// The body of View > Debug: a checkbox for each debug flag (see ../debug.ts). Flags apply, and
// are saved in this browser, as they're ticked.

import { DEBUG_FLAGS, debugFlags, setDebugFlag } from '../debug.ts';
import { h } from './dom.ts';

export function debugSettings(): HTMLElement {
  const rows = DEBUG_FLAGS.map(({ key, label, hint }) => {
    const box = h('input', { attrs: { type: 'checkbox' } });
    box.checked = debugFlags()[key];
    box.addEventListener('change', () => setDebugFlag(key, box.checked));
    return h('label', { class: 'wm-debug-flag', title: hint }, box, h('span', {}, h('span', { text: label }), h('small', { text: hint })));
  });
  return h(
    'div',
    { class: 'wm-debug' },
    h('p', { text: 'Show these in the overlay at the bottom left. They are saved in this browser only.' }),
    ...rows,
  );
}
