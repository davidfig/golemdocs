/** How long the pointer rests on an item before it counts as about to be opened. */
const HOVER_MS = 120;

/**
 * Calls `warm` when the pointer rests on `el` for a moment, or presses it (the click that follows
 * comes a beat later): time to start fetching what opening it will need.
 */
export function warmOnHover(el: HTMLElement, warm: () => void): void {
  let timer = 0;
  el.addEventListener('pointerenter', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(warm, HOVER_MS);
  });
  el.addEventListener('pointerleave', () => window.clearTimeout(timer));
  el.addEventListener('pointerdown', () => {
    window.clearTimeout(timer);
    warm();
  });
}
