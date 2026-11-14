// How the document is drawn for people who need it drawn differently (Tools › Options › Accessibility; see
// docs/architecture/accessibility.md): the caret's width and whether it blinks (by default it does unless the system asks
// for reduced motion), and the system's high contrast colors (Windows' contrast themes), which the canvas would
// otherwise ignore since the browser only applies them to HTML.

import type { ForcedColors } from '../webgl/program.ts';

export const CARET_WIDTH_KEY = 'golem.caretWidth';
export const CARET_BLINK_KEY = 'golem.caretBlink';
/** Caret widths offered, in CSS pixels at 100% zoom. */
export const CARET_WIDTHS = [1, 2, 3] as const;
export type CaretWidth = (typeof CARET_WIDTHS)[number];

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The choice lasts for this session only.
  }
};

const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

/** Calls `listener` when the caret options or the system's colors change. */
export const onAccessibilityChange = (listener: () => void): void => void listeners.add(listener);

/** Parses a saved caret width (anything else: the default, 1). */
export function parseCaretWidth(value: string | null): CaretWidth {
  const n = Number(value);
  return (CARET_WIDTHS as readonly number[]).includes(n) ? (n as CaretWidth) : 1;
}

let width = parseCaretWidth(read(CARET_WIDTH_KEY));

export const caretWidth = (): CaretWidth => width;

export function setCaretWidth(value: CaretWidth): void {
  width = value;
  write(CARET_WIDTH_KEY, String(value));
  changed();
}

/** The caret options as storage now has them (a choice from the account, settingsSync.ts). Reads and never writes. */
export function rereadCaretOptions(): void {
  width = parseCaretWidth(read(CARET_WIDTH_KEY));
  changed();
}

const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
motionQuery?.addEventListener('change', changed);

/** Whether the caret blinks: as chosen, else not when the system asks for reduced motion. */
export function caretBlinks(): boolean {
  const saved = read(CARET_BLINK_KEY);
  if (saved === 'on' || saved === 'off') return saved === 'on';
  return !motionQuery?.matches;
}

export function setCaretBlinks(on: boolean): void {
  write(CARET_BLINK_KEY, on ? 'on' : 'off');
  changed();
}

/** The caret's width in points: `width` CSS pixels at 100% zoom (1: the thinnest the screen can draw). */
export function caretPoints(value: CaretWidth = width): number {
  return value === 1 ? 0.01 : value * 0.75;
}

const forcedQuery = typeof matchMedia === 'function' ? matchMedia('(forced-colors: active)') : null;
let forced: ForcedColors | null | undefined;
forcedQuery?.addEventListener('change', () => {
  forced = undefined;
  changed();
});

/** An `rgb(r, g, b)` color as 0xRRGGBB (null if it is not one). */
export function parseRgb(css: string): number | null {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css);
  return m ? (Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3]) : null;
}

/** The system's page and text colors while it forces its own (Windows' contrast themes), else null. */
export function forcedColors(): ForcedColors | null {
  if (forced !== undefined) return forced;
  forced = null;
  if (!forcedQuery?.matches) return forced;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;width:0;height:0;color:CanvasText;background-color:Canvas';
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const page = parseRgb(style.backgroundColor);
  const text = parseRgb(style.color);
  probe.remove();
  if (page !== null && text !== null) forced = { page, text };
  return forced;
}
