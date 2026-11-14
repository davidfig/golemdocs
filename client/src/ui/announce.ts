// Messages for screen readers about what only the canvas shows (formatting turned on, the page the caret reached, someone
// joining). Two live regions, kept off screen: polite ones wait for the reader to finish, urgent ones interrupt it.
// Statuses that sit in a dialog or panel (Find's result, the spelling sentence) keep their own live regions there.

let regions: { polite: HTMLElement; urgent: HTMLElement } | null = null;
let clearTimer = 0;

function region(live: 'polite' | 'assertive'): HTMLElement {
  const el = document.createElement('div');
  el.className = 'wm-sr-only';
  el.setAttribute('aria-live', live);
  el.setAttribute('aria-atomic', 'true');
  if (live === 'polite') el.setAttribute('role', 'status');
  document.body.append(el);
  return el;
}

/** Says `message` to a screen reader. The same message twice in a row is said twice. */
export function announce(message: string, urgent = false): void {
  if (!message) return;
  regions ??= { polite: region('polite'), urgent: region('assertive') };
  const el = urgent ? regions.urgent : regions.polite;
  // A region whose text does not change says nothing: empty it first, and fill it on the next frame.
  el.textContent = '';
  requestAnimationFrame(() => {
    el.textContent = message;
  });
  // Emptied after a while, so reading the page with the virtual cursor does not come across old messages.
  clearTimeout(clearTimer);
  clearTimer = window.setTimeout(() => {
    if (regions) regions.polite.textContent = regions.urgent.textContent = '';
  }, 5000);
}
