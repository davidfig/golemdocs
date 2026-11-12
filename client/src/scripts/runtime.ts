// What runs inside the sandbox's worker (docs/live-blocks.md §8, *The sandbox*): it loads the linked program, tells the app
// what the script asks for (`meta`), waits to be let go, then calls the script with the API scripts see and sends back its
// result (a producer) or its edits (an action). Everything the script reads is asked of the app, which checks it.
//
// `scriptRuntime` is sent to the worker as its text, so it must not use anything from outside its own body: no imports, no
// module-level names. The worker it runs in is started by sandbox.ts (in the browser) or a Node worker thread (the command
// line, and the tests).

/** How the runtime talks to the app. */
export interface RuntimePort {
  post(message: unknown): void;
  on(handler: (message: never) => void): void;
  /**
   * Loads the program's module. Given by the text that starts the worker, not written here: a bundler rewrites an
   * `import()` in this function (Vite's dev server adds a helper the worker doesn't have).
   */
  load(url: string): Promise<unknown>;
}

/** The date as the app gives it to a script: the same for every run on a day, whatever the device's clock language. */
export interface ScriptToday {
  iso: string;
  year: number;
  month: number;
  day: number;
  /** 1 (Monday) to 7 (Sunday). */
  weekday: number;
  /** `Wednesday, November 11, 2026`. */
  long: string;
}

export type RunMode = 'describe' | 'produce' | 'act';

/** The app to the worker. */
export type ToRuntime =
  | { type: 'run'; program: string; mode: RunMode; today: ScriptToday; now?: string; seed: number }
  | { type: 'go' }
  | { type: 'reply'; id: number; ok: true; value: unknown }
  | { type: 'reply'; id: number; ok: false; error: string };

/** One change to a document, made by an action. */
export type ScriptEditOp =
  | { op: 'append'; markdown: string }
  | { op: 'prepend'; markdown: string }
  | { op: 'replace'; markdown: string }
  | { op: 'setField'; key: string; value: string | null }
  | { op: 'appendToSection'; heading: string; markdown: string }
  | { op: 'replaceSection'; heading: string; markdown: string };

export interface ScriptEdit {
  path: string;
  /** Made by the run (it did not exist). */
  create: boolean;
  ops: ScriptEditOp[];
}

/** The worker to the app. */
export type FromRuntime =
  | { type: 'meta'; meta: unknown }
  | { type: 'request'; id: number; op: string; args: unknown[] }
  | { type: 'usesDate' }
  | { type: 'done'; result: unknown; edits: ScriptEdit[] }
  | { type: 'failed'; error: string; stack?: string };

