// Comments in the text formats: the parts every writer shares. A comment's range in a paragraph is
// marked by inline Raw markers (see edit/comments.ts in @word/docx); a writer walks a paragraph's
// inlines, hands each marker to a RangeTracker, and asks it which comments the text it is writing
// is inside of.

import type { Comment, Inline } from '@word/docx';

/** Comments by the id of the first comment of their thread: [the first comment, ...its replies]. */
export function commentThreads(comments: readonly Comment[]): Map<string, Comment[]> {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const rootOf = (c: Comment): Comment => {
    const seen = new Set<string>();
    let at = c;
    for (;;) {
      seen.add(at.id);
      const parent = at.parentId === undefined ? undefined : byId.get(at.parentId);
      if (!parent || seen.has(parent.id)) return at;
      at = parent;
    }
  };
  const threads = new Map<string, Comment[]>();
  for (const c of comments) {
    const root = rootOf(c);
    const thread = threads.get(root.id);
    if (thread) thread.push(c);
    else threads.set(root.id, [c]);
  }
  // The root leads its thread (replies follow it in document order).
  for (const [id, thread] of threads) threads.set(id, [byId.get(id)!, ...thread.filter((c) => c.id !== id)]);
  return threads;
}

/** A DTTM, the date of a comment in RTF and .doc (minute:6 hour:5 day:5 month:4 year-1900:9 weekday:3 bits), as an ISO 8601 date; undefined when it is not a date. */
export function dttmToIso(value: number): string | undefined {
  const v = value >>> 0;
  const minute = v & 63;
  const hour = (v >>> 6) & 31;
  const day = (v >>> 11) & 31;
  const month = (v >>> 16) & 15;
  const year = 1900 + ((v >>> 20) & 511);
  if (!month || month > 12 || !day || day > 31 || hour > 23 || minute > 59) return undefined;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${year}-${p(month)}-${p(day)}T${p(hour)}:${p(minute)}:00Z`;
}

/** The comment a range marker (w:commentRangeStart / w:commentRangeEnd) belongs to, or null if this isn't one. */
export function commentMarker(inline: Inline): { id: string; end: boolean } | null {
  if (inline.kind !== 'raw') return null;
  const id = inline.xml.attrs['w:id'];
  if (id === undefined) return null;
  if (inline.xml.name === 'w:commentRangeStart') return { id, end: false };
  if (inline.xml.name === 'w:commentRangeEnd') return { id, end: true };
  return null;
}

/**
 * Follows comment ranges while a paragraph is written. Ranges that a text format can write are
 * properly nested: a range ending while others opened inside it are still open cuts them short there.
 */
export class RangeTracker {
  private active: { id: string; at: number }[] = [];
  private list: string[] = [];

  /** `known` says which comment ids are written at all (others' markers are ignored). */
  constructor(private readonly known: (id: string) => boolean) {}

  /** The comments the text now being written is inside of, outermost first. */
  get ids(): readonly string[] {
    return this.list;
  }

  /**
   * Takes a marker; `at` is how many pieces have been written so far. Returns the id of a comment
   * whose range just ended with nothing in it (a comment on no text), or null.
   */
  marker(marker: { id: string; end: boolean }, at: number): string | null {
    if (!this.known(marker.id)) return null;
    if (!marker.end) {
      if (!this.active.some((a) => a.id === marker.id)) this.active.push({ id: marker.id, at });
    } else {
      const i = this.active.findIndex((a) => a.id === marker.id);
      if (i < 0) return null;
      const [closed] = this.active.splice(i);
      this.list = this.active.map((a) => a.id);
      return closed.at === at ? closed.id : null;
    }
    this.list = this.active.map((a) => a.id);
    return null;
  }
}
