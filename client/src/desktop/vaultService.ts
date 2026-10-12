// Keeps the vault in step while the app is open: a quick look at the folder every few seconds (a stat-only walk, so
// no file watcher is needed), a look at the account once a minute and when the window is shown again, and a sync
// whenever either changed. Syncs never overlap.

import { CloudError } from '../cloud.ts';
import { desktopBridge, type DesktopBridge } from './bridge.ts';
import { ConvertWorker, startConvertWorker } from './convertClient.ts';
import { realHost } from './vaultHost.ts';
import { syncVault, type SyncReport, type VaultCodec } from './vaultSync.ts';

export type VaultState = 'off' | 'signedOut' | 'waiting' | 'syncing' | 'idle' | 'offline' | 'error' | 'blocked' | 'wrongAccount';

export interface VaultStatus {
  state: VaultState;
  /** The vault folder, or null when none is chosen. */
  root: string | null;
  lastSync: number | null;
  report: SyncReport | null;
  /** The first error of the last sync. */
  message?: string;
}

const LOOK_MS = 4000;
const ACCOUNT_MS = 60_000;

export class VaultService {
  private status: VaultStatus = { state: 'off', root: null, lastSync: null, report: null };
  private listeners = new Set<(status: VaultStatus) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private wanted = false;
  private signature = '';
  private lastAccountLook = 0;

  /** `account` is the signed-in account that syncs (null: none, so no vault). */
  constructor(
    private readonly bridge: DesktopBridge,
    private readonly account: () => string | null,
    /** Converts files on another thread; the default starts the page's own worker the first time it is needed. */
    private readonly codec: VaultCodec = new ConvertWorker(startConvertWorker),
  ) {}

  /** The service for this page, or null in a browser (there is no folder to keep). */
  static create(account: () => string | null): VaultService | null {
    const bridge = desktopBridge();
    return bridge ? new VaultService(bridge, account) : null;
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
    if (root) this.wanted = true;
    this.set({ state: !root ? 'off' : this.account() ? 'waiting' : 'signedOut' });
    void this.look();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    removeEventListener('focus', this.onWake);
    removeEventListener('online', this.onWake);
  }

  private onWake = (): void => {
    this.lastAccountLook = 0;
    void this.look();
  };

  /** Asks for a folder and starts keeping it. Returns false if the person cancelled. */
  async choose(): Promise<boolean> {
    const root = await this.bridge.choose();
    if (!root) return false;
    this.signature = '';
    this.wanted = true;
    this.set({ root, state: this.account() ? 'waiting' : 'signedOut', report: null, message: undefined });
    void this.syncNow();
    return true;
  }

  /** Stops using the folder. Its files stay where they are. */
  async forget(): Promise<void> {
    await this.bridge.forget();
    this.wanted = false;
    this.set({ root: null, state: 'off', report: null, message: undefined });
  }

  private async look(): Promise<void> {
    if (!this.wanted || this.running || !this.status.root || !this.account()) return;
    try {
      const local = (await this.bridge.scan()).map((f) => `${f.path}|${f.size}|${f.mtimeMs}`).join('\n');
      const due = Date.now() - this.lastAccountLook >= ACCOUNT_MS;
      if (local !== this.signature || due || this.status.state === 'offline' || this.status.state === 'error') await this.syncNow();
    } catch {
      /* the folder was moved or is unreadable: the next sync says so */
    }
  }

  /** Runs one sync now. `allowMassDelete` is for after the person confirmed a plan that was held back. */
  async syncNow(options: { allowMassDelete?: boolean } = {}): Promise<void> {
    const account = this.account();
    if (this.running || !this.status.root) return;
    if (!account) return void this.set({ state: 'signedOut' });
    this.running = true;
    this.set({ state: 'syncing' });
    try {
      const report = await syncVault(realHost(this.bridge, this.codec, account), options);
      // What the sync itself wrote is not a change to sync again.
      this.signature = (await this.bridge.scan()).map((f) => `${f.path}|${f.size}|${f.mtimeMs}`).join('\n');
      this.lastAccountLook = Date.now();
      const state: VaultState = report.wrongAccount ? 'wrongAccount' : report.blocked ? 'blocked' : report.errors.length ? 'error' : 'idle';
      this.set({ state, report, lastSync: Date.now(), message: report.errors[0]?.message });
    } catch (error) {
      const offline = error instanceof TypeError || (error instanceof CloudError && error.status >= 500);
      this.set({ state: offline ? 'offline' : error instanceof CloudError && error.status === 401 ? 'signedOut' : 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.running = false;
    }
  }
}
