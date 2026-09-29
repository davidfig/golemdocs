// Line coverage of every package's tests, with Node's built-in test coverage (no extra packages).
// Run: pnpm test:coverage [package...]. Only files a test loads are listed, so files with no test
// at all are named in a separate "never loaded" list rather than shown as 0%.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGES = ['docx', 'layout', 'ops', 'editor', 'server', 'client', 'pdf', 'odt'];
const LOW = 60;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) out.push(...sources(file));
    else if (/\.ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(file);
  }
  return out;
}

const wanted = process.argv.slice(2);
const packages = wanted.length ? wanted : PACKAGES;
let failed = false;

for (const name of packages) {
  const cwd = path.join(ROOT, name);
  // The client's tests run on plain Node; the others through tsx (see each package.json).
  const flags = name === 'client' ? ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--import', './test/setup.ts', '--test'] : ['--import', 'tsx', '--test'];
  const tests = name === 'client' ? readdirSync(path.join(cwd, 'test')).filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`) : ['test/**/*.test.ts'];
  const run = spawnSync('node', [...flags, '--experimental-test-coverage', '--test-coverage-include=src/**', ...tests], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  const report = /start of coverage report([\s\S]*?)end of coverage report/.exec(run.stdout)?.[1] ?? '';
  const seen = new Set<string>();
  const low: string[] = [];
  let total = '?';
  let dir = '';
  for (const line of report.split('\n')) {
    const cells = line.replace(/^ℹ /, '').split('|').map((c) => c.trim());
    if (cells.length < 4 || cells[0] === 'file' || /^-+$/.test(cells[0])) continue;
    const pct = Number(cells[1]);
    if (cells[0] === 'all files') total = cells[1];
    else if (cells[2] === '' && cells[1] === '') dir = cells[0]; // a directory row
    else {
      seen.add(cells[0]);
      if (pct < LOW) low.push(`${dir ? `${dir}/` : ''}${cells[0]} ${cells[1]}%`);
    }
  }
  const never = sources(path.join(cwd, 'src')).filter((f) => !seen.has(path.basename(f)));
  console.log(`\n${name}: ${total}% of the lines in files the tests load${run.status ? '  (TESTS FAILED)' : ''}`);
  if (run.status) failed = true;
  if (low.length) console.log(`  under ${LOW}%: ${low.join(', ')}`);
  if (never.length) console.log(`  never loaded by a test (${never.length} of ${seen.size + never.length} files): ${never.map((f) => path.relative(path.join(cwd, 'src'), f)).join(', ')}`);
}
process.exit(failed ? 1 : 0);
