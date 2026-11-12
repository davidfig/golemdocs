// Live blocks kept up to date in the background (docs/live-blocks.md §6, *Updates in the background*). Any of the owner's
// devices, the web app included, may update the owner's documents: it downloads a dependent, updates it, writes it back
// and lets go of it before taking the next. The account keeps a marker (/api/live-marker): the server time up to which every
// changed source's dependents have been updated, by whichever device. A device that starts, or sees the library change,
// looks for the sources changed since then, whoever changed them (the owner elsewhere, an agent, a person the source is
// shared with), and works through what shows them while the person is not busy.
//
// Memory comes first, iOS above all, which reloads a page that grows too large: one document at a time, and a document whose
// sources together are larger than this device's limit is left for a larger device (the marker's `deferred` list) or until
// someone opens it; so is one that could not be updated now (others are editing it, or it changed meanwhile), to be tried
// again at the next look. Writing a dependent changes it, so the next look finds it as a changed source in turn: chains of
// documents follow without anything here knowing about them, and stop when an update writes nothing.
//
// The app's side (the library, the keeper, the network, when the person is busy) comes in as `BackgroundDeps`.

/** How long after the last key press or click background updates may start. */
export const BACKGROUND_IDLE_MS = 5_000;
/** How much a background update may load at once (a dependent and its sources, as stored), by default. */
export const PHONE_LIMIT_BYTES = 20 * 1024 * 1024;
export const COMPUTER_LIMIT_BYTES = 100 * 1024 * 1024;

export interface LiveMarker {
  /** False when the account keeps no marker (no sync): this device is the only one, and its own saves do the work. */
  kept: boolean;
  /** The server time up to which changed sources were worked through; null before any device started. */
  workedTo: number | null;
  /** Documents (the account's ids) left for a device that can load them. */
  deferred: string[];
  /** The server's time now. */
  now: number;
}

export interface MarkerChange {
  workedTo?: number;
  defer?: string[];
  done?: string[];
}

export interface BackgroundEntry {
  key: string;
  /** Its id in the account, and when it was last changed there (the server's clock); null for a document not in it. */
  cloud: { id: string; updatedAt: number } | null;
  /** Its size as stored. */
  size: number;
}

export interface BackgroundDeps<E extends BackgroundEntry> {
  marker(): Promise<LiveMarker | null>;
  move(change: MarkerChange): Promise<void>;
  /** The owner's documents. */
  entries(): readonly E[];
  /** The documents whose live blocks show any of these. */
  dependents(keys: string[]): Promise<E[]>;
  /** The documents a document's blocks read. */
  sources(entry: E): Promise<E[]>;
  /** Brings a document's blocks up to date: rewritten, nothing to do, or not possible now (tried again later). */
  update(entry: E): Promise<'written' | 'unchanged' | 'notNow'>;
  /** How much one update may load on this device. */
  limit(): number;
  /** Resolves once the person is not busy (no input for a moment, nothing too large open); never rejects. */
  idle(): Promise<void>;
  /** How many documents are left (null: done). */
  progress(left: number | null): void;
}

export class BackgroundLive<E extends BackgroundEntry> {
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private readonly deps: BackgroundDeps<E>) {}

  /** Looks for changed sources and works through them; a look asked for while one runs follows it. */
  look(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.work().catch((e: unknown) => console.error('background live updates failed', e));
      } while (this.again);
    })().finally(() => {
      this.running = null;
      this.deps.progress(null);
    });
    return this.running;
  }

  /** Whether a document (with what its blocks read) fits in what this device may load at once. */
  private async fits(entry: E): Promise<boolean> {
    const sources = await this.deps.sources(entry);
    return entry.size + sources.reduce((sum, s) => sum + s.size, 0) <= this.deps.limit();
  }

  private async work(): Promise<void> {
    const marker = await this.deps.marker();
    if (!marker?.kept) return;
    // The first device to start: what changed before is checked when it is opened, as it always was.
    if (marker.workedTo === null) return this.deps.move({ workedTo: marker.now });
    const workedTo = marker.workedTo;
    const entries = this.deps.entries();
    const byCloud = new Map(entries.flatMap((e) => (e.cloud ? [[e.cloud.id, e] as const] : [])));
    const changed = entries.filter((e) => e.cloud && e.cloud.updatedAt > workedTo).sort((a, b) => a.cloud!.updatedAt - b.cloud!.updatedAt);
    const deferred = marker.deferred.map((id) => byCloud.get(id)).filter((e): e is E => !!e);
    const gone = marker.deferred.filter((id) => !byCloud.has(id));
    if (gone.length) await this.deps.move({ done: gone });

    // Each changed source's dependents, in the order the sources changed; each document once.
    const plan: { source: E; dependents: E[] }[] = [];
    const planned = new Set<string>();
    for (const source of changed) {
      const dependents = (await this.deps.dependents([source.key])).filter((d) => !planned.has(d.key));
      for (const d of dependents) planned.add(d.key);
      plan.push({ source, dependents });
    }
    let left = deferred.filter((d) => !planned.has(d.key)).length + plan.reduce((n, p) => n + p.dependents.length, 0);

    // Those left by a smaller device, if this one can load them.
    for (const entry of deferred) {
      if (planned.has(entry.key)) continue;
      if (!(await this.fits(entry))) {
        left--;
        continue;
      }
      this.deps.progress(left);
      await this.deps.idle();
      // Still not possible (someone else is editing it, say): it stays deferred.
      if ((await this.deps.update(entry)) !== 'notNow') await this.deps.move({ done: [entry.cloud!.id] });
      left--;
    }

    // The marker moves on after each source with dependents, and once at the end past those with none.
    let reached = workedTo;
    for (const { source, dependents } of plan) {
      reached = source.cloud!.updatedAt;
      if (!dependents.length) continue;
      const defer: string[] = [];
      const done: string[] = [];
      for (const entry of dependents) {
        this.deps.progress(left);
        if (!(await this.fits(entry))) {
          if (entry.cloud) defer.push(entry.cloud.id);
        } else {
          await this.deps.idle();
          // Not possible now (it changed meanwhile, or others are editing it): deferred, so the marker can move on.
          const outcome = await this.deps.update(entry);
          if (outcome === 'notNow') {
            if (entry.cloud) defer.push(entry.cloud.id);
          } else if (entry.cloud && marker.deferred.includes(entry.cloud.id)) done.push(entry.cloud.id);
        }
        left--;
      }
      await this.deps.move({ workedTo: reached, ...(defer.length && { defer }), ...(done.length && { done }) });
    }
    const last = plan.at(-1);
    if (last && !last.dependents.length) await this.deps.move({ workedTo: reached });
  }
}
