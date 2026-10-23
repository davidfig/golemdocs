// The mechanical steps of a release. The decisions stay with a person: the version number, the changelog wording and the
// e2e results (AGENTS.md, "Changelog").
//
//   pnpm release bump <X.Y.Z> [--commit]
//       Sets the version in every package.json, desktop/src-tauri/tauri.conf.json, Cargo.toml and the golemdocs-desktop entry of
//       Cargo.lock, and dates the changelog's "## X.Y.Z - Unreleased" heading. With --commit, commits exactly those files
//       ("Release X.Y.Z") and creates the annotated tag vX.Y.Z. It never pushes.
//
//   pnpm release ship [--yes] [--dry-run]
//       For the version in package.json, after `git push origin main vX.Y.Z` (which starts the "Desktop release" workflow):
//       waits for that workflow to finish, stops so the Mac installer can be checked by hand (--yes skips the stop), publishes
//       the installers (publish:desktop), and only then deploys the website, so the website is the switch for everyone
//       (it refuses unless HEAD is the tag and the checkout is clean: the website is built from the checkout)
//       (docs/architecture/desktop-release.md). It ends by checking that the site serves the new build and downloads.
//
// Needs `gh` signed in to GitHub and `wrangler` signed in to Cloudflare.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://golemdocs.com';
const WORKFLOW = 'Desktop release';
const POLL_MS = 30_000;
const BUILD_POLL_MS = 5_000;
const BUILD_WAIT_MS = 120_000;

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const positional = rest.filter((a) => !a.startsWith('--'));
const dryRun = flags.has('--dry-run');

