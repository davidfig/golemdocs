// pnpm e2e: the end-to-end tests, in two passes.
//
// Most tests run in parallel. A few (tagged @heavy: drag and drop, timing of rendered frames, long
// offline merges, big canvas work) only pass reliably when the machine is not busy, so they run
// afterwards with a few workers and one retry, when the first pass is no longer using the CPU.
//
//   pnpm e2e                    both passes
//   pnpm e2e e2e/pdf --ui       anything with arguments goes straight to `playwright test` (one pass)
//   E2E_SKIP_HEAVY=1 pnpm e2e   only the first pass, for a quick check
//   E2E_WORKERS=4 pnpm e2e      the number of parallel workers (default: a third of the cores)
//
// Exits non-zero if either pass failed.

import { spawnSync } from 'node:child_process';
import os from 'node:os';

const args = process.argv.slice(2);

function playwright(extra: string[]): number {
  return spawnSync('pnpm', ['exec', 'playwright', 'test', ...extra], { stdio: 'inherit' }).status ?? 1;
}

if (args.length > 0) process.exit(playwright(args));

const normal = playwright(['--grep-invert', '@heavy']);
if (process.env.E2E_SKIP_HEAVY) process.exit(normal);

const workers = String(Math.max(1, Math.floor(os.cpus().length / 4)));
console.log(`\nHeavy tests: ${workers} worker(s), one retry.`);
const heavy = playwright(['--grep', '@heavy', '--workers', workers, '--retries', '1']);
process.exit(normal || heavy);
