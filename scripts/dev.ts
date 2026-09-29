// pnpm dev: everything for local testing in one command.
//
//   1. creates server/.dev.vars from the example if it doesn't exist (DEV_USER counts as signed in)
//   2. applies the server's D1 migrations (safe to repeat) to the database it will use
//   3. runs the client (Vite, :5173) and the server (wrangler dev, :3001) with prefixed output
//
// The server uses the *dev* Cloudflare resources (env.dev in server/wrangler.jsonc) once they are
// set up, and never production's. Until then, or with `pnpm dev --local`, it runs entirely on this
// machine (wrangler's simulated D1, R2 and Durable Objects): cloud documents, sharing and
// multiplayer all work offline.
//
// Ctrl-C stops both; if either one exits, the other is stopped too.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const vars = path.join(root, 'server/.dev.vars');
if (!existsSync(vars)) {
  copyFileSync(`${vars}.example`, vars);
  console.log('[dev] created server/.dev.vars (add provider keys there to try real sign-in)');
}

/** Whether env.dev in wrangler.jsonc has real resource ids instead of the REPLACE_… placeholders. */
function devCloudConfigured(): boolean {
  try {
    // JSONC with whole-line comments only (which is how the file is written).
    const text = readFileSync(path.join(root, 'server/wrangler.jsonc'), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    const dev = JSON.parse(text).env.dev;
    return !String(dev.d1_databases[0].database_id).startsWith('REPLACE') && !String(dev.vars.CF_ACCOUNT_ID).startsWith('REPLACE');
  } catch {
    return false;
  }
}

const forceLocal = process.argv.includes('--local');
const cloud = !forceLocal && devCloudConfigured();
if (cloud) {
  console.log('[dev] using the dev Cloudflare resources (word-directory-dev, word-files-dev); production is never touched');
  if (!/^CF_API_TOKEN=.+/m.test(readFileSync(vars, 'utf8'))) {
    console.log('[dev] note: CF_API_TOKEN is empty in server/.dev.vars, so cloud documents will say "not configured"');
  }
} else if (forceLocal) {
  console.log('[dev] --local: everything simulated on this machine (cloud documents, sharing and multiplayer work offline)');
} else {
  console.log(
    '[dev] the dev Cloudflare resources aren\'t set up yet, so this run is fully local (simulated on this machine). To use the real dev resources instead:\n' +
      '[dev]   1. pnpm --filter @word/server cf:setup:dev\n' +
      '[dev]   2. paste the database id and your account id into env.dev in server/wrangler.jsonc\n' +
      '[dev]   3. wrangler login, and set CF_API_TOKEN in server/.dev.vars (see the README)',
  );
}

const migrate = spawnSync(pnpm, ['--filter', '@word/server', cloud ? 'cf:migrate:dev' : 'cf:migrate:local'], { cwd: root, encoding: 'utf8' });
if (migrate.status !== 0) {
  process.stderr.write(`${migrate.stdout}${migrate.stderr}`);
  console.error(`[dev] applying ${cloud ? 'dev' : 'local'} database migrations failed${cloud ? ' (not logged in to Cloudflare or offline? try `wrangler login`, or `pnpm dev --local`)' : ''}`);
  process.exit(1);
}

let alive = 0;
let exitCode: number | null = null;
const children: ChildProcess[] = [];

function stop(code: number): void {
  if (exitCode !== null) return;
  exitCode = code;
  for (const child of children) killGroup(child, 'SIGTERM');
  setTimeout(() => {
    for (const child of children) killGroup(child, 'SIGKILL');
    process.exit(code);
  }, 5000).unref();
}

/** The child runs in its own process group, so this also reaches vite, wrangler and workerd. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
  } catch {
    // already gone
  }
}

function run(name: string, args: string[]): void {
  const child = spawn(pnpm, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  children.push(child);
  alive++;
  const tag = `[${name}]`.padEnd(9);
  for (const [stream, out] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ] as const) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) out.write(`${tag}${line}\n`);
    });
    stream.on('end', () => pending && out.write(`${tag}${pending}\n`));
  }
  child.on('exit', (code, signal) => {
    alive--;
    if (exitCode === null) {
      console.log(`[dev] ${name} exited (${signal ?? code}); stopping the rest`);
      stop(code ?? 1);
    }
    if (alive === 0) process.exit(exitCode ?? 0);
  });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

console.log('[dev] client http://localhost:5173  ·  server http://localhost:3001 (reached through the client at /api)  ·  Ctrl-C stops both');
run('server', ['--filter', '@word/server', cloud ? 'dev' : 'dev:local']);
run('client', ['--filter', '@word/client', 'dev']);
