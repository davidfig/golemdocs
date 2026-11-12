// What this device remembers about scripts (docs/live-blocks.md §8, *Permissions and trust*): what each was allowed, whether
// it is turned off or paused after failing, and its last runs. Kept in browser storage and never synced (not in
// settingsSync.ts's keys): a script synced from another device asks again here.
//
// The log keeps what each action changed for as long as the page is open, so "Undo this run" can put the files back;
// once the page is closed the entries remain as a record, and undoing points to the files' version history.

import type { ScriptGrant } from './grants.ts';

const KEY = 'golem.scripts.v1';

/** A script fails this many times in a row and is paused until turned back on. */
export const PAUSE_AFTER = 3;
const LOG_SIZE = 50;

export interface ScriptRecord {
  grant: ScriptGrant | null;
  /** Turned off by the person: never runs, by trigger, block or button. */
  off?: boolean;
  /** Failed PAUSE_AFTER times in a row; runs again once turned back on. */
  paused?: boolean;
  failures?: number;
}

export interface ScriptRun {
  id: string;
  path: string;
  name: string;
  /** When it ran, ISO. */
  at: string;
  /** What started it: by hand, a button, a trigger. */
  by: 'hand' | 'button' | 'changed' | 'schedule' | 'block';
  ok: boolean;
  /** The error, or what the script said. */
  message?: string;
  /** The documents it changed (vault paths), and whether it made each. */
  changed?: { path: string; made: boolean }[];
  undone?: boolean;
}

interface Stored {
  scripts: Record<string, ScriptRecord>;
  log: ScriptRun[];
  /** What each producer's last run read (so its blocks are updated when one changes, after a reload too). */
  reads?: Record<string, string[]>;
  /** The last scheduled run of each action this device has seen through (its run id). */
  scheduled?: Record<string, string>;
  /** This device, for claiming scheduled runs. */
  device?: string;
}

function load(): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Stored | null;
    if (raw && typeof raw === 'object' && raw.scripts && Array.isArray(raw.log)) return raw;
  } catch {
    // Unreadable: start again (nothing is allowed, which only means being asked again).
  }
  return { scripts: {}, log: [] };
}

function save(state: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked: kept for this page only.
  }
}

/** The before-bytes of this page's runs, by run id and path, for Undo this run. */
const undoBytes = new Map<string, Map<string, { before: Uint8Array | null; after: Uint8Array }>>();

export const scriptState = {
  record(path: string): ScriptRecord {
    return load().scripts[path] ?? { grant: null };
  },
  all(): Record<string, ScriptRecord> {
    return load().scripts;
  },
  update(path: string, change: (record: ScriptRecord) => ScriptRecord | null): void {
    const state = load();
    const next = change(state.scripts[path] ?? { grant: null });
    if (next && (next.grant || next.off || next.paused || next.failures)) state.scripts[path] = next;
    else delete state.scripts[path];
    save(state);
  },
  /** The store the runner keeps grants in. */
  grants: {
    get: (path: string): ScriptGrant | null => scriptState.record(path).grant,
    set: (path: string, grant: ScriptGrant | null): void => scriptState.update(path, (r) => ({ ...r, grant })),
  },
  /** Whether it may run at all now (not turned off or paused). */
  runs(path: string): boolean {
    const r = scriptState.record(path);
    return !r.off && !r.paused;
  },
  /** A run ended: logged, and its failures counted (the third in a row pauses it). Returns whether that paused it. */
  ran(run: Omit<ScriptRun, 'id' | 'at'>, files?: readonly { path: string; before: Uint8Array | null; after: Uint8Array }[]): { run: ScriptRun; paused: boolean } {
    const state = load();
    const entry: ScriptRun = { ...run, id: crypto.randomUUID(), at: new Date().toISOString() };
    state.log = [entry, ...state.log].slice(0, LOG_SIZE);
    const record = state.scripts[run.path] ?? { grant: null };
    const failures = run.ok ? 0 : (record.failures ?? 0) + 1;
    const paused = !run.ok && failures >= PAUSE_AFTER && !record.paused;
    state.scripts[run.path] = { ...record, failures, paused: record.paused || paused };
    save(state);
    if (files?.length) undoBytes.set(entry.id, new Map(files.map((f) => [f.path, { before: f.before, after: f.after }])));
    return { run: entry, paused };
  },
  /** What a producer's last run read, as the keeper needs it. */
  readsOf(path: string): readonly string[] {
    return load().reads?.[path] ?? [];
  },
  setReads(path: string, reads: readonly string[]): void {
    const state = load();
    const was = state.reads?.[path] ?? [];
    if (was.length === reads.length && was.every((r, i) => r === reads[i])) return;
    state.reads = { ...state.reads, [path]: [...reads] };
    save(state);
  },
  lastScheduled(path: string): string | null {
    return load().scheduled?.[path] ?? null;
  },
  setScheduled(path: string, id: string): void {
    const state = load();
    state.scheduled = { ...state.scheduled, [path]: id };
    save(state);
  },
  /** This device's id, made the first time it is asked for. */
  device(): string {
    const state = load();
    if (!state.device) {
      state.device = crypto.randomUUID();
      save(state);
    }
    return state.device;
  },
  log(): ScriptRun[] {
    return load().log;
  },
  /** What Undo this run puts back, while this page has it. */
  undoFor(id: string): Map<string, { before: Uint8Array | null; after: Uint8Array }> | null {
    return undoBytes.get(id) ?? null;
  },
  undone(id: string): void {
    const state = load();
    state.log = state.log.map((r) => (r.id === id ? { ...r, undone: true } : r));
    save(state);
    undoBytes.delete(id);
  },
};
