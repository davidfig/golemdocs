// Uploading this browser's copies to the account. Signed in, each save schedules an upload of that
// document for a moment after editing pauses. Uploads go one at a time. Offline, or once the
// session has ended, they wait (the button at the top right says so) and go when the connection or
// the sign-in is back. A ZIP import sends its documents in batches instead: the ordinary uploads
// leave those alone meanwhile, as both would make the same document in the account.
//
// The queue keeps the state; what an upload does (and what it changes on screen) is the host's.

import { CloudError } from './cloud.ts';

export interface UploadHost {
  /** Whether anything can be uploaded: signed in, with sync. */
  enabled(): boolean;
  /** Uploads one copy. Throws as `cloud.ts` does: the queue works out from that whether to try again. */
  send(id: string): Promise<void>;
  /** An upload finished, however it went (the lists and the button catch up). */
  settled(id: string): Promise<void> | void;
  /** The account says this user has no sync (their subscription ended, say). */
  noSync(): void;
  /** Offline for a while: time to see whether the account can be reached again. */
  retry(): void;
  /** What the button at the top right shows changed. */
  changed(): void;
}

export interface UploadTiming {
  /** How long after a save its upload starts (editing usually goes on). */
  delayMs: number;
  /** How often to try again while offline (the browser's "online" event isn't always reliable). */
  offlineRetryMs: number;
}

export class UploadQueue {
  /** Browser copies with changes the account doesn't have, to upload. */
  private readonly dirty = new Set<string>();
  /** Copies a batch is sending (they are in `dirty` too: whatever a batch doesn't take goes the ordinary way). */
  private readonly batching = new Set<string>();
  /** The batch being sent, if any (settles once its copies are marked as uploaded). */
  private batchSending: Promise<void> = Promise.resolve();
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** The copy being uploaded now, if any. */
  uploading: string | null = null;
  /** Uploads failed because the account couldn't be reached. */
  offline = false;
  /** The session ended (signed out elsewhere, or it expired): uploads wait for the user to sign in again. */
  signedOut = false;
  /** Why a copy's last upload failed, by id (cleared by the next that works). */
  readonly failures = new Map<string, string>();

  constructor(
    private readonly host: UploadHost,
    private readonly timing: UploadTiming = { delayMs: 2000, offlineRetryMs: 30_000 },
  ) {}

  /** Whether uploads can't go for now (offline, signed out elsewhere, or no sync). */
  private get waiting(): boolean {
    return !this.host.enabled() || this.offline || this.signedOut;
  }

  /** Adds copies to upload at the next flush. */
  add(...ids: string[]): void {
    for (const id of ids) this.dirty.add(id);
  }

  /** Uploads a copy once editing has paused (`delay`, by default the usual pause). */
  schedule(id: string, delay = this.timing.delayMs): void {
    this.dirty.add(id);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), delay);
  }

  /** Uploads everything waiting, now. Resolves once they have all gone (or can't, for now). */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    // Cleared asynchronously, so an empty queue can't clear it before it's set.
    this.flushing ??= this.drain().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async drain(): Promise<void> {
    // Copies saved during an upload join the set, and are visited too.
    for (const id of this.dirty) {
      if (this.waiting) break;
      if (this.batching.has(id)) continue;
      this.dirty.delete(id);
      await this.upload(id);
    }
  }

  private async upload(id: string): Promise<void> {
    this.uploading = id;
    this.host.changed();
    try {
      await this.host.send(id);
      this.failures.delete(id);
    } catch (e) {
      if (e instanceof CloudError && e.status === 401) {
        this.signedOut = true;
        this.dirty.add(id);
      } else if (e instanceof TypeError) {
        // fetch couldn't reach the server.
        this.dirty.add(id);
        this.wentOffline();
      } else if (e instanceof CloudError && e.status === 402) {
        this.host.noSync();
      } else if (e instanceof CloudError && e.status === 423) {
        // Several people are editing it and the server is saving it: nothing to send from here.
      } else if (e instanceof CloudError) {
        this.failures.set(id, e.message);
      }
      // Anything else: the copy was deleted meanwhile, so there's nothing to send.
    } finally {
      this.uploading = null;
      await this.host.settled(id);
    }
  }

  /** The account can't be reached: uploads wait, and are tried again every so often. */
  wentOffline(): void {
    this.offline = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.host.retry(), this.timing.offlineRetryMs);
  }

  /** The account may be reachable again: uploads may go (the next flush tries). */
  backOnline(): void {
    this.offline = false;
  }

  /** Whether `id` is waiting to be uploaded, or being uploaded now. */
  pending(id: string): boolean {
    return this.dirty.has(id) || this.uploading === id;
  }

  /**
   * Takes copies out of the queue (they are being deleted): none of them starts uploading from now
   * on, and the one uploading now, or the batch sending them, finishes first.
   */
  async forget(ids: Iterable<string>): Promise<void> {
    const gone = new Set(ids);
    let inBatch = false;
    for (const id of gone) {
      this.dirty.delete(id);
      this.failures.delete(id);
      if (this.batching.delete(id)) inBatch = true;
    }
    if (this.uploading !== null && gone.has(this.uploading)) await this.flushing;
    if (inBatch) await this.batchSending;
  }

  /** Stops everything (signing out): nothing more is uploaded. */
  clear(): void {
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    this.dirty.clear();
    this.batching.clear();
  }

  /** Copies to be sent in a batch (by `sendBatch`); queued too, so whatever the batch doesn't take goes the ordinary way. */
  hold(id: string): void {
    this.dirty.add(id);
    this.batching.add(id);
  }

  /** Lets go of held copies without sending them (an import that stopped): they go the ordinary way. */
  release(ids: Iterable<string>): void {
    for (const id of ids) this.batching.delete(id);
  }

  /**
   * Sends held copies in one batch: `send` answers with the ids it uploaded. Those deleted since
   * they were held are left out; those it didn't take stay queued for the ordinary uploads.
   */
  sendBatch(ids: readonly string[], send: (ids: string[]) => Promise<Iterable<string>>): Promise<void> {
    const sending = (async () => {
      const still = ids.filter((id) => this.batching.has(id));
      try {
        if (!still.length || this.waiting) return;
        for (const id of await send(still)) this.dirty.delete(id);
      } catch (e) {
        // Left in the queue: each is sent on its own, which also finds out what is wrong with it.
        if (e instanceof TypeError) this.wentOffline();
      } finally {
        for (const id of still) this.batching.delete(id);
      }
    })();
    this.batchSending = sending;
    return sending;
  }
}