const out = (cmd: string, args: string[]): string => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const show = (cmd: string, args: string[]): void => {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  if (dryRun) return;
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.status})`);
};
const read = (file: string): string => readFileSync(path.join(root, file), 'utf8');
const write = (file: string, text: string): void => writeFileSync(path.join(root, file), text);
const currentVersion = (): string => (JSON.parse(read('package.json')) as { version: string }).version;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Replaces the one match of `pattern` in `file`, and fails when there isn't exactly one. */
function replaceOnce(file: string, pattern: RegExp, replacement: string): void {
  const text = read(file);
  if ((text.match(new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g')) ?? []).length !== 1) throw new Error(`${file}: expected exactly one match of ${pattern}`);
  write(file, text.replace(pattern, replacement));
}

function bump(version: string): string[] {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('usage: pnpm release bump <X.Y.Z> [--commit]');
  const heading = new RegExp(`^## ${version.replace(/\./g, '\\.')} - Unreleased$`, 'm');
  if (!heading.test(read('CHANGELOG.md'))) throw new Error(`CHANGELOG.md has no "## ${version} - Unreleased" heading; nothing was changed`);
  const touched: string[] = [];
  const packages = out('git', ['ls-files', '--', 'package.json', '*/package.json']).split('\n').filter((f) => f !== '');
  for (const file of packages) {
    replaceOnce(file, /("version": ")[^"]+(")/, `$1${version}$2`);
    touched.push(file);
  }
  const conf = 'desktop/src-tauri/tauri.conf.json';
  replaceOnce(conf, /("version": ")[^"]+(")/, `$1${version}$2`);
  replaceOnce('desktop/src-tauri/Cargo.toml', /^(version = ")[^"]+(")/m, `$1${version}$2`);
  replaceOnce('desktop/src-tauri/Cargo.lock', /(name = "golemdocs-desktop"\nversion = ")[^"]+(")/, `$1${version}$2`);
  touched.push(conf, 'desktop/src-tauri/Cargo.toml', 'desktop/src-tauri/Cargo.lock');
  const today = new Date().toISOString().slice(0, 10);
  replaceOnce('CHANGELOG.md', heading, `## ${version} - ${today}`);
  touched.push('CHANGELOG.md');
  console.log(`Version ${version} set in ${touched.length} files; the changelog entry is dated ${today}.`);
  return touched;
}

async function ship(): Promise<void> {
  const version = currentVersion();
  const tag = `v${version}`;
  const say = (message: string): void => console.log(`\n== ${message}`);

  say(`Releasing ${tag}`);
  if (!out('git', ['ls-remote', '--tags', 'origin', tag])) throw new Error(`${tag} is not on origin: git push origin main ${tag} first`);
  // The website is built from this checkout, so it must be exactly what the tag says: no later commits, nothing uncommitted.
  const tagged = out('git', ['rev-parse', `${tag}^{commit}`]);
  const problems = [
    out('git', ['rev-parse', 'HEAD']) !== tagged && `HEAD is not ${tag} (${tagged.slice(0, 7)}): check out the tag, or release what is on main as a new version`,
    out('git', ['status', '--porcelain']) !== '' && 'the working tree has uncommitted changes',
  ].filter((p): p is string => typeof p === 'string');
  if (problems.length > 0) {
    if (!dryRun) throw new Error(`the website would not be ${tag}: ${problems.join('; ')}`);
    console.log(`  (a real run would stop: ${problems.join('; ')})`);
  }
  if (/Unreleased/.test(read('CHANGELOG.md').split('\n').find((l) => l.startsWith(`## ${version}`)) ?? 'Unreleased')) throw new Error(`CHANGELOG.md has no released ${version} entry: pnpm release bump ${version}`);

  say(`Waiting for the "${WORKFLOW}" run of ${tag}`);
  for (;;) {
    const runs = JSON.parse(out('gh', ['run', 'list', '--workflow', WORKFLOW, '--limit', '10', '--json', 'databaseId,headBranch,status,conclusion'])) as { databaseId: number; headBranch: string; status: string; conclusion: string }[];
    const mine = runs.filter((r) => r.headBranch === tag);
    if (mine.length === 0) {
      console.log('  no run yet…');
    } else if (mine.some((r) => r.status === 'completed' && r.conclusion === 'success') && mine.every((r) => r.status === 'completed')) {
      console.log('  built.');
      break;
    } else if (mine.every((r) => r.status === 'completed')) {
      throw new Error(`the build of ${tag} did not succeed (${mine.map((r) => r.conclusion).join(', ')}): see gh run view ${mine[0].databaseId}`);
    } else {
      console.log(`  ${mine.map((r) => `${r.databaseId} ${r.status}`).join(', ')}…`);
    }
    if (dryRun) break;
    await sleep(POLL_MS);
  }

  if (!flags.has('--yes') && !dryRun) {
    say('Check the Mac build');
    console.log('Install the .dmg from the draft release (gh release view ' + tag + '), open it, and check File › Vault Folder and the menu bar.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Publish the installers and then deploy the website? (yes/no) ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'yes') throw new Error('stopped before publishing; run again when the build is checked');
  }

  const before = await buildId();
  say('Publishing the installers');
  show('pnpm', ['publish:desktop', tag]);

  say('Deploying the website (the switch)');
  show('pnpm', ['--filter', '@golemdocs/server', 'deploy:prod']);

  say('Checking the site');
  if (dryRun) return;
  const manifest = (await (await fetch(`${SITE}/api/downloads`, { cache: 'no-store' })).json()) as { version?: string };
  if (manifest.version !== version) throw new Error(`/api/downloads serves ${manifest.version}, not ${version}`);
  // A deploy takes a few seconds to reach every edge, so the first read can still be the old build.
  let after = await buildId();
  for (let waited = 0; (after === null || after === before) && waited < BUILD_WAIT_MS; waited += BUILD_POLL_MS) {
    await sleep(BUILD_POLL_MS);
    after = await buildId();
  }
  if (after === null || after === before) throw new Error(`/build.json did not change (${before} → ${after}): the website may not have deployed`);
  console.log(`${tag} is live: downloads at ${version}, site build ${before} → ${after}.`);
}

async function buildId(): Promise<string | null> {
  try {
    return ((await (await fetch(`${SITE}/build.json`, { cache: 'no-store' })).json()) as { id?: string }).id ?? null;
  } catch {
    return null;
  }
}

try {
  if (command === 'bump') {
    const version = positional[0] ?? '';
    const files = bump(version);
    if (flags.has('--commit')) {
      show('git', ['add', '--', ...files]);
      show('git', ['commit', '-m', `Release ${version}`]);
      show('git', ['tag', '-a', `v${version}`, '-m', `Release ${version}`]);
      console.log(`Committed and tagged v${version}. Next: git push origin main v${version}, then pnpm release ship`);
    }
  } else if (command === 'ship') {
    await ship();
  } else {
    console.log('usage: pnpm release bump <X.Y.Z> [--commit]\n       pnpm release ship [--yes] [--dry-run]');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`\nrelease: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
