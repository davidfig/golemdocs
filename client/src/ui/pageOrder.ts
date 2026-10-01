// The arithmetic of dragging a page to a new place in the pages panel (see pagesPanel.ts).

/**
 * The gap a dragged page would drop into, counted before it is lifted out: 0 is above the first
 * page, `count` below the last. `centers` are the middles of the pages, top to bottom, in the
 * same units as `y`, the pointer.
 */
export function dropSlot(centers: readonly number[], y: number): number {
  let slot = 0;
  while (slot < centers.length && y > centers[slot]) slot++;
  return slot;
}

/** Where page `from` ends up, as an index in the new order, when it is dropped into `slot`. */
export function moveTarget(from: number, slot: number): number {
  return slot > from ? slot - 1 : slot;
}
