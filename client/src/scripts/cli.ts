// `golem run` (docs/live-blocks.md §8, *The package and the command line*): runs a script of a vault folder on disk, in
// Node. A producer prints its result; an action writes the files it changed (or, with --dry-run, says what it would).
//
// It is not sandboxed: like any program a person starts in a terminal, it runs with their permissions, and it says so. What
// a script reads and writes is still checked against its `meta`, as in the app. It is for testing scripts and for agents.
//
//   pnpm golem run Scripts/daily-note.ts --vault ~/Documents/Vault [--dry-run]

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { paragraphText, paragraphsIn } from '@golemdocs/docx';
import { documentToMarkdown } from '../formats/markdown.ts';
import type { LiveResult } from '../live/result.ts';
import { resultOf } from '../live/sources.ts';
import type { SourceLookup } from '../live/sources.ts';
import { normalizeFolder, ScriptRunError } from './host.ts';
import { ScriptError } from './link.ts';
import { nodeChannel } from './nodeChannel.ts';
import { ScriptRunner } from './runner.ts';
import { fetchForScript } from './fetch.ts';
import type { ScriptFetch } from './fetch.ts';
import type { VaultFile } from './vault.ts';

/** Folders a vault keeps for the apps, never a script's business. */
const HIDDEN = /^\./;

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (HIDDEN.test(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, full, out);
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
}

/** A vault folder on disk, as scripts see it. */
export function diskVault(root: string) {
  const paths = async (): Promise<string[]> => {
    const out: string[] = [];
    await walk(root, root, out);
    return out.sort();
  };
  const read = async (path: string): Promise<VaultFile | null> => {
    const all = await paths();
    const found = all.find((p) => p.toLowerCase() === normalizeFolder(path).toLowerCase());
    return found ? { path: found, bytes: new Uint8Array(await readFile(join(root, found))) } : null;
  };
  // A sheet's range, read as a live block reads it (`/Budget.xlsx#Total`, from the top of the vault).
  const lookup: SourceLookup = async (title) => {
    const file = await read(title.replace(/^\/+/, ''));
    return file ? { name: file.path.split('/').pop()!, bytes: file.bytes } : null;
  };
  return {
    paths,
    list: async (folder: string) => {
      const f = normalizeFolder(folder);
      const inside = (await paths()).filter((p) => !f || p.startsWith(`${f}/`));
      if (f && !inside.length) return null;
      return Promise.all(inside.map(async (p) => ({ path: p, bytes: new Uint8Array(await readFile(join(root, p))) })));
    },
    file: read,
    produce: (address: string) => resultOf(address, lookup),
    fetch: (url: string, init: ScriptFetch) => fetchForScript(url, init),
  };
}

/** A result as text for a terminal: a table as Markdown, a value as it is. */
export function resultText(result: LiveResult): string {
  switch (result.kind) {
    case 'table': {
      const [head, ...rows] = result.rows;
      if (!result.header) return result.rows.map((r) => r.join('\t')).join('\n');
      return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
    }
    case 'value':
      return result.text;
    case 'blocks':
      return result.from ? documentToMarkdown(result.from) : paragraphsIn(result.blocks).map(paragraphText).join('\n');
    case 'picture':
      return `(a picture, ${result.width} × ${result.height})`;
    case 'error':
      return `error: ${result.code}${result.detail ? `: ${result.detail}` : ''}`;
  }
}

const USAGE = 'usage: golem run <Scripts/script.ts> [--vault <folder>] [--dry-run]';

/** Runs the command line; returns the exit code. */
export async function main(argv: string[], cwd: string, out: (line: string) => void = console.log, err: (line: string) => void = console.error): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'run') {
    err(USAGE);
    return 2;
  }
  let vaultDir = cwd;
  let dryRun = false;
  let script: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--vault') vaultDir = resolve(cwd, rest[++i] ?? '.');
    else if (rest[i] === '--dry-run') dryRun = true;
    else if (!script) script = rest[i];
    else {
      err(USAGE);
      return 2;
    }
  }
  if (!script) {
    err(USAGE);
    return 2;
  }
  // A path given from the shell, inside the vault or not.
  const path = normalizeFolder(script.startsWith('Scripts/') || script.startsWith('Scripts\\') ? script : relative(vaultDir, resolve(cwd, script)).split(sep).join('/'));
  err('golem run: not sandboxed. The script runs with your permissions, as any program you start does; what it reads and changes is still limited to what its meta asks for.');
  const vault = diskVault(vaultDir);
  // Everything a script asks for is allowed here: the person started it.
  const runner = new ScriptRunner({ vault, channel: nodeChannel, grants: { get: () => null, set: () => undefined }, ask: async () => 'once' });
  try {
    const meta = await runner.describe(path);
    const acts = meta.writes.length > 0 || meta.trigger !== null;
    if (!acts) {
      const result = await runner.produce(path, { interactive: true });
      out(resultText(result));
      return result.kind === 'error' ? 1 : 0;
    }
    const outcome = await runner.act(path, { interactive: true });
    const { toVaultFile } = await import('../desktop/vaultCodec.ts');
    for (const file of outcome.files) {
      const name = file.path.split('/').pop()!;
      const bytes = (await toVaultFile(file.after, name)) ?? file.after;
      out(`${dryRun ? 'would ' : ''}${file.before ? 'change' : 'make'} ${file.path}`);
      if (dryRun) continue;
      await mkdir(dirname(join(vaultDir, file.path)), { recursive: true });
      await writeFile(join(vaultDir, file.path), bytes);
    }
    if (outcome.message) out(outcome.message);
    if (!outcome.files.length) out('nothing changed');
    return 0;
  } catch (e) {
    err(e instanceof ScriptRunError || e instanceof ScriptError ? e.message : String((e as Error).stack ?? e));
    return 1;
  }
}
