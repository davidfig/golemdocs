// Whether two values of the chrome's state are the same, so a frame that rebuilt an object with the same contents is not a change.

/** Same by identity, or (for objects and arrays, which the frame loop rebuilds each time) by contents. */
export function sameValue(next: unknown, prev: unknown): boolean {
  if (next === prev) return true;
  if (typeof next !== 'object' || typeof prev !== 'object' || !next || !prev) return false;
  return JSON.stringify(next) === JSON.stringify(prev);
}
