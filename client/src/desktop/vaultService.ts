// Keeps the vault in step while the app is open: a quick look at the folder every few seconds, or every half minute
// while the window is hidden (a stat-only walk, so no file watcher is needed), a look at the account once a minute and
// when the window is shown again, and a sync whenever either changed. Syncs never overlap. Signed in, the other side is
// the account; signed out, it is the documents saved in this browser (vaultGuest.ts), so the folder works without an account.

import { CloudError } from '../cloud.ts';
import { addPointers, pointerState, writeGuide, type PointerState } from './agentGuide.ts';
import { desktopBridge, type DesktopBridge } from './bridge.ts';
import { ConvertWorker, startConvertWorker } from './convertClient.ts';
import { realHost, sharedApi } from './vaultHost.ts';
import { vaultMemory } from './vaultMemory.ts';
import { excludedFolders, keepsCopy, outsideDisk, setExcludedFolders, sharedRoot, syncShared, type MemoryFor, type SharedSyncReport } from './vaultShared.ts';
import { syncVault, type SyncProgress, type SyncReport, type VaultCodec, type VaultHost } from './vaultSync.ts';

export type VaultState = 'off' | 'signedOut' | 'waiting' | 'syncing' | 'idle' | 'offline' | 'error' | 'access' | 'blocked' | 'wrongAccount';

export interface VaultStatus {
  state: VaultState;
  /** The vault folder, or null when none is chosen. */
  root: string | null;
  lastSync: number | null;
  report: SyncReport | null;
  /** While `syncing`: the step the sync is on, and when it moved to it (a step that lasts for minutes is stuck, and the dialog says so). */
  progress?: SyncProgress & { since: number };
  /** The first error of the last sync (for `access`: why the folder can't be read or written). */
  message?: string;
  /** What the last sync did to the copies of folders shared with this account (vaultShared.ts), when it kept any. */
  shared?: SharedSyncReport | null;
}

/** What the page lends the service. */
export interface VaultHooks {
  /** Resolves once the uploads the page has waiting are done, so documents that were just adopted by an account are there before the vault looks. */
  settled(): Promise<void>;
  /** A sync changed documents (in this browser or the account): the page's list of them is out of date, and so is an editor showing one of `touched` (their ids on that side). */
  changed(touched: string[]): void;
  /** This browser's id for the document open in the editor, if any: the sync leaves its copy to `changed`. */
  openLocalId?(): string | null;
}

/** What the shell answers to a scan while iCloud Drive is still downloading files into the folder (desktop/src-tauri/src/icloud.rs). */
export const ICLOUD_DOWNLOADING = 'icloud-downloading';

const LOOK_MS = 4000;
/** The desktop shell keeps the page's timers running while its window is hidden or the screen is locked, so the vault stays in step then too, at a pace that leaves the battery alone. */
const HIDDEN_LOOK_MS = 30_000;
const ACCOUNT_MS = 60_000;
/** The longest the page's own uploads are waited for before a sync looks anyway. */
const SETTLE_MS = 20_000;
/**
 * A sync that has stayed on one step (one phase, one file) this long is stuck, most likely on a request that will never
 * settle: it is let go of and a new one started. Requests give up on their own after `ANSWER_MS` (cloud.ts), so this is the
 * backstop for whatever else could hang. Without it one stuck sync stops every later one until the app is restarted.
 */
export const STUCK_MS = 10 * 60_000;
/** A sync slower than this is noted in the app's log even when it went well. */
const SLOW_MS = 60_000;

/** Whether a sync that moved to its current step at `since` is stuck at `now`. */
export function syncStuck(since: number, now: number): boolean {
  return now - since >= STUCK_MS;
}

/** Thrown by a sync that was let go of as stuck, at its next step, so it changes nothing more. */
export class SyncAbandoned extends Error {
  constructor() {
    super('the sync was let go of as stuck');
    this.name = 'SyncAbandoned';
  }
}

/** `target`, with every method throwing `SyncAbandoned` once `gone()` is true. */
export function abandonable<T extends object>(target: T, gone: () => boolean): T {
  return new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (gone()) throw new SyncAbandoned();
        return (value as (...a: unknown[]) => unknown).apply(object, args);
      };
    },
  });
}

/** The sync's host, with each part let go of when the sync is (see `abandonable`). */
function abandonableHost(host: VaultHost, gone: () => boolean): VaultHost {
  return {
    ...host,
    disk: abandonable(host.disk, gone),
    memory: abandonable(host.memory, gone),
    cloud: abandonable(host.cloud, gone),
    codec: abandonable(host.codec, gone),
    hash: (bytes) => {
      if (gone()) throw new SyncAbandoned();
      return host.hash(bytes);
    },
  };
}

