// The app's side of a script run (docs/live-blocks.md §8), whatever the worker runs in (a sandboxed frame in the app, a Node
// worker thread on the command line): it starts the program, reads what the script asks for (`meta`), lets it go only once
// that is allowed, answers its requests through the app (each checked against the grant), and ends it when it takes too
// long or sends back too much.

import { runtimeMessages, say } from './messages.ts';
import type { FromRuntime, RunMode, ScriptEdit, ScriptToday, ToRuntime } from './runtime.ts';

/** A line to and from a worker that runs the runtime. */
export interface RuntimeChannel {
  send(message: ToRuntime): void;
  /** Messages from the worker; `failed` when it could not start or stopped (a crash, a page error). */
  listen(handler: (message: FromRuntime) => void, failed: (error: string) => void): void;
  close(): void;
}

export interface ScriptTrigger {
  /** Every day at a time, `HH:MM` (the device's time). */
  daily?: string;
  /** Every week on a day at a time, `mon 06:00`. */
  weekly?: string;
  /** When a document in a folder changes. */
  changed?: string;
}

/** What a script asks for, from its `meta`. */
export interface ScriptMeta {
  name: string;
  /** Folders it reads (`Books/`; `/` for the whole vault). */
  reads: string[];
  /** Folders it changes (an action only). */
  writes: string[];
  /** Sites it fetches from, by host name (an action only; docs/live-blocks.md §8). Absent when none. */
  network?: string[];
  trigger: ScriptTrigger | null;
}

export class ScriptRunError extends Error {
  constructor(
    message: string,
    /** Why: the script failed, took too long, was not allowed, or sent back too much. */
    readonly code: 'failed' | 'timeout' | 'denied' | 'tooLarge' | 'invalid',
    readonly line?: number,
  ) {
    super(message);
  }
}

const folderList = (value: unknown): string[] => {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return list.filter((f): f is string => typeof f === 'string').map(normalizeFolder);
};

/** A folder as scripts write it (`Books/`, `/Books`, `Books`), as a vault path with no slashes at the ends; '' for the whole vault. */
export const normalizeFolder = (folder: string): string => folder.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

/** Whether a vault path names a place plainly: no `.`, `..` or empty parts, which other code would resolve to somewhere else. */
export const plainPath = (path: string): boolean => {
  const p = normalizeFolder(path);
  return p === '' || p.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
};

/** Whether a vault path is inside one of the folders (or is one). A path with `.`, `..` or empty parts is in none. */
export const within = (path: string, folders: readonly string[]): boolean => {
  const p = normalizeFolder(path);
  if (!plainPath(p)) return false;
  return folders.some((f) => f === '' || p === f || p.startsWith(`${f}/`));
};

/** A site as a script names it (`api.example.com`, or a URL of it), as a lower-case host name; null when it is not one. */
export function siteName(site: string): string | null {
  const s = site.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/.*$/, '');
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s) ? s : null;
}

/** A script's `meta`, checked; `path` names it when it gives no name. */
export function readMeta(raw: unknown, path: string): ScriptMeta {
  const meta = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const stem = path.split('/').pop()!.replace(/\.[^.]+$/, '');
  const trigger = meta.trigger && typeof meta.trigger === 'object' ? (meta.trigger as Record<string, unknown>) : null;
  const time = (s: unknown): string | undefined => (typeof s === 'string' && /^\d{1,2}:\d{2}$/.test(s.trim()) ? s.trim().padStart(5, '0') : undefined);
  const weekly = typeof trigger?.weekly === 'string' && /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+\d{1,2}:\d{2}$/i.test(trigger.weekly.trim()) ? trigger.weekly.trim().toLowerCase() : undefined;
  const t: ScriptTrigger = { daily: time(trigger?.daily), weekly, changed: typeof trigger?.changed === 'string' ? normalizeFolder(trigger.changed) : undefined };
  const network = (typeof meta.network === 'string' ? [meta.network] : Array.isArray(meta.network) ? meta.network : []).filter((h): h is string => typeof h === 'string').map(siteName);
  if (network.some((h) => h === null)) throw new Error(say('networkHosts'));
  return {
    name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : stem,
    reads: folderList(meta.reads),
    writes: folderList(meta.writes),
    trigger: t.daily || t.weekly || t.changed !== undefined ? t : null,
    ...(network.length && { network: [...new Set(network as string[])] }),
  };
}

export interface RunOptions {
  mode: RunMode;
  program: string;
  today: ScriptToday;
  /** For an action: the time it runs, ISO. */
  now?: string;
  /** Seeds a producer's `Math.random`, so it repeats. */
  seed: number;
  /** Ends a run that takes longer. */
  timeoutMs: number;
  /** The most a result and its edits may be, as JSON. */
  maxResultChars: number;
  /** Whether it may go on, once its meta is known: true, or why not. */
  approve(meta: ScriptMeta): Promise<true | string>;
  /** Answers a request (throw to fail it in the script). */
  request(op: string, args: unknown[], meta: ScriptMeta): Promise<unknown>;
}

export interface RunOutcome {
  meta: ScriptMeta;
  result: unknown;
  edits: ScriptEdit[];
  /** A producer that read `today`: its block changes with the date. */
  usesDate: boolean;
}

