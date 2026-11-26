// Scrolling while selecting: when a drag that selects (text, cells, or a box around shapes) takes the pointer to an edge of the
// view, or past it, the view scrolls that way, faster the further the pointer goes, and the selection goes on over what comes
// into view. Drags that move, size or draw things don't scroll. Every editor draws on the same kind of canvas through a camera, so one helper serves them all: it watches the
// canvas's drags from the window (before any editor's own listeners, which may stop the event), scrolls through the host, and
// after each step replays the pointer's last move on the canvas, so whichever editor owns the drag carries it to the content that
// is now under the pointer. A finger's drag is the host's own business (on a phone one finger pans), so only a mouse or pen
// drag scrolls here.

/** Within this far of an edge of the view (CSS pixels), a drag starts to scroll. */
export const EDGE_ZONE_PX = 24;
/** The speed at the very edge (CSS pixels per frame); past the edge it keeps rising, up to `EDGE_MAX_SPEED`. */
export const EDGE_SPEED = 14;
/** How far past the edge (CSS pixels) the speed doubles again. */
const EDGE_RAMP_PX = 60;
export const EDGE_MAX_SPEED = 80;
/** How far the pointer must move from where it went down before a drag can scroll: a press that stays put near an edge does not. */
const DRAG_SLOP_PX = 4;

/**
 * How fast to scroll along one axis (CSS pixels per frame, negative towards the start) for a pointer at `at` in a view that runs
 * from `start` to `end`: nothing away from the edges, rising across the `zone` inside an edge to `speed` at the edge, and on past it.
 */
export function edgeSpeed(at: number, start: number, end: number, zone = EDGE_ZONE_PX, speed = EDGE_SPEED): number {
  // A view too small for two zones scrolls only once the pointer is past it.
  const inner = Math.max(0, Math.min(zone, (end - start) / 2 - 1));
  const rate = (over: number): number => (over <= 0 ? (inner ? speed * (1 + over / inner) : 0) : Math.min(speed * (1 + over / EDGE_RAMP_PX), EDGE_MAX_SPEED));
  if (at < start + inner || at < start) return -rate(start - at);
  if (at > end - inner || at > end) return rate(at - end);
  return 0;
}

/** The scroll for a pointer at (x, y) in a view's rectangle (CSS pixels per frame on each axis). */
export function edgeVelocity(x: number, y: number, view: { left: number; top: number; right: number; bottom: number }): { x: number; y: number } {
  return { x: edgeSpeed(x, view.left, view.right), y: edgeSpeed(y, view.top, view.bottom) };
}

export interface EdgeScrollHost {
  /** Scrolls the view by this much (CSS pixels), keeping it within its bounds, and asks for a redraw. */
  scroll(dx: number, dy: number): void;
  /** Whether the drag under way is selecting (asked each frame: an editor may learn what a press grabbed only after it). */
  selecting(): boolean;
}

/** Makes every selecting mouse or pen drag that starts on `canvas` scroll the view at its edges. Returns a function that stops it. */
export function scrollDragsAtEdges(canvas: HTMLElement, host: EdgeScrollHost): () => void {
  const win = canvas.ownerDocument.defaultView ?? window;
  /** The drag under way: the press, the pointer's last real move, and whether it has gone far enough to scroll. */
  let drag: { id: number; x: number; y: number; last: PointerEvent | null; moved: boolean } | null = null;
  let frame = 0;
  /** The moves this helper replays, which it must not take for the pointer's own. */
  const replayed = new WeakSet<Event>();

  const stop = (): void => {
    drag = null;
    win.cancelAnimationFrame(frame);
    frame = 0;
  };

  const step = (): void => {
    frame = 0;
    const last = drag?.last;
    if (!drag || !last || !drag.moved) return;
    // Pressing nothing any more (the release went elsewhere): the drag is over.
    if (last.buttons === 0) return stop();
    const rect = canvas.getBoundingClientRect();
    // The part of the canvas the window shows.
    const view = { left: Math.max(rect.left, 0), top: Math.max(rect.top, 0), right: Math.min(rect.right, win.innerWidth), bottom: Math.min(rect.bottom, win.innerHeight) };
    const v = edgeVelocity(last.clientX, last.clientY, view);
    if ((!v.x && !v.y) || !host.selecting()) return;
    host.scroll(v.x, v.y);
    replay(last, rect);
    frame = win.requestAnimationFrame(step);
  };

  /** The pointer is where it was, but the content under it has moved: tell the canvas's listeners as if it had moved. */
  const replay = (last: PointerEvent, rect: DOMRect): void => {
    const PointerCtor = (win as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
    const move = new PointerCtor('pointermove', {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: last.pointerId,
      pointerType: last.pointerType,
      isPrimary: last.isPrimary,
      clientX: last.clientX,
      clientY: last.clientY,
      screenX: last.screenX,
      screenY: last.screenY,
      buttons: last.buttons,
      pressure: last.pressure,
      shiftKey: last.shiftKey,
      altKey: last.altKey,
      ctrlKey: last.ctrlKey,
      metaKey: last.metaKey,
    });
    // Not every engine works out offsetX/offsetY for an event made in script, and the editors read them.
    Object.defineProperty(move, 'offsetX', { value: last.clientX - rect.left });
    Object.defineProperty(move, 'offsetY', { value: last.clientY - rect.top });
    replayed.add(move);
    canvas.dispatchEvent(move);
  };

  const down = (e: PointerEvent): void => {
    if (e.target !== canvas || e.pointerType === 'touch' || e.button !== 0 || e.altKey) return;
    stop();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, last: null, moved: false };
  };

  const moved = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id || replayed.has(e)) return;
    drag.last = e;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > DRAG_SLOP_PX) drag.moved = true;
    // Kept the latest modifier keys: Shift held while scrolling still constrains a shape.
    if (drag.moved && !frame) frame = win.requestAnimationFrame(step);
  };

  const up = (e: PointerEvent): void => {
    if (drag && e.pointerId === drag.id) stop();
  };

  const options = { capture: true };
  win.addEventListener('pointerdown', down, options);
  win.addEventListener('pointermove', moved, options);
  win.addEventListener('pointerup', up, options);
  win.addEventListener('pointercancel', up, options);
  win.addEventListener('blur', stop);
  return () => {
    stop();
    win.removeEventListener('pointerdown', down, options);
    win.removeEventListener('pointermove', moved, options);
    win.removeEventListener('pointerup', up, options);
    win.removeEventListener('pointercancel', up, options);
    win.removeEventListener('blur', stop);
  };
}