/** Whether a tick of the timer should look at the folder, `sinceLook` ms after the last look. */
export function lookDue(hidden: boolean, sinceLook: number): boolean {
  return !hidden || sinceLook >= HIDDEN_LOOK_MS;
}

export class VaultService {
  private status: VaultStatus = { state: 'off', root: null, lastSync: null, report: null };
  private listeners = new Set<(status: VaultStatus) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Counts syncs; a sync whose number is no longer the latest was let go of as stuck, and touches nothing more. */
  private generation = 0;
  private wanted = false;
  private signature = '';
  private lastAccountLook = 0;
  private lastLook = 0;
  /** The folder the agent guide was last written to this session (agentGuide.ts): it is written once per folder. */
  private guideRoot: string | null = null;

  /** `account` is the signed-in account (null: none, so the vault keeps the documents saved in this browser). */
  constructor(
    private readonly bridge: DesktopBridge,
    private readonly account: () => string | null,
    private readonly hooks: VaultHooks = { settled: async () => {}, changed: () => {} },
    /** Converts files on another thread; the default starts the page's own worker the first time it is needed. */
    private readonly codec: VaultCodec = new ConvertWorker(startConvertWorker),
  ) {}

  /** The service for this page, or null in a browser (there is no folder to keep). */
  static create(account: () => string | null, hooks: VaultHooks): VaultService | null {
    const bridge = desktopBridge();
    return bridge ? new VaultService(bridge, account, hooks) : null;
  }

  /** Whether the folder is kept with an account (else with the documents saved in this browser). */
  get signedIn(): boolean {
    return this.account() !== null;
  }

  /** The folder is fixed (iCloud Drive on a phone): it cannot be chosen or stopped. */
  get fixed(): boolean {
    return this.bridge.fixed;
  }

  get current(): VaultStatus {
    return this.status;
  }

  subscribe(listener: (status: VaultStatus) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** The outcome of the last sync, as `logOutcome` last saw it. */
  private lastOutcome = 'idle ';

  /**
   * Logs how a sync ended when it ended differently from the one before (so a folder that stays offline or failing is noted
   * once, not every few seconds), or when `notable` (it changed something, or was slow). A quiet idle sync is not logged.
   */
  private logOutcome(outcome: string, notable: boolean, line: () => string): void {
    if (notable || outcome !== this.lastOutcome) this.log(line());
    this.lastOutcome = outcome;
  }

  /** A line in the app's log (desktop only; a shell too old to keep one skips it). */
  private log(text: string): void {
    void this.bridge.log?.(`${new Date().toISOString()} vault: ${text}`);
  }

  private set(patch: Partial<VaultStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.status);
  }

  /** Looks for a remembered folder and starts keeping it. Call again after signing in or out. */
  async start(): Promise<void> {
    const root = await this.bridge.root().catch(() => null);
    this.set({ root });
    this.timer ??= setInterval(() => {
      if (lookDue(document.visibilityState === 'hidden', Date.now() - this.lastLook)) void this.look();
    }, LOOK_MS);
    addEventListener('focus', this.onWake);
    addEventListener('online', this.onWake);
    addEventListener('visibilitychange', this.onShown);
    if (root) this.wanted = true;
    this.log(root ? `keeping ${root} (${this.signedIn ? 'signed in' : 'signed out'})` : 'no folder chosen');
    this.lastAccountLook = 0; // signing in or out changes what the folder is kept with
    this.set({ state: root ? 'waiting' : 'off' });
    void this.look();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    removeEventListener('focus', this.onWake);
    removeEventListener('online', this.onWake);
    removeEventListener('visibilitychange', this.onShown);
  }

  /** A phone only syncs while the app is in front, so coming back to it is when to look (focus doesn't fire there). */
  private onShown = (): void => {
    if (document.visibilityState === 'visible') this.onWake();
  };

  private onWake = (): void => {
    this.lastAccountLook = 0;
    // Back from System Settings: ask again.
    if (this.status.state === 'access') void this.syncNow();
    else void this.look();
  };

  /** Asks for a folder and starts keeping it. Returns false if the person cancelled. */
  async choose(): Promise<boolean> {
    const root = await this.bridge.choose();
    if (!root) return false;
    this.signature = '';
    this.wanted = true;
    this.set({ root, state: 'waiting', report: null, message: undefined });
    void this.syncNow();
    return true;
  }

