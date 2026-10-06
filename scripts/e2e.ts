// pnpm e2e: the end-to-end tests.
//
// The first pass is split into shards, each its own Playwright run with its own client, server,
// database and ports, so no server is shared by every worker (a shared one overloads and fails tests
// that pass alone). The tests tagged @heavy (drag and drop, timing of rendered frames, long offline
// merges, big canvas work) only pass reliably when the machine is not busy, so they run afterwards on
// one server with a few workers and a retry, when the first pass no longer uses the CPU.
//
//   pnpm e2e                    everything: the shards, then the heavy pass
//   pnpm e2e:rest               only what the last run did not pass: failed, or never reported
//   pnpm e2e e2e/pdf --ui       anything with arguments goes straight to `playwright test` (one run, one server)
//   E2E_SKIP_HEAVY=1 pnpm e2e   only the first pass, for a quick check
//   E2E_WORKERS=6 pnpm e2e      the number of parallel workers in all (default: a third of the cores)
//   E2E_SHARDS=1 pnpm e2e       the number of shards (default 3 on a machine with 9 or more cores, else 1)
//   E2E_IDLE_MS=300000          a run that prints nothing for this long is hung: it is stopped and its
//                               tests that did not report are listed (and run again by `pnpm e2e:rest`)
//
// Every attempt of every test is written to e2e/.progress/run.jsonl as it ends (e2e/progress-reporter.ts).
// A stopped run (Ctrl-C, a kill, a hang) does not go on to the heavy pass; it exits non-zero and lists
// what is left.
//
// Exits non-zero if anything failed or did not run.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROGRESS = path.resolve('e2e/.progress/run.jsonl');
const IDLE_MS = Number(process.env.E2E_IDLE_MS ?? 5 * 60_000);
const cores = os.cpus().length;
const totalWorkers = process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : Math.max(2, Math.floor(cores / 3));
const shardCount = Math.max(1, Number(process.env.E2E_SHARDS ?? (cores >= 9 ? 3 : 1)));

const running = new Set<ChildProcess>();
let stopped = false;

