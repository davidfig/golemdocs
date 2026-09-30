// Where a tooltip goes (see tooltip.ts): pure geometry, so it can be tested without a DOM.

export interface Size {
  width: number;
  height: number;
}

export interface Box extends Size {
  left: number;
  top: number;
}

/** Space kept between a tooltip and its target, and between a tooltip and the window's edge. */
const GAP = 6;
const EDGE = 4;
/** How far a tooltip that follows the pointer sits from it. */
const POINTER_DX = 12;
const POINTER_DY = 20;

/**
 * The top left of a tooltip of `tip`'s size in a window of `viewport`'s size. Next to an element
 * (`target` a box): centered below it, or above when it doesn't fit below. At a point: just below
 * and to the right of it, or above it when it doesn't fit below. It never leaves the window.
 */
export function placeTip(tip: Size, target: Box | { x: number; y: number }, viewport: Size): { left: number; top: number } {
  let left: number;
  let top: number;
  if ('left' in target) {
    left = target.left + target.width / 2 - tip.width / 2;
    top = target.top + target.height + GAP;
    if (top + tip.height > viewport.height - EDGE && target.top - GAP - tip.height >= EDGE) top = target.top - GAP - tip.height;
  } else {
    left = target.x + POINTER_DX;
    top = target.y + POINTER_DY;
    if (top + tip.height > viewport.height - EDGE && target.y - GAP - tip.height >= EDGE) top = target.y - GAP - tip.height;
  }
  left = Math.max(EDGE, Math.min(left, viewport.width - tip.width - EDGE));
  top = Math.max(EDGE, Math.min(top, viewport.height - tip.height - EDGE));
  return { left, top };
}