  /** Starts keeping the folder a new desktop install uses (`GolemDocs` in the home folder). Returns false where there is none. */
  async useDefault(): Promise<boolean> {
    const root = await this.bridge.useDefault();
    if (!root) return false;
    if (root === this.status.root) return true;
    this.signature = '';
    this.wanted = true;
    this.set({ root, state: 'waiting', report: null, message: undefined });
    void this.syncNow();
    return true;
  }

  /** Shows the folder in Finder (Explorer, the file manager). */
  reveal(): Promise<void> {
    return this.bridge.reveal();
  }

  /** Shows a file or folder of the vault (`revealPath`) selected in Finder (File Explorer, the file manager). */
  revealItem(path: string): Promise<void> {
    return this.bridge.revealItem(path);
  }

  /** Asks again, after the person allowed the folder or fixed what was wrong. Macs ask for permission again only after the first refusal is undone in System Settings. */
  async retry(): Promise<void> {
    await this.syncNow();
  }

  /** Opens the system's privacy settings, where a refused folder is allowed. */
  openPrivacy(): Promise<void> {
    return this.bridge.openPrivacy();
  }

  /** Stops using the folder. Its files stay where they are. */
  async forget(): Promise<void> {
    await this.bridge.forget();
    this.wanted = false;
    this.set({ root: null, state: 'off', report: null, message: undefined });
  }

  /** Which instruction files at the top of the folder agents read, and which of them don't point to the app's guide yet. Null with no folder, or on a phone. */
  async agentFiles(): Promise<PointerState | null> {
    if (!this.status.root || this.bridge.fixed) return null;
    return pointerState(this.bridge);
  }

