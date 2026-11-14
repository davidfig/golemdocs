// Getting around the window from the keyboard (see docs/architecture/accessibility.md). The toolbars' controls stay out of
// the Tab order (Tab in the document is a tab character), so the keyboard reaches them as Word's does: F6 and Shift+F6 go
// from one part of the window to the next (menu bar, toolbars, document, side panels, status bar), and in a toolbar the
// arrow keys go from control to control, Enter or Space presses one, and Escape goes back to the document.

/** Controls in a row that the keyboard can stop on: shown and not disabled. */
export function rowControls(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>('button, input')].filter((el) => !(el as HTMLButtonElement).disabled && !el.closest('[hidden]') && el.getClientRects().length > 0 && el.getAttribute('aria-disabled') !== 'true');
}

/** Keys inside a toolbar: arrows and Home / End between its controls, Enter and Space to press a button, Escape to the document. */
export function toolbarKeys(row: HTMLElement, e: KeyboardEvent, focusDocument: () => void): void {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const target = e.target instanceof HTMLElement ? e.target : null;
  if (!target || !row.contains(target)) return;
  // A text box (the font or zoom box) keeps its own keys.
  if (target instanceof HTMLInputElement) return;
  const controls = rowControls(row);
  const at = controls.indexOf(target);
  const go = (i: number) => {
    e.preventDefault();
    controls[(i + controls.length) % controls.length]?.focus();
  };
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return go(at + 1);
    case 'ArrowLeft':
    case 'ArrowUp':
      return go(at - 1);
    case 'Home':
      return go(0);
    case 'End':
      return go(controls.length - 1);
    case 'Enter':
    case ' ':
      // The document's own keys would take Enter as a new paragraph: the button is pressed here instead.
      e.preventDefault();
      target.click();
      return;
    case 'Escape':
      e.preventDefault();
      focusDocument();
  }
}

/** A part of the window F6 stops at. */
export interface Region {
  /** The element the region is (whether the focus is in it). */
  el: HTMLElement;
  /** Gives the region the keyboard: false when it has nothing to focus now. */
  focus(): boolean;
}

/** The region the focus is in, by index (-1: none of them). */
export function regionOf(regions: readonly Region[], active: Element | null): number {
  if (!active) return -1;
  return regions.findIndex((region) => region.el === active || region.el.contains(active));
}

/** Moves to the next region (or the one before) that can take the focus. Whether one did. */
export function cycleRegions(regions: readonly Region[], active: Element | null, backward: boolean): boolean {
  const n = regions.length;
  if (!n) return false;
  const from = regionOf(regions, active);
  for (let step = 1; step <= n; step++) {
    const i = (((from < 0 ? (backward ? 0 : -1) : from) + (backward ? -step : step)) % n + n) % n;
    if (regions[i].focus()) return true;
  }
  return false;
}

/** The first control of an element that can take the focus. */
export function focusFirst(el: HTMLElement): boolean {
  if (el.hidden || !el.getClientRects().length) return false;
  const target = el.matches('[tabindex], button, input, a[href]') ? el : el.querySelector<HTMLElement>('[tabindex="0"], button:not([disabled]), input:not([disabled]), a[href], [tabindex="-1"]');
  if (!target) return false;
  target.focus({ preventScroll: true });
  return document.activeElement === target;
}
