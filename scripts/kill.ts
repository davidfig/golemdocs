// pnpm kill: stops dev servers left over from earlier runs (vite, wrangler/workerd, scripts/dev.ts),
// e.g. one an agent started and never stopped, which then holds :3001 or :5173.
//
// Matches processes running from this checkout, plus anything still listening on the dev ports.
// Sends SIGTERM, then SIGKILL to whatever is still alive a moment later. macOS/Linux only.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTS = [5173, 3001];
const DEV_PROCESS = /\b(vite|wrangler|workerd)\b|scripts\/dev\.ts/;

function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return ''; // lsof exits 1 when nothing matches
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const pids = new Map<number, string>();
for (const line of run('ps', ['-Ao', 'pid=,command=']).split('\n')) {
  const match = line.trim().match(/^(\d+)\s+(.*)$/);
  if (!match) continue;
  const [, pid, command] = match;
  if (command.includes(root) && DEV_PROCESS.test(command)) pids.set(Number(pid), command);
}
for (const pid of run('lsof', ['-nP', '-t', ...PORTS.map((p) => `-iTCP:${p}`), '-sTCP:LISTEN']).split('\n')) {
  if (pid.trim()) pids.set(Number(pid), pids.get(Number(pid)) ?? `listening on ${PORTS.join('/')}`);
}
pids.delete(process.pid);
pids.delete(process.ppid);

if (pids.size === 0) {
  console.log('[kill] no dev servers running');
  process.exit(0);
}
for (const [pid, command] of pids) {
  console.log(`[kill] ${pid}  ${command.length > 120 ? `${command.slice(0, 117)}...` : command}`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
}
await new Promise((resolve) => setTimeout(resolve, 1500));
for (const pid of pids.keys()) {
  if (!alive(pid)) continue;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}
console.log(`[kill] stopped ${pids.size} process${pids.size === 1 ? '' : 'es'}`);
