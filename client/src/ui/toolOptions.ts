// The tool-options strip: a small bar at the top of the drawing with the settings of the tool in
// use. So far only the Nudge brush has any: its size and how much of the drag it passes on. The
// values live in drawingOptions.ts (kept on this device and in the account); the sliders and the
// [ and ] keys both change them, and the brush's ring on the drawing follows.

import { t } from '../i18n/index.ts';
import { NUDGE_SIZE_MAX, NUDGE_SIZE_MIN, NUDGE_STRENGTH_MAX, NUDGE_STRENGTH_MIN, nudgeSize, nudgeStrengthPercent, onDrawingOptions, setNudgeSize, setNudgeStrength } from './drawingOptions.ts';
import { h } from './dom.ts';
import './toolOptions.css';

/** A labelled slider with its value beside it. */
function slider(label: string, min: number, max: number, unit: string, set: (value: number) => void, focusEditor: () => void): { el: HTMLElement; show(value: number): void } {
  const input = h('input', { attrs: { type: 'range', min: String(min), max: String(max), step: '1', 'aria-label': label } });
  const value = h('span', { class: 'wm-tool-value' });
  const show = (n: number): void => {
    input.value = String(n);
    value.textContent = `${n}${unit}`;
  };
  input.addEventListener('input', () => set(Number(input.value)));
  // The pointer is released: the keyboard goes back to the drawing.
  input.addEventListener('change', focusEditor);
  return { el: h('label', { class: 'wm-tool-field' }, h('span', { text: label }), input, value), show };
}

export class ToolOptions {
  readonly el = h('div', { class: 'wm-tool-options', attrs: { role: 'toolbar', 'aria-label': t('vector.toolOptions') } });
  private readonly size;
  private readonly strength;

  constructor(parent: HTMLElement, focusEditor: () => void) {
    this.size = slider(t('vector.nudge.size'), NUDGE_SIZE_MIN, NUDGE_SIZE_MAX, ' px', setNudgeSize, focusEditor);
    this.strength = slider(t('vector.nudge.strength'), NUDGE_STRENGTH_MIN, NUDGE_STRENGTH_MAX, '%', setNudgeStrength, focusEditor);
    this.el.hidden = true;
    this.el.append(this.size.el, this.strength.el);
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    parent.append(this.el);
    onDrawingOptions(() => this.sync());
    this.sync();
  }

  /** Shows the strip for the tool in use (none, for a tool without options). */
  setTool(tool: string): void {
    this.el.hidden = tool !== 'nudge';
  }

  private sync(): void {
    this.size.show(nudgeSize());
    this.strength.show(nudgeStrengthPercent());
  }
}
