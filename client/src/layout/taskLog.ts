// What the layout worker was doing while a keystroke waited, for View › Debug › Edit times.
//
// The worker does one thing at a time, so a keystroke that waits is waiting behind whatever runs from when it was sent until it is
// handled, and the worker is busy all that time (were it idle, it would have handled the keystroke). Each task the worker starts (a
// message from the page, a later slice of layout, a timer) says so with `begin(name)`, which also ends the one before; a task's
// promises that settle at once run in the same stretch, so they count with it. A span can run on past its work into idle time, but
// that is harmless: only the part inside a keystroke's wait is ever counted, and the worker was not idle then.

/** A clock both the page and the worker read alike (each has its own `performance.now()` origin). */
export const clock = (): number => performance.timeOrigin + performance.now();

export interface Span {
  name: string;
  start: number;
  /** When the next task began; Infinity for the one running now. */
  end: number;
}

export interface TaskTime {
  name: string;
  ms: number;
}

/** How long spans are kept: longer than any wait worth looking at. */
const KEEP_MS = 30_000;
const MAX_SPANS = 4000;

export class TaskLog {
  private spans: Span[] = [];

  /** A new task starts now (and the one before ends). */
  begin(name: string, now = clock()): void {
    const last = this.spans.at(-1);
    if (last) {
      if (last.end === Infinity) last.end = now;
      // The same task going on (a run of keystrokes, layout slice after slice): one span.
      if (last.name === name && last.end === now) {
        last.end = Infinity;
        return;
      }
    }
    this.spans.push({ name, start: now, end: Infinity });
    let drop = 0;
    while (drop < this.spans.length - 1 && (this.spans[drop].end < now - KEEP_MS || this.spans.length - drop > MAX_SPANS)) drop++;
    if (drop) this.spans.splice(0, drop);
  }

  /** The time each task took inside [from, to], most first, at most `limit` of them; tasks under 1 ms are left out. */
  within(from: number, to: number, limit = 3): TaskTime[] {
    const byName = new Map<string, number>();
    for (const span of this.spans) {
      const ms = Math.min(span.end, to) - Math.max(span.start, from);
      if (ms > 0) byName.set(span.name, (byName.get(span.name) ?? 0) + ms);
    }
    return [...byName]
      .map(([name, ms]) => ({ name, ms }))
      .filter((task) => task.ms >= 1)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, limit);
  }
}
