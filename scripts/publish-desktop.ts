// Puts a release's desktop installers on golemdocs.com/download.
//
//   pnpm publish:desktop [vX.Y.Z] [--dry-run]
//
// The repository is private, so the installers the "Desktop release" workflow builds (a draft GitHub Release) cannot be linked
// from the website. This downloads them with `gh`, uploads them to the production files bucket under `downloads/desktop/`,
// (with the signed update files and `updater.json`, which is what an installed app asks to learn it can update itself),
// and writes `latest.json` last, so the page only ever lists a version whose files are all there (server/src/downloads.ts).
// It needs `gh` signed in to GitHub and `wrangler` signed in to Cloudflare. Run it after the draft is checked, before or
// after publishing the draft; the website's Worker must be deployed once with the /api/downloads route.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOWNLOAD_PREFIX, installerPlatform, updaterManifest, updaterPlatforms, type DesktopRelease } from '../server/src/downloads.ts';

const BUCKET = 'golemdocs-files';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, 'server');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const version = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;
const tag = args.find((a) => /^v\d/.test(a)) ?? `v${version}`;
const tagVersion = tag.slice(1);

const run = (command: string, commandArgs: string[], cwd = root): string => execFileSync(command, commandArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const TYPES: Record<string, string> = { dmg: 'application/x-apple-diskimage', exe: 'application/vnd.microsoft.portable-executable', msi: 'application/x-msi', deb: 'application/vnd.debian.binary-package', rpm: 'application/x-rpm' };

const folder = mkdtempSync(path.join(tmpdir(), 'golemdocs-desktop-'));
try {
  console.log(`Downloading the ${tag} installers from GitHub…`);
  run('gh', ['release', 'download', tag, '--dir', folder, '--clobber']);
  const files = readdirSync(folder).filter((name) => installerPlatform(name) !== null);
  const platforms = new Set(files.map((name) => installerPlatform(name)));
  for (const wanted of ['mac', 'windows', 'linux'] as const) if (!platforms.has(wanted)) throw new Error(`the ${tag} release has no ${wanted} installer; wait for the build to finish`);
  for (const name of files) if (!name.includes(tagVersion)) throw new Error(`${name} is not version ${tagVersion}`);

  // The update files: the build signs one file per platform and leaves its `.sig` beside it (the key is TAURI_SIGNING_PRIVATE_KEY).
  // The Mac one has no version in its name, and a name never changes its bytes once served, so it is stored under a versioned one.
  const everything = readdirSync(folder);
  const updates = everything
    .filter((name) => updaterPlatforms(name).length > 0)
    .map((name) => {
      if (!everything.includes(`${name}.sig`)) throw new Error(`${name} has no signature: was the update signing key set when it was built?`);
      return { name, stored: /\.app\.tar\.gz$/i.test(name) ? `GolemDocs_${tagVersion}_universal.app.tar.gz` : name, platforms: updaterPlatforms(name), signature: readFileSync(path.join(folder, `${name}.sig`), 'utf8').trim() };
    });
  for (const wanted of ['darwin-aarch64', 'windows-x86_64', 'linux-x86_64']) if (!updates.some((u) => u.platforms.includes(wanted))) throw new Error(`no update file for ${wanted}`);
  const changes = (() => {
    const log = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const start = log.indexOf(`## ${tagVersion}`);
    if (start < 0) return `See What's New in the app (Help › What's New).`;
    const end = log.indexOf('\n## ', start + 3);
    return log.slice(log.indexOf('\n', start), end < 0 ? undefined : end).trim();
  })();
  const updater = updaterManifest(tagVersion, changes, new Date(), updates.map((u) => ({ platforms: u.platforms, signature: u.signature, url: `https://golemdocs.com/api/downloads/${u.stored}` })));

  const release: DesktopRelease = {
    version: tagVersion,
    date: new Date().toISOString().slice(0, 10),
    files: files.sort().map((name) => ({ name, platform: installerPlatform(name)!, size: statSync(path.join(folder, name)).size })),
  };
  console.log(release.files.map((f) => `  ${f.platform.padEnd(8)} ${f.name} (${(f.size / 1048576).toFixed(1)} MB)`).join('\n'));
  console.log(updates.map((u) => `  update   ${u.platforms.join(', ')} -> ${u.stored}`).join('\n'));
  if (dryRun) {
    console.log('Dry run: nothing uploaded.');
  } else {
    const put = (key: string, file: string, type: string) =>
      run('pnpm', ['exec', 'wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file, '--content-type', type, '--remote'], server);
    for (const { name } of release.files) {
      console.log(`Uploading ${name}…`);
      put(DOWNLOAD_PREFIX + name, path.join(folder, name), TYPES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream');
    }
    for (const u of updates) {
      if (u.stored === u.name && files.includes(u.name)) continue; // already uploaded as an installer
      console.log(`Uploading ${u.stored}…`);
      put(DOWNLOAD_PREFIX + u.stored, path.join(folder, u.name), 'application/gzip');
    }
    const updaterFile = path.join(folder, 'updater.json');
    writeFileSync(updaterFile, JSON.stringify(updater));
    put(`${DOWNLOAD_PREFIX}updater.json`, updaterFile, 'application/json');
    const manifest = path.join(folder, 'latest.json');
    writeFileSync(manifest, JSON.stringify(release));
    put(`${DOWNLOAD_PREFIX}latest.json`, manifest, 'application/json');
    console.log(`Published ${tag}: https://golemdocs.com/api/downloads`);
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
}
