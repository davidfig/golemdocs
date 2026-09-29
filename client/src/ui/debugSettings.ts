// The body of View > Debug: the debug flags (see ../debug.ts) in a panel for each overlay they
// feed, one checkbox each (the hint is its tooltip). Flags apply, and are saved in this
// browser, as they're ticked.

import { DEBUG_FLAGS, debugFlags, setDebugFlag, type DebugPanel } from '../debug.ts';
import { h } from './dom.ts';

export function debugSettings(): HTMLElement {
  const panels = new Map<DebugPanel, HTMLElement>();
  for (const { key, panel, label, hint } of DEBUG_FLAGS) {
    if (!panels.has(panel)) panels.set(panel, h('fieldset', { class: 'wm-debug-panel' }, h('legend', { text: panel })));
    const box = h('input', { attrs: { type: 'checkbox' } });
    box.checked = debugFlags()[key];
    box.addEventListener('change', () => setDebugFlag(key, box.checked));
    panels.get(panel)!.append(h('label', { title: hint }, box, label));
  }
  return h('div', { class: 'wm-debug' }, ...panels.values());
}
