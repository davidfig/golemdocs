// Scripts in the app (docs/live-blocks.md §8): the vault as scripts see it, producers for live blocks, actions run by hand,
// by a button, when a document changes or on a schedule, their log and Undo this run. The runner and the sandbox are in the
// live chunk, loaded the first time a script runs; this part is small and always there, since it has to notice triggers.
//
// main.ts gives it the library (`ScriptsHost`); everything else is here.

import type { LiveResult } from '../live/result.ts';
import { isScriptSource } from '../live/scriptAddress.ts';
import { covers, grantOf } from '@golemdocs/script/grants';
import type { GrantStore, ScriptGrant } from '@golemdocs/script/grants';
import { normalizeFolder, within } from '@golemdocs/script/host';
import type { RuntimeChannel, ScriptMeta } from '@golemdocs/script/host';
import type { ScriptRunner } from './runner.ts';
import type { ScriptFetch, ScriptResponse } from '@golemdocs/script/fetch';
import type { ChangedFile, ScriptVault, VaultFile } from './vault.ts';
import { scriptState } from './state.ts';
import { t } from '../i18n/index.ts';
import type { ScriptRun } from './state.ts';

/** A document in the vault, by its key in the library and its path (`Books/Dune.md`). */
export interface VaultDocument {
  key: string;
  path: string;
}

export interface ScriptsHost {
  /** Every document this device has, with its path. */
  documents(): VaultDocument[];
  read(key: string): Promise<Uint8Array | null>;
  /** What a live block of this address shows (a sheet's range), its path from the top of the vault. */
  produce(address: string): Promise<LiveResult>;
  /** Saves the open document, so an action reads what is on screen. */
  saveOpen(): Promise<void>;
  /** Stores a document's new bytes (made, with its folders, when `key` is null); its key. */
  store(path: string, bytes: Uint8Array, key: string | null): Promise<string>;
  /** Fetches from a site for an action (no cookies, no redirects). */
  fetch(url: string, init: ScriptFetch): Promise<ScriptResponse>;
  /** Removes a document an undone run made. */
  remove(key: string): Promise<void>;
  /** Claims a scheduled run for this device (true: run it; false: another has it), or marks it done. Throws when it got no answer. */
  claim(run: string, done: boolean): Promise<boolean>;
  /** Asks whether a script may run as it asks to; null when the person says no. */
  ask(path: string, meta: ScriptMeta): Promise<'once' | 'always' | null>;
  status(text: string): void;
  error(text: string): void;
  /** Says things in the person's language. */
  say: {
    running(name: string): string;
    ran(name: string, count: number, message: string | null): string;
    failed(name: string, message: string): string;
    paused(name: string): string;
    off(name: string): string;
    undone(name: string): string;
    undoChanged(path: string): string;
    undoGone(): string;
  };
}

/** A chain of actions, each changing what the next watches, stops here (docs/live-blocks.md §8). */
const MAX_CHAIN = 10;
const SCHEDULE_TICK_MS = 60_000;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** When a schedule was last due at or before `now` (local time); null for a schedule it can't read. */
export function lastDue(trigger: NonNullable<ScriptMeta['trigger']>, now: Date): Date | null {
  const at = (time: string, day: Date) => {
    const [h, m] = time.split(':').map(Number);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
  };
  const dues: Date[] = [];
  if (trigger.daily) {
    const today = at(trigger.daily, now);
    dues.push(today <= now ? today : at(trigger.daily, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)));
  }
  if (trigger.weekly) {
    const [day, time] = trigger.weekly.split(/\s+/);
    const weekday = DAYS.indexOf(day.slice(0, 3));
    if (weekday >= 0 && time) {
      for (let back = 0; back <= 7; back++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
        if (d.getDay() !== weekday) continue;
        const due = at(time, d);
        if (due <= now) {
          dues.push(due);
          break;
        }
      }
    }
  }
  return dues.length ? new Date(Math.max(...dues.map((d) => d.getTime()))) : null;
}

/** A run's id for claiming: the script's path and when it was due, in local time to the minute. */
export const runId = (path: string, due: Date): string =>
  `${path}@${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}T${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`;