/** Stops every run, and the servers each one started, and does not go on to anything else. */
function stopAll(signal: NodeJS.Signals): void {
  if (stopped) return;
  stopped = true;
  for (const child of running) killTree(child, signal);
  setTimeout(() => {
    for (const child of running) killTree(child, 'SIGKILL');
  }, 15_000).unref();
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

process.on('SIGINT', () => stopAll('SIGINT'));
process.on('SIGTERM', () => stopAll('SIGTERM'));

/** Kills what is still listening on the run's ports: the server's own children can outlive their parent when a run is stopped. */
function freePorts(env: Record<string, string> = {}): void {
  const client = Number(env.E2E_CLIENT_PORT ?? 5273);
  const api = Number(env.E2E_API_PORT ?? 3101);
  // One lsof per port, and `-a`: without it lsof ORs its selections, and `-sTCP:LISTEN` alone matches every listening process of the user, dev servers included.
  for (const port of [client, api, api + 6000]) {
    const out = spawnSync('lsof', ['-nti', '-a', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    for (const pid of out.stdout.split('\n').filter(Boolean)) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

interface RunOptions {
  /** A label put before every line when several runs print together. */
  label?: string;
  env?: Record<string, string>;
}

/** Runs `playwright test` with the arguments; resolves to its exit code (null if it hung and was stopped). */
function playwright(args: string[], options: RunOptions = {}): Promise<{ code: number; hung: boolean }> {
  return new Promise((resolve) => {
    if (stopped) return resolve({ code: 130, hung: false });
    const child = spawn('pnpm', ['exec', 'playwright', 'test', ...args], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, E2E_PROGRESS: PROGRESS, ...options.env },
    });
    running.add(child);
    let hung = false;
    let idle = setTimeout(onIdle, IDLE_MS);
    function onIdle(): void {
      hung = true;
      console.error(`\n${options.label ?? 'e2e'}: nothing printed for ${Math.round(IDLE_MS / 1000)} s, so it is hung: stopping it.`);
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 15_000).unref();
    }
    const forward = (stream: NodeJS.ReadableStream, out: NodeJS.WriteStream): void => {
      let rest = '';
      stream.on('data', (chunk: Buffer) => {
        clearTimeout(idle);
        idle = setTimeout(onIdle, IDLE_MS);
        const lines = (rest + chunk.toString()).split('\n');
        rest = lines.pop() ?? '';
        for (const line of lines) out.write(options.label ? `${options.label} ${line}\n` : `${line}\n`);
      });
      stream.on('end', () => {
        if (rest) out.write(options.label ? `${options.label} ${rest}\n` : `${rest}\n`);
      });
    };
    forward(child.stdout!, process.stdout);
    forward(child.stderr!, process.stderr);
    child.on('close', (code) => {
      clearTimeout(idle);
      running.delete(child);
      freePorts(options.env);
      resolve({ code: code ?? 1, hung });
    });
  });
}

// ----------------------------------------------------------------------------------------------
// What exists, and what the last run did with it

interface Spec {
  key: string;
  heavy: boolean;
}

/** Every test, as `e2e/<file>:<line>` (what Playwright accepts as a filter) and whether it is @heavy. */
function listAll(): Spec[] {
  const out = spawnSync('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=json'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const json = JSON.parse(out.stdout.slice(out.stdout.indexOf('{'))) as { suites: Suite[] };
  interface Suite {
    suites?: Suite[];
    specs?: { file: string; line: number; tags: string[] }[];
  }
  const walk = (suite: Suite): Spec[] => [
    ...(suite.specs ?? []).map((spec) => ({ key: `e2e/${spec.file}:${spec.line}`, heavy: spec.tags.includes('heavy') })),
    ...(suite.suites ?? []).flatMap(walk),
  ];
  const seen = new Map<string, Spec>();
  for (const spec of json.suites.flatMap(walk)) seen.set(spec.key, spec);
  return [...seen.values()];
}

/** The tests whose last recorded attempt passed. */
function passedKeys(): Set<string> {
  const last = new Map<string, boolean>();
  if (fs.existsSync(PROGRESS)) {
    for (const line of fs.readFileSync(PROGRESS, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as { key: string; passed: boolean };
        last.set(row.key, row.passed);
      } catch {
        // a line cut short by a kill
      }
    }
  }
  return new Set([...last].filter(([, passed]) => passed).map(([key]) => key));
}

function remaining(): Spec[] {
  const passed = passedKeys();
  return listAll().filter((spec) => !passed.has(spec.key));
}

// ----------------------------------------------------------------------------------------------
// The passes

/** The first pass: `filters` (all non-heavy tests when empty) split across the shards. */
async function firstPass(filters: string[]): Promise<void> {
  const shards = filters.length > 0 ? Math.min(shardCount, filters.length) : shardCount;
  const workers = Math.max(1, Math.ceil(totalWorkers / shards));
  const runs = Array.from({ length: shards }, (_, i) => {
    const mine = filters.filter((_, index) => index % shards === i);
    const args = [
      ...(filters.length > 0 ? mine : ['--grep-invert', '@heavy', ...(shards > 1 ? [`--shard=${i + 1}/${shards}`] : [])]),
      '--workers',
      String(workers),
    ];
    // Shard ports sit apart from the defaults (5273, 3101) and from the ones a side run is told to use.
    const env: Record<string, string> =
      shards === 1
        ? {}
        : {
            E2E_CLIENT_PORT: String(5280 + i),
            E2E_API_PORT: String(3110 + i),
            E2E_STATE: `e2e/.state-shard-${i}`,
          };
    if (shards > 1) args.push('--output', `e2e/.results-shard-${i}`);
    return playwright(args, { label: shards > 1 ? `[${i + 1}]` : undefined, env });
  });
  await Promise.all(runs);
  for (let i = 0; i < shards && shards > 1; i++) {
    fs.rmSync(`e2e/.state-shard-${i}`, { recursive: true, force: true });
  }
}

async function heavyPass(filters: string[]): Promise<void> {
  const workers = String(Math.max(1, Math.floor(cores / 4)));
  console.log(`\nHeavy tests: ${workers} worker(s), one retry.`);
  const args = filters.length > 0 ? filters : ['--grep', '@heavy'];
  await playwright([...args, '--workers', workers, '--retries', '1']);
}

/** Prints the tests that did not pass in the last run (failed, or never reported) and says how to run them again. */
function report(heavyRan = true): number {
  const left = remaining().filter((spec) => heavyRan || !spec.heavy);
  if (left.length === 0) {
    console.log('\nAll tests passed.');
    return 0;
  }
  console.log(`\n${left.length} test(s) did not pass or did not run:`);
  for (const spec of left) console.log(`  ${spec.key}${spec.heavy ? ' (@heavy)' : ''}`);
  console.log('\nRun just these with: pnpm e2e:rest');
  return 1;
}

const args = process.argv.slice(2);

async function main(): Promise<number> {
  if (args[0] === 'rest') {
    const left = remaining();
    if (left.length === 0) {
      console.log('Nothing left: every test passed in the last run.');
      return 0;
    }
    console.log(`Running the ${left.length} test(s) that did not pass.`);
    const normal = left.filter((spec) => !spec.heavy).map((spec) => spec.key);
    const heavy = left.filter((spec) => spec.heavy).map((spec) => spec.key);
    if (normal.length > 0) await firstPass(normal);
    if (heavy.length > 0 && !stopped) await heavyPass(heavy);
    return report();
  }

  if (args.length > 0) return (await playwright(args)).code;

  fs.rmSync(path.dirname(PROGRESS), { recursive: true, force: true });
  await firstPass([]);
  if (stopped) {
    console.log('\nStopped: the heavy pass was not started.');
    report();
    return 130;
  }
  if (!process.env.E2E_SKIP_HEAVY) await heavyPass([]);
  // Whether it passed is what the tests recorded, not how Playwright exited: a run can hang or fail
  // to exit after its last test, and then every test still reported.
  return report(!process.env.E2E_SKIP_HEAVY);
}

main().then((code) => process.exit(code));
