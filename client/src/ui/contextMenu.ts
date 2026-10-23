// What a right click opens, also opened by holding a finger down on a touch screen. Android sends a
// `contextmenu` event for a long press and iOS does not, so the press is timed here too, and whichever
// of the two comes first is the one that counts. The click that ends the press (and a drag the system
// would start from it) are dropped, so the menu stays open.

/** How long a finger is held still before it counts as a long press, and how far it may wander meanwhile. */
const HOLD_MS = 500;
const SLOP = 10;

/** Where the menu was asked for, and on what. */
export interface MenuRequest {
  clientX: number;
  clientY: number;
  target: EventTarget | null;
}

/**
 * Calls `open` on a right click (or the menu key) on `el`, and on a long press with a finger or pen. Return false from
 * `open` to leave the event alone (the system's own menu shows, and a long press does nothing).
 */
export function onContextMenu(el: HTMLElement, open: (at: MenuRequest) => boolean | void): void {
  /** A long press opened the menu, and the native event for the same press (Android) is still to come. */
  let opened = false;
  el.addEventListener('contextmenu', (e) => {
    if (opened) {
      e.preventDefault();
      return;
    }
    if (open(e) === false) return;
    e.preventDefault();
    // Android's own long press: no timed one after it.
    cancel?.();
  });

  let cancel: (() => void) | null = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !e.isPrimary) return;
    cancel?.();
    opened = false;
    const start = { x: e.clientX, y: e.clientY };
    const at: MenuRequest = { clientX: e.clientX, clientY: e.clientY, target: e.target };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId === e.pointerId && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > SLOP) stop();
    };
    const stop = () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', stop, true);
      window.removeEventListener('pointercancel', stop, true);
      window.removeEventListener('scroll', stop, true);
      if (cancel === stop) cancel = null;
    };
    const timer = window.setTimeout(() => {
      stop();
      if (open(at) === false) return;
      opened = true;
      swallowAfterPress();
      // The native event of this press, if any, comes about now.
      window.setTimeout(() => (opened = false), HOLD_MS);
    }, HOLD_MS);
    cancel = stop;
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', stop, true);
    window.addEventListener('pointercancel', stop, true);
    window.addEventListener('scroll', stop, true);
  });
}

/** Drops the click that lifting the finger sends, and a drag the system starts from the press. */
function swallowAfterPress(): void {
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const done = () => {
    window.removeEventListener('click', swallow, true);
    window.removeEventListener('dragstart', swallow, true);
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  window.addEventListener('dragstart', swallow, { capture: true, once: true });
  // Lifting the finger may send no click at all: that must not cost the next real one.
  const lifted = () => {
    window.removeEventListener('pointerup', lifted, true);
    window.removeEventListener('pointercancel', lifted, true);
    window.setTimeout(done, 400);
  };
  window.addEventListener('pointerup', lifted, true);
  window.addEventListener('pointercancel', lifted, true);
}