export function scriptRuntime(port: RuntimePort): void {
  const g = globalThis as Record<string, unknown>;
  // Nothing a script could reach the outside with, even if the sandbox's policy let it through.
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'indexedDB', 'caches', 'BroadcastChannel', 'importScripts', 'Worker', 'SharedWorker', 'WebTransport', 'RTCPeerConnection', 'require', 'process', 'Deno', 'Bun']) {
    try {
      Object.defineProperty(g, name, { value: undefined, configurable: false, writable: false });
    } catch {
      // A name the engine will not let go of stays unusable through the sandbox's policy.
    }
  }
  const post = (message: unknown): void => port.post(message);
  let nextId = 1;
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let go: (() => void) | null = null;
  const ask = (op: string, ...args: unknown[]): Promise<never> => {
    // Made here, so a refusal's stack points at the line of the script that asked.
    const refusal = new Error();
    return new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve: resolve as (value: unknown) => void, reject: (e: Error) => reject(Object.assign(refusal, { message: e.message })) });
      post({ type: 'request', id, op, args });
    });
  };
  const fail = (e: unknown): void => {
    const error = e instanceof Error ? e : new Error(String(e));
    post({ type: 'failed', error: error.message || String(e), stack: error.stack });
  };

  /** A producer gives the same result for the same files: no clock, and randomness that repeats. */
  const deterministic = (seed: number): void => {
    const RealDate = Date;
    const noClock = (): never => {
      throw new Error('A producer cannot read the clock: use `today`, which the app gives it');
    };
    class FixedDate extends RealDate {
      constructor(...args: unknown[]) {
        if (!args.length) noClock();
        super(...(args as [number]));
      }
      static now(): number {
        return noClock();
      }
    }
    g.Date = FixedDate;
    let state = seed >>> 0 || 1;
    Math.random = () => {
      // mulberry32
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    if (typeof performance === 'object' && performance) Object.defineProperty(performance, 'now', { value: noClock });
  };

  const text = (value: unknown): string => (value === null || value === undefined ? '' : typeof value === 'number' ? String(value) : String(value));

  /** A result's constructors. */
  const results = {
    table: (header: unknown[], rows: unknown[][]) => ({ kind: 'table', rows: [header.map(text), ...rows.map((r) => r.map(text))], header: true }),
    rows: (rows: unknown[][]) => ({ kind: 'table', rows: rows.map((r) => r.map(text)), header: false }),
    value: (value: unknown) => ({ kind: 'value', text: text(value) }),
    markdown: (markdown: string) => ({ kind: 'markdown', markdown: text(markdown) }),
    list: (items: unknown[]) => ({ kind: 'markdown', markdown: items.map((item) => `- ${text(item).replace(/\n/g, ' ')}`).join('\n') }),
  };

  const edits = new Map<string, { path: string; create: boolean; ops: unknown[] }>();
  const editsOf = (path: string, create: boolean) => {
    let found = edits.get(path);
    if (!found) edits.set(path, (found = { path, create, ops: [] }));
    return found;
  };

  /** A document an action opened: what it holds, and its editing helpers (nothing is written until the run ends). */
  const documentHandle = (doc: { path: string; title: string; text: string; fields: Record<string, string>; exists: boolean }) => {
    const changes = () => editsOf(doc.path, !doc.exists);
    let body = doc.text;
    const handle = {
      path: doc.path,
      title: doc.title,
      get text() {
        return body;
      },
      fields: { ...doc.fields },
      get isEmpty() {
        return !body.trim();
      },
      append(markdown: string) {
        changes().ops.push({ op: 'append', markdown: text(markdown) });
        body = `${body}${body && !body.endsWith('\n') ? '\n' : ''}${text(markdown)}`;
        return handle;
      },
      prepend(markdown: string) {
        changes().ops.push({ op: 'prepend', markdown: text(markdown) });
        body = `${text(markdown)}${body}`;
        return handle;
      },
      replace(markdown: string) {
        changes().ops.push({ op: 'replace', markdown: text(markdown) });
        body = text(markdown);
        return handle;
      },
      setField(key: string, value: unknown) {
        const v = value === null || value === undefined ? null : text(value);
        changes().ops.push({ op: 'setField', key: text(key), value: v });
        if (v === null) delete handle.fields[text(key)];
        else handle.fields[text(key)] = v;
        return handle;
      },
      appendToSection(heading: string, markdown: string) {
        changes().ops.push({ op: 'appendToSection', heading: text(heading), markdown: text(markdown) });
        return handle;
      },
      replaceSection(heading: string, markdown: string) {
        changes().ops.push({ op: 'replaceSection', heading: text(heading), markdown: text(markdown) });
        return handle;
      },
    };
    if (!doc.exists) changes();
    return handle;
  };

  let mode: RunMode = 'describe';
  let started: { program: string; today: ScriptToday; now?: string; seed: number } | null = null;

  const start = async (): Promise<void> => {
    const run = started!;
    const loaded = (await port.load(run.program)) as { meta?: unknown; default?: unknown };
    // What it asks for, from `meta`, plain data only.
    let meta: unknown = null;
    try {
      meta = loaded.meta === undefined ? null : JSON.parse(JSON.stringify(loaded.meta));
    } catch {
      throw new Error('`meta` must be plain data');
    }
    post({ type: 'meta', meta });
    if (mode === 'describe') return;
    await new Promise<void>((resolve) => (go = resolve));
    if (typeof loaded.default !== 'function') throw new Error('A script exports a function as its default: `export default async function (api) { ... }`');
    if (mode === 'produce') deterministic(run.seed);
    let usedDate = false;
    const api: Record<string, unknown> = {
      ...results,
      notes: (folder: string) => ask('notes', text(folder)),
      read: (path: string) => ask('read', text(path)),
      sheet: (address: string) => ask('sheet', text(address)),
      result: (path: string) => ask('result', text(path)),
      get today() {
        if (!usedDate && mode === 'produce') post({ type: 'usesDate' });
        usedDate = true;
        return run.today;
      },
    };
    if (mode === 'act') {
      api.now = run.now;
      // A site the script named in `meta.network`, fetched by the app (no cookies, no redirects to elsewhere).
      api.fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
        const got = (await ask('fetch', text(url), { method: init.method ? text(init.method) : 'GET', headers: { ...(init.headers ?? {}) }, body: init.body === undefined ? null : text(init.body) })) as { status: number; headers: Record<string, string>; body: string };
        return { ok: got.status >= 200 && got.status < 300, status: got.status, headers: got.headers, text: async () => got.body, json: async () => JSON.parse(got.body) };
      };
      api.open = async (path: string, options: { create?: boolean } = {}) => documentHandle(await ask('open', text(path), !!options.create));
      api.create = async (path: string, markdown = '') => {
        const doc = documentHandle(await ask('open', text(path), true));
        if (!doc.isEmpty) throw new Error(`${text(path)} is already there`);
        if (markdown) doc.append(markdown);
        return doc;
      };
    }
    const value = await (loaded.default as (api: unknown) => unknown)(api);
    const result = mode === 'produce' ? (typeof value === 'string' || typeof value === 'number' ? results.value(value) : value) : value === undefined ? null : text(value);
    post({ type: 'done', result: JSON.parse(JSON.stringify(result ?? null)), edits: [...edits.values()] });
  };

  port.on((message: ToRuntime) => {
    if (message.type === 'run' && !started) {
      mode = message.mode;
      started = { program: message.program, today: message.today, now: message.now, seed: message.seed };
      start().catch(fail);
    } else if (message.type === 'go') go?.();
    else if (message.type === 'reply') {
      const wait = waiting.get(message.id);
      if (!wait) return;
      waiting.delete(message.id);
      if (message.ok) wait.resolve(message.value);
      else wait.reject(new Error(message.error));
    }
  });
}

/** The runtime as the text of a module that starts it in a browser worker. */
/**
 * What a bundler may have added to the runtime's text: esbuild (tsx, a dev server) wraps functions in `__name` to keep their
 * names, a helper that lives outside the function and is not sent with it.
 */
const HELPERS = 'var __name = (target) => target;';

export const browserRuntimeSource = (): string => `${HELPERS}\n(${scriptRuntime.toString()})({ post: (m) => postMessage(m), on: (f) => { self.onmessage = (e) => f(e.data); }, load: (u) => import(u) });`;

/** The same for a Node worker thread (the command line and the tests): a CommonJS script for `new Worker(code, { eval: true })`. */
export const nodeRuntimeSource = (): string => `const { parentPort } = require('node:worker_threads');\n${HELPERS}\n(${scriptRuntime.toString()})({ post: (m) => parentPort.postMessage(m), on: (f) => parentPort.on('message', f), load: (u) => import(u) });`;
