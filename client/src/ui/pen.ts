// A graphics tablet's pen (Wacom and the like, or a stylus on a tablet): what it reports beyond a
// mouse. The browser gives it all through pointer events, so nothing here is specific to one make.

/** Whether the event is from a pen, so its `pressure` means how hard it is pressed (a mouse always says 0.5). */
export const isPen = (e: PointerEvent): boolean => e.pointerType === 'pen';

/** Whether the pen is turned over, pressing with its eraser end (button 5, held as `buttons` 32). */
export const isPenEraser = (e: PointerEvent): boolean => isPen(e) && (e.button === 5 || (e.buttons & 32) !== 0);

/**
 * Every position the pointer passed since the last move event. A pen reports far more often than the
 * screen is drawn, and the browser hands over only the latest, so a fast stroke would lose its curve.
 */
export const movesOf = (e: PointerEvent): PointerEvent[] => {
  const all = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
  return all.length ? all : [e];
};
