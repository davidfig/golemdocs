// View › Debug › Edit times: how long edits take to reach the screen. A stall lasts one keystroke, so besides the last edit this keeps
// the worst one and how many were slow over the last while, and says where the worst one's time went: waiting for the worker, and
// behind what (layout/taskLog.ts), or in the worker on the edit itself.

/** An edit that took longer than this is counted as slow (about three frames: typing visibly lags). */
export const SLOW_EDIT_MS = 50;
/** How far back the worst edit and the slow count reach. */
export const EDIT_WINDOW_MS = 60_000;

export interface EditTime {
  /** When it reached the screen (performance.now()). */
  at: number;
  /** From the keystroke being sent to the worker until its result was on screen. */
  total: number;
  /** How much of that the worker spent on it, of which `spell` finding the squiggles. */
  worker: number;
  spell?: number;
  /** How long it waited before the worker took it up, and what the worker was doing meanwhile (a save, layout, another key...). */
  waited?: { ms: number; behind: { name: string; ms: number }[] };
  /** From the keystroke being sent until the worker's answer reached the page; the rest of `total` was drawing it. */
  answered?: number;
  /** How long the answer waited for the page's main thread, and what it was busy with (../pageTasks.ts). */
  page?: { ms: number; behind: { name: string; ms: number }[] };
}

/**
 * Where an edit's time went, for the panel: waiting for the worker ("95 ms (save 90 ms, layout 4 ms)"), in the worker on the edit
 * ("12 ms (spelling 8 ms)"), the answer held up on the page and what the page was busy with ("80 ms (autosave 60 ms, other 20 ms)"),
 * and drawing.
 */
export function describeEdit(time: EditTime): { waited: string; worker: string; page: string; draw: string } {
  const ms = (n: number) => `${Math.round(n)} ms`;
  const tasks = (list: { name: string; ms: number }[] | undefined) => (list?.length ? ` (${list.map((task) => `${task.name} ${ms(task.ms)}`).join(', ')})` : '');
  const behind = tasks(time.waited?.behind);
  const spell = time.spell && time.spell >= 1 ? ` (spelling ${ms(time.spell)})` : '';
  const answered = time.answered ?? time.total;
  return {
    waited: `${ms(time.waited?.ms ?? 0)}${behind}`,
    worker: `${ms(time.worker)}${spell}`,
    page: `${ms(time.page?.ms ?? Math.max(0, answered - (time.waited?.ms ?? 0) - time.worker))}${tasks(time.page?.behind)}`,
    draw: ms(Math.max(0, time.total - answered)),
  };
}

export interface EditSummary {
  last: EditTime;
  worst: EditTime;
  slow: number;
  count: number;
}

export class EditTimes {
  private times: EditTime[] = [];

  record(time: EditTime): void {
    this.times.push(time);
    this.prune(time.at);
  }

  clear(): void {
    this.times = [];
  }

  summary(now: number): EditSummary | null {
    this.prune(now);
    const last = this.times.at(-1);
    if (!last) return null;
    let worst = last;
    let slow = 0;
    for (const time of this.times) {
      if (time.total > worst.total) worst = time;
      if (time.total > SLOW_EDIT_MS) slow++;
    }
    return { last, worst, slow, count: this.times.length };
  }

  private prune(now: number): void {
    let drop = 0;
    while (drop < this.times.length && now - this.times[drop].at > EDIT_WINDOW_MS) drop++;
    if (drop) this.times.splice(0, drop);
  }
}