  /**
   * Adds `line` (it names the guide) to the instruction files that lack it, or makes an AGENTS.md with `heading` and the line;
   * the person asked for it in File › Vault Folder. Waits for a running sync, then syncs, so the files reach the account.
   */
  async pointAgents(line: string, heading: string): Promise<string[]> {
    if (!this.status.root || this.bridge.fixed) return [];
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 100));
    // Held like a sync, so none starts halfway through.
    this.running = true;
    let written: string[];
    try {
      await writeGuide(this.bridge);
      written = await addPointers(this.bridge, line, heading);
    } finally {
      this.running = false;
    }
    void this.syncNow();
    return written;
  }

  /** Moves the running sync to a step. The time only restarts when the step changes, so the dialog can tell a long step from progress. */
  private progress(progress: SyncProgress): void {
    const previous = this.status.progress;
    const same = previous?.phase === progress.phase && previous.path === progress.path;
    this.set({ state: 'syncing', progress: { ...progress, since: same ? previous.since : Date.now() } });
  }

  /** What the folder holds, as text that changes when anything in it does: its files, and its folders (an empty one made or removed is a change too). */
  private async fingerprint(): Promise<string> {
    const [files, folders] = await Promise.all([this.bridge.scan(), this.bridge.folders()]);
    return [...files.map((f) => `${f.path}|${f.size}|${f.mtimeMs}`), ...(folders ?? []).map((f) => `${f}/`)].join('\n');
  }

  private async look(): Promise<void> {
    this.lastLook = Date.now();
    const progress = this.status.progress;
    if (this.running && progress && syncStuck(progress.since, Date.now())) {
      this.log(`sync stuck for ${Math.round((Date.now() - progress.since) / 60_000)} min at ${progress.phase}${progress.path ? ` (${progress.path})` : ''}; starting again`);
      this.generation++; // the stuck one throws at its next step and leaves `running` alone
      this.running = false;
      this.set({ progress: undefined });
    }
    // A sync that ended with errors is not started again every few seconds (that would repeat the same failures for ever): it tries again with the next look at the account.
    // A refused folder waits for the person (Try Again, or coming back to the window), not for a retry every few seconds.
    if (!this.wanted || this.running || !this.status.root || this.status.state === 'access') return;
    if (this.status.state === 'waiting' && this.status.message === ICLOUD_DOWNLOADING) return void (await this.syncNow());
    try {
      const local = await this.fingerprint();
      const due = Date.now() - this.lastAccountLook >= ACCOUNT_MS;
      if (local !== this.signature || due || this.status.state === 'offline') await this.syncNow();
    } catch {
      await this.syncNow(); // the folder was moved or is unreadable: the sync checks it and says why
    }
  }

  /** Runs one sync now. `allowMassDelete` is for after the person confirmed a plan that was held back. */
  async syncNow(options: { allowMassDelete?: boolean } = {}): Promise<void> {
    const root = this.status.root;
    if (this.running || !root) return;
    this.running = true;
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    const started = Date.now();
    this.progress({ phase: 'access' });
    try {
      try {
        await this.bridge.check();
      } catch (error) {
        if (!current()) return;
        this.set({ state: 'access', progress: undefined, message: error instanceof Error ? error.message : String(error) }); // the shell rejects with a string
        return;
      }
      // Files still coming down from iCloud Drive: wait, and the next look tries again.
      try {
        await this.bridge.scan();
      } catch (error) {
        if (!current()) return;
        if (String(error) === ICLOUD_DOWNLOADING) {
          this.set({ state: 'waiting', progress: undefined, message: ICLOUD_DOWNLOADING });
          return;
        }
      }
      if (this.account()) {
        this.progress({ phase: 'uploads' });
        // Uploads that never finish (offline, a failing save) must not keep the vault from looking.
        await Promise.race([this.hooks.settled(), new Promise((resolve) => setTimeout(resolve, SETTLE_MS))]);
      }
      if (!current()) return;
      const account = this.account(); // signing out can happen while waiting
      const gone = () => !current();
      const real = realHost(root, this.bridge, this.codec, account, () => this.hooks.openLocalId?.() ?? null);
      // Copies of folders shared with this account are kept apart (vaultShared.ts): the vault's own sync never sees them.
      const memoryFor: MemoryFor = (name) => vaultMemory(`${root}\n${name}`);
      const copies = account ? await sharedRoot(memoryFor).catch(() => null) : null;
      if (!current()) return;
      if (copies) real.disk = outsideDisk(real.disk, copies);
      const host = abandonableHost(real, gone);
      const report = await syncVault(host, { ...options, progress: (p) => current() && this.progress(p) });
      if (!current()) return;
      let shared: SharedSyncReport | null = null;
      if (account && !report.wrongAccount && !report.blocked) {
        try {
          shared = await syncShared({ disk: abandonable(this.bridge, gone), memory: memoryFor, api: sharedApi(), codec: this.codec, hash: host.hash, account, wanted: keepsCopy, excluded: excludedFolders, setExcluded: setExcludedFolders });
          for (const { label, report: copy } of shared.copies) {
            report.errors.push(...copy.errors.map((e) => ({ ...e, message: `${shared!.root}/${label}: ${e.message}` })));
            for (const key of ['downloaded', 'uploaded', 'created', 'renamed', 'movedHere', 'deletedHere', 'trashed', 'foldersRemoved', 'foldersMade'] as const) report[key] += copy[key];
          }
        } catch (error) {
          if (error instanceof SyncAbandoned) throw error;
          // The shares could not be listed (offline, say): the copies are left as they are until the next sync.
        }
        if (!current()) return;
      }
      // What the sync itself wrote is not a change to sync again.
      const signature = await this.fingerprint();
      if (!current()) return;
      this.signature = signature;
      // The guide for ai apps, once the folder is known to be this account's. A phone keeps `.golemdocs/` outside the shared folder, where no agent would see it.
      if (!report.wrongAccount && !this.bridge.fixed && this.guideRoot !== root) {
        this.guideRoot = root;
        await writeGuide(this.bridge).catch(() => (this.guideRoot = null));
      }
      this.lastAccountLook = Date.now();
      // Signed out, a folder that belongs to an account waits for that account to sign in.
      const state: VaultState = report.wrongAccount ? (account ? 'wrongAccount' : 'signedOut') : report.blocked ? 'blocked' : report.errors.length ? 'error' : 'idle';
      this.set({ state, report, shared, progress: undefined, lastSync: Date.now(), message: report.errors[0]?.message });
      const changes = report.downloaded + report.uploaded + report.created + report.renamed + report.movedHere + report.deletedHere + report.trashed + report.foldersRemoved + report.foldersMade;
      const took = Date.now() - started;
      this.logOutcome(`${state} ${report.errors[0]?.message ?? ''}`, changes > 0 || took >= SLOW_MS, () => `sync ${state} in ${Math.round(took / 1000)} s: ${changes} change(s)${report.errors.length ? `, ${report.errors.length} error(s), first: ${report.errors[0].message}` : ''}`);
      if (changes > 0) this.hooks.changed(report.touched);
    } catch (error) {
      if (!current() || error instanceof SyncAbandoned) return;
      const offline = error instanceof TypeError || (error instanceof CloudError && error.status >= 500);
      const reason = error instanceof Error ? error.message : String(error);
      this.logOutcome(`failed ${reason}`, false, () => `sync failed after ${Math.round((Date.now() - started) / 1000)} s: ${reason}`);
      this.set({ progress: undefined, state: offline ? 'offline' : error instanceof CloudError && error.status === 401 ? 'signedOut' : 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (current()) this.running = false;
    }
  }
}
