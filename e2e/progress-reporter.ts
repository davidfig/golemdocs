// Records how every test attempt ended, one JSON line per attempt, as the run goes. `pnpm e2e:rest`
// reads these lines to run only the tests that failed or never reported (a run that hung, was stopped
// or timed out): the last line for a test says how it ended. The runner (scripts/e2e.ts) gives each
// shard its own file through E2E_PROGRESS.

import fs from 'node:fs';
import path from 'node:path';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

export default class ProgressReporter implements Reporter {
  private readonly file = process.env.E2E_PROGRESS;

  onBegin(): void {
    if (this.file) fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.file) return;
    const key = `${path.relative(process.cwd(), test.location.file)}:${test.location.line}`;
    const passed = result.status === 'passed' || result.status === 'skipped';
    fs.appendFileSync(this.file, JSON.stringify({ key, title: test.titlePath().slice(1).join(' › '), passed }) + '\n');
  }

  printsToStdio(): boolean {
    return false;
  }
}