/** The line in the script a worker's error stack points at (a module is named `golem:///Scripts/...`). */
export function errorPlace(stack: string | undefined): { path: string; line: number } | null {
  const m = /golem:\/\/\/(Scripts\/[^:\s)]+):(\d+)/.exec(stack ?? '');
  return m ? { path: m[1], line: Number(m[2]) } : null;
}

/** The most requests of a run answered at once; the others wait. */
export const MAX_REQUESTS_IN_FLIGHT = 8;
/** The most requests a run may have waiting: past it, the run fails. */
export const MAX_REQUESTS_WAITING = 10_000;

/** Runs a linked program on a channel; `path` names the script. */
export function runOnChannel(channel: RuntimeChannel, path: string, options: RunOptions): Promise<RunOutcome> {
  return new Promise<RunOutcome>((resolve, reject) => {
    let meta: ScriptMeta | null = null;
    // Set once the person (or the grant) has said yes. Nothing the script asks for is answered, and nothing it sends back is
    // taken, before then: its own top-level code runs in the same worker as the runtime and can post messages itself.
    let approved = false;
    let inFlight = 0;
    const waiting: { id: number; op: string; args: unknown[]; meta: ScriptMeta }[] = [];
    const answerNext = (): void => {
      while (!finished && inFlight < MAX_REQUESTS_IN_FLIGHT && waiting.length) {
        const next = waiting.shift()!;
        inFlight++;
        void options
          .request(next.op, next.args, next.meta)
          .then(
            (value) => {
              if (!finished) channel.send({ type: 'reply', id: next.id, ok: true, value });
            },
            (e: unknown) => {
              if (!finished) channel.send({ type: 'reply', id: next.id, ok: false, error: e instanceof Error ? e.message : String(e) });
            },
          )
          .finally(() => {
            inFlight--;
            answerNext();
          });
      }
    };
    let usesDate = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: ScriptRunError | null, outcome?: RunOutcome): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      channel.close();
      if (error) reject(error);
      else resolve(outcome!);
    };
    // The time limit covers loading and running, not the time the person takes to answer the prompt.
    const startTimer = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new ScriptRunError(say('tookTooLong', { path, seconds: Math.round(options.timeoutMs / 1000) }), 'timeout')), options.timeoutMs);
    };
    startTimer();
    channel.listen(
      (message) => {
        if (finished) return;
        switch (message.type) {
          case 'meta': {
            // One meta per run: a second could widen what the script asks for after it was allowed.
            if (meta) return finish(new ScriptRunError(say('askedWhileRunning', { path }), 'invalid'));
            try {
              meta = readMeta(message.meta, path);
            } catch (e) {
              return finish(new ScriptRunError((e as Error).message, 'invalid'));
            }
            if (options.mode === 'describe') return finish(null, { meta, result: null, edits: [], usesDate: false });
            clearTimeout(timer);
            void options.approve(meta).then(
              (ok) => {
                if (finished) return;
                if (ok !== true) return finish(new ScriptRunError(ok, 'denied'));
                approved = true;
                startTimer();
                channel.send({ type: 'go' });
              },
              (e: unknown) => finish(new ScriptRunError((e as Error).message, 'denied')),
            );
            return;
          }
          case 'request': {
            if (!meta || !approved) return finish(new ScriptRunError(say('askedBeforeStart'), 'invalid'));
            // Each request reads documents on the page, so only a few are answered at a time; the rest wait their turn.
            if (waiting.length >= MAX_REQUESTS_WAITING) return finish(new ScriptRunError(say('tooManyRequests', { path, count: MAX_REQUESTS_WAITING }), 'tooLarge'));
            waiting.push({ id: message.id, op: message.op, args: message.args, meta });
            answerNext();
            return;
          }
          case 'usesDate':
            usesDate = true;
            return;
          case 'done': {
            if (!meta || !approved) return finish(new ScriptRunError(say('finishedBeforeStart'), 'invalid'));
            const size = JSON.stringify(message.result ?? null).length + JSON.stringify(message.edits ?? []).length;
            if (size > options.maxResultChars) return finish(new ScriptRunError(say('resultTooLarge', { path, mb: Math.round(options.maxResultChars / 1_000_000) }), 'tooLarge'));
            return finish(null, { meta, result: message.result, edits: Array.isArray(message.edits) ? message.edits : [], usesDate });
          }
          case 'failed': {
            const place = errorPlace(message.stack);
            return finish(new ScriptRunError(place ? say('atLine', { path: place.path, line: place.line, message: message.error }) : say('at', { path, message: message.error }), 'failed', place?.line));
          }
        }
      },
      (error) => finish(new ScriptRunError(say('at', { path, message: error }), 'failed')),
    );
    channel.send({ type: 'run', program: options.program, mode: options.mode, today: options.today, now: options.now, seed: options.seed, messages: runtimeMessages() });
  });
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The day a script is told it is, from the device's calendar (English names: a result must not depend on the language). */
export function scriptToday(date: Date): ScriptToday {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { iso, year, month, day, weekday: date.getDay() || 7, long: `${WEEKDAYS[date.getDay()]}, ${MONTHS[month - 1]} ${day}, ${year}` };
}

/** A small, stable number from a text (seeds a producer's randomness from its path). */
export function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}
