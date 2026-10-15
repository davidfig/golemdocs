// Work that can wait: run once the user has stopped editing for a while, and the browser has nothing better to do.
// Keeps expensive but non-urgent main-thread jobs (a save's thumbnail) out of the way of typing.

export interface QuietTimers {
  now(): number;
  set(callback: () => void, ms: number): number;
  clear(id: number): void;
  /** Calls back when the browser is idle (or soon after, if it never is). */
  idle(callback: () => void): void;
}

const BROWSER_TIMERS: QuietTimers = {
  now: () => performance.now(),
  set: (callback, ms) => window.setTimeout(callback, ms),
  clear: (id) => window.clearTimeout(id),
  idle: (callback) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(callback, { timeout: 2000 }) : window.setTimeout(callback, 0)),
};

export class QuietRunner {
  private lastTouch = -Infinity;
  private timer = 0;
  private pending: (() => void) | null = null;

  constructor(
    private readonly quietMs: number,
    private readonly timers: QuietTimers = BROWSER_TIMERS,
  ) {}

  /** Editing is going on: anything waiting is held off until `quietMs` after the last call. */
  touch(): void {
    this.lastTouch = this.timers.now();
  }

  /** Runs `task` when it has been quiet for `quietMs` and the browser is idle. A task still waiting is replaced: only the newest runs. */
  run(task: () => void): void {
    this.pending = task;
    this.arm(this.quietMs);
  }

  /** Runs the task waiting now, if any (what it needs is about to go away). */
  flush(): void {
    const task = this.pending;
    this.cancel();
    task?.();
  }

  /** Forgets the task waiting, if any (what it was for is gone). */
  cancel(): void {
    this.pending = null;
    if (this.timer) this.timers.clear(this.timer);
    this.timer = 0;
  }

  private arm(delay: number): void {
    if (this.timer) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => {
      this.timer = 0;
      const wait = this.lastTouch + this.quietMs - this.timers.now();
      if (wait > 0) return this.arm(wait); // typed again meanwhile
      this.timers.idle(() => {
        const task = this.pending;
        // Typing resumed while waiting for idle time: wait for the next pause.
        if (this.lastTouch + this.quietMs - this.timers.now() > 0) return task ? this.arm(this.quietMs) : undefined;
        this.pending = null;
        task?.();
      });
    }, delay);
  }
}

/** Times `work` as a named span in the browser's Performance recording (User Timing), whatever it returns. */
export function traced<T>(name: string, work: () => T): T {
  const start = performance.now();
  const end = () => void performance.measure(`golem:${name}`, { start, end: performance.now() });
  const result = work();
  if (result instanceof Promise) return result.finally(end) as T;
  end();
  return result;
}
