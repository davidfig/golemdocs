// Keeps the vault in step while the app is open: a quick look at the folder every few seconds (a stat-only walk, so
// no file watcher is needed), a look at the account once a minute and when the window is shown again, and a sync
// whenever either changed. Syncs never overlap. Signed in, the other side is the account; signed out, it is the documents
// saved in this browser (vaultGuest.ts), so the folder works without an account.

import { CloudError } from '../cloud.ts';
import { desktopBridge, type DesktopBridge } from './bridge.ts';
import { ConvertWorker, startConvertWorker } from './convertClient.ts';
import { realHost } from './vaultHost.ts';
import { syncVault, type SyncProgress, type SyncReport, type VaultCodec } from './vaultSync.ts';

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
}

/** What the page lends the service. */
export interface VaultHooks {
  /** Resolves once the uploads the page has waiting are done, so documents that were just adopted by an account are there before the vault looks. */
  settled(): Promise<void>;
  /** A sync changed documents (in this browser or the account): the page's list of them is out of date, and so is an editor showing one of `touched` (their ids on that side). */
  changed(touched: string[]): void;
}

/** What the shell answers to a scan while iCloud Drive is still downloading files into the folder (desktop/src-tauri/src/icloud.rs). */
export const ICLOUD_DOWNLOADING = 'icloud-downloading';

const LOOK_MS = 4000;
const ACCOUNT_MS = 60_000;
/** The longest the page's own uploads are waited for before a sync looks anyway. */
const SETTLE_MS = 20_000;

export class VaultService {
  private status: VaultStatus = { state: 'off', root: null, lastSync: null, report: null };
  private listeners = new Set<(status: VaultStatus) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private wanted = false;
  private signature = '';
  private lastAccountLook = 0;

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

  private set(patch: Partial<VaultStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.status);
  }

  /** Looks for a remembered folder and starts keeping it. Call again after signing in or out. */
  async start(): Promise<void> {
    const root = await this.bridge.root().catch(() => null);
    this.set({ root });
    this.timer ??= setInterval(() => void this.look(), LOOK_MS);
    addEventListener('focus', this.onWake);
    addEventListener('online', this.onWake);
    addEventListener('visibilitychange', this.onShown);
    if (root) this.wanted = true;
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

  /** Shows the folder in Finder (Explorer, the file manager). */
  reveal(): Promise<void> {
    return this.bridge.reveal();
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

  /** Moves the running sync to a step. The time only restarts when the step changes, so the dialog can tell a long step from progress. */
  private progress(progress: SyncProgress): void {
    const previous = this.status.progress;
    const same = previous?.phase === progress.phase && previous.path === progress.path;
    this.set({ state: 'syncing', progress: { ...progress, since: same ? previous.since : Date.now() } });
  }

  private async look(): Promise<void> {
    // A sync that ended with errors is not started again every few seconds (that would repeat the same failures for ever): it tries again with the next look at the account.
    // A refused folder waits for the person (Try Again, or coming back to the window), not for a retry every few seconds.
    if (!this.wanted || this.running || !this.status.root || this.status.state === 'access') return;
    if (this.status.state === 'waiting' && this.status.message === ICLOUD_DOWNLOADING) return void (await this.syncNow());
    try {
      const local = (await this.bridge.scan()).map((f) => `${f.path}|${f.size}|${f.mtimeMs}`).join('\n');
      const due = Date.now() - this.lastAccountLook >= ACCOUNT_MS;
      if (local !== this.signature || due || this.status.state === 'offline') await this.syncNow();
    } catch {
      await this.syncNow(); // the folder was moved or is unreadable: the sync checks it and says why
    }
  }

  /** Runs one sync now. `allowMassDelete` is for after the person confirmed a plan that was held back. */
  async syncNow(options: { allowMassDelete?: boolean } = {}): Promise<void> {
    if (this.running || !this.status.root) return;
    this.running = true;
    this.progress({ phase: 'access' });
    try {
      try {
        await this.bridge.check();
      } catch (error) {
        this.set({ state: 'access', progress: undefined, message: error instanceof Error ? error.message : String(error) }); // the shell rejects with a string
        return;
      }
      // Files still coming down from iCloud Drive: wait, and the next look tries again.
      try {
        await this.bridge.scan();
      } catch (error) {
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
      const account = this.account(); // signing out can happen while waiting
      const report = await syncVault(realHost(this.bridge, this.codec, account), { ...options, progress: (p) => this.progress(p) });
      // What the sync itself wrote is not a change to sync again.
      this.signature = (await this.bridge.scan()).map((f) => `${f.path}|${f.size}|${f.mtimeMs}`).join('\n');
      this.lastAccountLook = Date.now();
      // Signed out, a folder that belongs to an account waits for that account to sign in.
      const state: VaultState = report.wrongAccount ? (account ? 'wrongAccount' : 'signedOut') : report.blocked ? 'blocked' : report.errors.length ? 'error' : 'idle';
      this.set({ state, report, progress: undefined, lastSync: Date.now(), message: report.errors[0]?.message });
      if (report.downloaded + report.uploaded + report.created + report.renamed + report.movedHere + report.deletedHere + report.trashed > 0) this.hooks.changed(report.touched);
    } catch (error) {
      const offline = error instanceof TypeError || (error instanceof CloudError && error.status >= 500);
      this.set({ progress: undefined, state: offline ? 'offline' : error instanceof CloudError && error.status === 401 ? 'signedOut' : 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.running = false;
    }
  }
}
