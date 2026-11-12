// The M1 log (docs/live-blocks.md §6): how many documents with live blocks were opened, and how many of them were out of date,
// sent to the account as totals (POST /api/live-checks, kept by the day with nothing about who sent them). Only when signed in.

/** The count is temporary (the pricing page says so): nothing is sent from this day on. The server's end is the same (liveChecks.ts). */
export const LIVE_CHECKS_END = Date.UTC(2027, 3, 1);

/** Sent once this many have been opened, or when the page is hidden, whichever comes first. */
const BATCH = 20;

export class LiveCheckLog {
  private opened = 0;
  private stale = 0;

  constructor(
    private readonly signedIn: () => boolean,
    private readonly now: () => number = Date.now,
    private readonly send: (body: string) => Promise<unknown> = (body) => fetch('/api/live-checks', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }),
  ) {}

  /** A document with live blocks was opened; `stale` when it had to be updated. */
  record(stale: boolean): void {
    if (this.now() >= LIVE_CHECKS_END) return;
    this.opened++;
    if (stale) this.stale++;
    if (this.opened >= BATCH) this.flush();
  }

  /** Sends what has been counted (and forgets it: a lost report is a gap in a statistic, not worth keeping for). */
  flush(): void {
    if (!this.opened) return;
    const body = JSON.stringify({ opened: this.opened, stale: this.stale });
    this.opened = this.stale = 0;
    if (this.signedIn()) void this.send(body).catch(() => {});
  }
}