export class ScriptsApp {
  private runner: Promise<ScriptRunner> | null = null;
  /** Allowed once, for this page. */
  private readonly onceAllowed = new Map<string, ScriptGrant>();
  /** Each script's meta, by a hash of its text. */
  private readonly metas = new Map<string, { hash: number; meta: ScriptMeta | null; error?: string }>();
  /** Documents an action just wrote, and how far down a chain it was: their saves don't start it again. */
  private readonly writtenBy = new Map<string, { script: string; depth: number }>();
  /** While an action's file is being stored: the saves reported meanwhile (see `storeFor`). */
  private storing: string[] | null = null;
  private changedKeys = new Map<string, number>();
  private changedTimer: ReturnType<typeof setTimeout> | null = null;
  private ticking: ReturnType<typeof setInterval> | null = null;
  /** Producers already asked about on this page (a block names one again on each check). */
  private readonly askedForBlocks = new Set<string>();
  /** One question at a time: a note with several blocks asks about each in turn. */
  private asking: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: ScriptsHost,
    /** Where scripts run: the sandboxed frame unless a test gives a Node worker. */
    private readonly channel?: () => RuntimeChannel,
  ) {}

  private readonly grants: GrantStore = {
    get: (path) => this.onceAllowed.get(path) ?? scriptState.grants.get(path),
    set: (path, grant) => scriptState.grants.set(path, grant),
  };

  private vault(): ScriptVault {
    const fileOf = async (doc: VaultDocument): Promise<VaultFile | null> => {
      const bytes = await this.host.read(doc.key);
      return bytes ? { path: doc.path, bytes } : null;
    };
    return {
      list: async (folder) => {
        const f = normalizeFolder(folder);
        const docs = this.host.documents().filter((d) => within(d.path, [f]) && d.path !== f);
        if (f && !docs.length) return null;
        return (await Promise.all(docs.map(fileOf))).filter((x): x is VaultFile => x !== null);
      },
      file: async (path) => {
        const doc = this.find(path);
        return doc ? fileOf(doc) : null;
      },
      produce: (address) => this.host.produce(address),
      fetch: (url, init) => this.host.fetch(url, init),
    };
  }

  private find(path: string): VaultDocument | undefined {
    const p = normalizeFolder(path).toLowerCase();
    return this.host.documents().find((d) => d.path.toLowerCase() === p);
  }

  private load(): Promise<ScriptRunner> {
    return (this.runner ??= import('../live/stored.ts').then(({ ScriptRunner, sandboxChannel }) => new ScriptRunner({ vault: this.vault(), channel: this.channel ?? sandboxChannel, grants: this.grants, ask: (path, meta) => this.host.ask(path, meta) })));
  }

  /** The vault's scripts, by path. */
  scriptPaths(): string[] {
    return this.host
      .documents()
      .map((d) => d.path)
      .filter(isScriptSource)
      .sort();
  }

  /** A script's meta, read by running it as far as its `meta` (kept until its text changes). */
  async meta(path: string): Promise<{ meta: ScriptMeta | null; error?: string }> {
    const doc = this.find(path);
    const bytes = doc ? await this.host.read(doc.key) : null;
    if (!bytes) return { meta: null, error: path };
    let hash = 0;
    for (let i = 0; i < bytes.length; i += 1) hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0;
    const known = this.metas.get(path);
    if (known && known.hash === hash) return known;
    const found = await (await this.load()).describe(path).then(
      (meta) => ({ hash, meta }),
      (e: unknown) => ({ hash, meta: null, error: (e as Error).message }),
    );
    this.metas.set(path, found);
    return found;
  }

  /** Every script and its meta (Tools › Scripts). */
  async listing(): Promise<{ path: string; meta: ScriptMeta | null; error?: string }[]> {
    return Promise.all(this.scriptPaths().map(async (path) => ({ path, ...(await this.meta(path)) })));
  }

  // --- Producers ---------------------------------------------------------------------------------

  /** A producer's result for a block (never asks: a block updates in the background). */
  async produce(path: string): Promise<LiveResult> {
    const p = normalizeFolder(path);
    if (!scriptState.runs(p)) return { kind: 'error', code: 'script', detail: this.host.say.off(p) };
    const runner = await this.load();
    const result = await runner.produce(p);
    scriptState.setReads(p, runner.reads(p));
    return result;
  }

  /** What a producer's last run read (for the keeper; kept across reloads). */
  reads(path: string): readonly string[] {
    return scriptState.readsOf(normalizeFolder(path));
  }

  /**
   * A block in the open document names a producer not allowed here: ask, once per page. Resolves true when it may run
   * now (so the document is checked again).
   */
  askForBlock(path: string): Promise<boolean> {
    const p = normalizeFolder(path);
    if (this.askedForBlocks.has(p)) return Promise.resolve(false);
    this.askedForBlocks.add(p);
    const asked = this.asking.then(() => this.askOne(p));
    this.asking = asked.catch(() => undefined);
    return asked;
  }

  private async askOne(p: string): Promise<boolean> {
    const { meta } = await this.meta(p);
    if (!meta || meta.writes.length) return false;
    const answer = await this.host.ask(p, meta);
    if (answer === 'always') scriptState.grants.set(p, grantOf(meta));
    else if (answer === 'once') this.onceAllowed.set(p, grantOf(meta));
    return answer !== null;
  }

  /** A button block's label: its action's name; missing when the vault has no such script (it then runs nothing). */
  async button(path: string): Promise<LiveResult> {
    const p = normalizeFolder(path);
    if (!this.find(p)) return { kind: 'error', code: 'missing', detail: p };
    const { meta, error } = await this.meta(p);
    return meta ? { kind: 'value', text: meta.name } : { kind: 'error', code: 'script', detail: error ?? p };
  }

  // --- Actions -----------------------------------------------------------------------------------

  /** Runs an action; `depth` is how far down a chain of changes it is. */
  async act(path: string, by: ScriptRun['by'], depth = 0): Promise<ScriptRun | null> {
    const p = normalizeFolder(path);
    const name = this.metas.get(p)?.meta?.name ?? p;
    if (!scriptState.runs(p)) {
      if (by === 'hand' || by === 'button') this.host.error(this.host.say.off(name));
      return null;
    }
    const interactive = by === 'hand' || by === 'button';
    if (interactive) this.host.status(this.host.say.running(name));
    await this.host.saveOpen();
    const runner = await this.load();
    let files: ChangedFile[] = [];
    try {
      let outcome = await runner.act(p, { interactive });
      // A document changed while it ran: its edits were made to what it read. It runs once more on what is there now,
      // without asking again; if one changes again, nothing is written.
      let changed = await this.changedSince(outcome.files);
      if (changed) {
        outcome = await runner.act(p, { allowed: grantOf(outcome.meta) });
        changed = await this.changedSince(outcome.files);
        if (changed) throw new Error(t('scripts.vault.changedWhileRunning', { path: changed, name: outcome.meta.name }));
      }
      files = outcome.files;
      for (const file of files) await this.storeFor(p, depth, file.path, file.after);
      const { run } = scriptState.ran({ path: p, name: outcome.meta.name, by, ok: true, ...(outcome.message && { message: outcome.message }), changed: files.map((f) => ({ path: f.path, made: f.before === null })) }, files);
      if (interactive || files.length) this.host.status(this.host.say.ran(outcome.meta.name, files.length, outcome.message));
      return run;
    } catch (e) {
      const message = (e as Error).message;
      const refused = (e as { code?: string }).code === 'denied';
      // Not allowed, or the person said no: not a failure of the script.
      if (refused) {
        if (interactive) this.host.error(this.host.say.failed(name, message));
        return null;
      }
      const { run, paused } = scriptState.ran({ path: p, name, by, ok: false, message });
      this.host.error(paused ? this.host.say.paused(name) : this.host.say.failed(name, message));
      return run;
    }
  }

  /**
   * Stores a file an action wrote, marked as that action's. The store reports the save (`saved`) before it returns the
   * document's key, so saves reported meanwhile wait until the key is known: otherwise the action's own save would look like
   * anyone's, start it again and never count toward `MAX_CHAIN`.
   */
  private async storeFor(script: string, depth: number, path: string, bytes: Uint8Array): Promise<string> {
    this.storing = [];
    let key: string | null = null;
    try {
      key = await this.host.store(path, bytes, this.find(path)?.key ?? null);
      this.writtenBy.set(key, { script, depth });
      return key;
    } finally {
      const waiting = this.storing;
      this.storing = null;
      for (const k of waiting) this.saved(k);
      // Not reported by the store (a host that doesn't): no mark left behind for another save to use up.
      if (key !== null && !waiting.includes(key)) this.writtenBy.delete(key);
    }
  }

  /** The first of an action's files that is no longer what it read (made, removed or changed meanwhile), or null. */
  private async changedSince(files: readonly ChangedFile[]): Promise<string | null> {
    for (const file of files) {
      const doc = this.find(file.path);
      const now = doc ? await this.host.read(doc.key) : null;
      if ((now === null) !== (file.before === null) || (now && file.before && !sameBytes(now, file.before))) return file.path;
    }
    return null;
  }

  /** Puts back what a run changed, where nothing has changed it since. */
  async undo(run: ScriptRun): Promise<void> {
    const kept = scriptState.undoFor(run.id);
    if (!kept) throw new Error(this.host.say.undoGone());
    const skipped: string[] = [];
    for (const [path, { before, after }] of kept) {
      const doc = this.find(path);
      const now = doc ? await this.host.read(doc.key) : null;
      if (!doc || !now || !sameBytes(now, after)) {
        skipped.push(path);
        continue;
      }
      if (before) await this.host.store(path, before, doc.key);
      else await this.host.remove(doc.key);
      kept.delete(path);
    }
    // Only a run whose every file went back counts as undone; the files changed since keep what would put them back.
    if (!kept.size) scriptState.undone(run.id);
    if (skipped.length) throw new Error(skipped.map((p) => this.host.say.undoChanged(p)).join(' '));
    this.host.status(this.host.say.undone(run.name));
  }

  canUndo(run: ScriptRun): boolean {
    return scriptState.undoFor(run.id) !== null;
  }

  // --- Triggers ----------------------------------------------------------------------------------

  /** A document was saved (here, or synced from elsewhere): actions watching its folder run once things settle. */
  saved(key: string): void {
    if (this.storing) {
      this.storing.push(key);
      return;
    }
    const by = this.writtenBy.get(key);
    this.writtenBy.delete(key);
    this.changedKeys.set(key, Math.max(this.changedKeys.get(key) ?? 0, by ? by.depth + 1 : 0));
    if (by) this.changedKeys.set(`${key}\u0000${by.script}`, -1); // not the script that wrote it
    if (this.changedTimer) clearTimeout(this.changedTimer);
    this.changedTimer = setTimeout(() => void this.runChanged().catch((e: unknown) => console.error(e)), 2_000);
  }

  private async runChanged(): Promise<void> {
    const keys = this.changedKeys;
    this.changedKeys = new Map();
    const docs = this.host.documents();
    const changed = [...keys].filter(([k, depth]) => depth >= 0 && !k.includes('\u0000')).map(([key, depth]) => ({ doc: docs.find((d) => d.key === key), depth }));
    for (const path of this.scriptPaths()) {
      if (!scriptState.runs(path)) continue;
      const { meta } = await this.meta(path).catch(() => ({ meta: null }));
      const folder = meta?.trigger?.changed;
      if (!meta || folder === undefined || !covers(scriptState.grants.get(path), meta)) continue;
      const hits = changed.filter(({ doc }) => doc && !isScriptSource(doc.path) && within(doc.path, [folder]) && !keys.has(`${doc.key}\u0000${path}`));
      if (!hits.length) continue;
      const depth = Math.max(...hits.map((h) => h.depth));
      if (depth >= MAX_CHAIN) {
        scriptState.ran({ path, name: meta.name, by: 'changed', ok: false, message: `stopped after ${MAX_CHAIN} actions in a row changed each other's files` });
        continue;
      }
      await this.act(path, 'changed', depth);
    }
  }

  /** Starts checking schedules: now, then every minute. */
  startSchedules(): void {
    if (this.ticking) return;
    this.ticking = setInterval(() => void this.tick().catch((e: unknown) => console.error(e)), SCHEDULE_TICK_MS);
    void this.tick().catch((e: unknown) => console.error(e));
  }

  /** Runs every scheduled action that is due and not yet run (by any device), once. */
  async tick(now = new Date()): Promise<void> {
    for (const path of this.scriptPaths()) {
      if (!scriptState.runs(path)) continue;
      const record = scriptState.record(path);
      if (!record.grant) continue; // a device with no answer yet leaves it to one that has
      const { meta } = await this.meta(path).catch(() => ({ meta: null }));
      if (!meta?.trigger || !(meta.trigger.daily || meta.trigger.weekly) || !covers(record.grant, meta)) continue;
      const due = lastDue(meta.trigger, now);
      if (!due) continue;
      const id = runId(path, due);
      const last = scriptState.lastScheduled(path);
      // Allowed after it was due: from the next one on.
      if (last === null) {
        scriptState.setScheduled(path, id);
        continue;
      }
      if (last === id) continue;
      // Claimed by a device, this one or another: settled. With no answer it stays due, for the next tick.
      const claimed = await this.host.claim(id, false).catch(() => null);
      if (claimed === null) continue;
      scriptState.setScheduled(path, id);
      if (!claimed) continue;
      await this.act(path, 'schedule');
      await this.host.claim(id, true).catch(() => undefined);
    }
  }
}

