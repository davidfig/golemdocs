// When a document's history takes a checkpoint, and which old ones it lets go of. Pure rules, shared by the server (cloud history,
// kept in R2) and the browser (local history, kept in IndexedDB) so the two behave the same.
//
// A checkpoint is the file as it was before a save replaced it, taken lazily: nothing runs on a timer, and a save
// only takes one when the last is old enough. Editing in bursts therefore costs one checkpoint per burst, not one per save.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A checkpoint as the policy sees it. */
export interface VersionStamp {
  /** When this version was the document (its `updatedAt`); also its identity. */
  at: number;
  size: number;
  /** A version the person saved on purpose: never thinned by age, only by the count cap. */
  named?: boolean;
}

export interface VersionLimits {
  /** Most unnamed versions kept. */
  maxUnnamed: number;
  /** Most bytes the unnamed ones may add up to. */
  maxBytes: number;
  /** Most named versions kept. */
  maxNamed: number;
}

/** The server's limits for one document; the byte budget is worked out per document by `byteBudget`. */
export const CLOUD_LIMITS: Omit<VersionLimits, 'maxBytes'> = { maxUnnamed: 50, maxNamed: 100 };
/** The browser's: smaller, because its space is the person's own and can be cleared by the browser. */
export const LOCAL_LIMITS: Omit<VersionLimits, 'maxBytes'> = { maxUnnamed: 20, maxNamed: 50 };

/** How long a save leaves between checkpoints. */
export const CHECKPOINT_GAP = 10 * MINUTE;
/** A save that makes the document this much smaller (by size) is checkpointed whatever the gap, so an accidental delete can be undone. */
export const SHRINK_RATIO = 0.5;
/** A save under this many bytes is too small for the shrink rule to say anything. */
const SHRINK_MIN = 2048;

/** The most bytes of history one document may hold: several times its own size, but never so little that a tiny document is limited to a version or two. */
export function byteBudget(liveSize: number): number {
  return Math.max(5 * 1024 * 1024, 8 * liveSize);
}

export interface CheckpointContext {
  /** `at` of the newest checkpoint, or null if there is none. */
  lastAt: number | null;
  /** The version being replaced (its `updatedAt`) and its size, and the size of the bytes replacing it. */
  replacedAt: number;
  replacedSize: number;
  nextSize: number;
  now: number;
}

/** The newest unnamed versions are kept whatever their age: the state a document was in before its latest edits matters most, even after a long silence. */
const KEEP_NEWEST = 3;

/**
 * Whether a save should keep what it replaces. Yes if the replaced version is the end of a burst of editing (`CHECKPOINT_GAP` passed
 * since it was saved, so this save starts a new one), or the burst has run `CHECKPOINT_GAP` since the last checkpoint, or there is no
 * checkpoint yet, or the save shrinks the document sharply. Saves in the middle of a burst keep nothing.
 */
export function shouldCheckpoint(c: CheckpointContext): boolean {
  if (c.lastAt !== null && c.lastAt >= c.replacedAt) return false; // this very version is already kept
  if (c.replacedSize >= SHRINK_MIN && c.nextSize < c.replacedSize * SHRINK_RATIO) return true;
  if (c.lastAt === null) return true;
  return c.now - c.replacedAt >= CHECKPOINT_GAP || c.replacedAt - c.lastAt >= CHECKPOINT_GAP;
}

/** The period, in milliseconds, versions of this age are thinned to: one per bucket. Zero means all are kept. */
function bucketOf(age: number): number {
  if (age <= HOUR) return 0;
  if (age <= DAY) return HOUR;
  if (age <= 30 * DAY) return DAY;
  if (age <= 90 * DAY) return 7 * DAY;
  return Infinity; // older than that: not kept
}

/**
 * The versions to remove: those older than the retention window (the newest three unnamed aside), all but the newest in each hour (a day old), day (a month old) or
 * week (three months old) bucket, then the oldest beyond the count and byte limits. Named versions are exempt from age and bytes and
 * only the oldest beyond `maxNamed` go. Returns the `at` of each version to drop.
 */
export function versionsToDrop(versions: readonly VersionStamp[], now: number, limits: VersionLimits): number[] {
  const drop = new Set<number>();
  const unnamed = versions.filter((v) => !v.named).sort((a, b) => b.at - a.at); // newest first
  const taken = new Set<string>();
  const kept: VersionStamp[] = [];
  for (const [index, v] of unnamed.entries()) {
    const period = bucketOf(Math.max(0, now - v.at));
    if (index < KEEP_NEWEST) {
      kept.push(v);
      continue;
    }
    if (period === Infinity) {
      drop.add(v.at);
      continue;
    }
    if (period > 0) {
      const bucket = `${period}:${Math.floor(v.at / period)}`;
      if (taken.has(bucket)) {
        drop.add(v.at);
        continue;
      }
      taken.add(bucket);
    }
    kept.push(v);
  }
  // Count and bytes: the newest are the ones worth most, so walk from the newest and stop keeping at the first limit hit.
  let bytes = 0;
  kept.forEach((v, index) => {
    bytes += v.size;
    if (index >= limits.maxUnnamed || bytes > limits.maxBytes) drop.add(v.at);
  });
  const named = versions.filter((v) => v.named).sort((a, b) => b.at - a.at);
  for (const v of named.slice(limits.maxNamed)) drop.add(v.at);
  return [...drop];
}
