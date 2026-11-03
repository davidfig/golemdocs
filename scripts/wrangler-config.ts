// Writes server/wrangler.generated.jsonc: server/wrangler.jsonc with the REPLACE_… placeholders filled
// in from server/wrangler.local.json (git-ignored; see wrangler.local.example.json). The committed config
// carries no account-specific ids; the server's wrangler scripts run `--config wrangler.generated.jsonc`.
// Without a local file the placeholders stay, and `pnpm dev` falls back to the offline mode; a production deploy cannot
// go ahead (`missingForProduction`).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server');

export const GENERATED = 'wrangler.generated.jsonc';

/** server/wrangler.jsonc with its placeholders filled in from server/wrangler.local.json (none, without it). */
export function filledWranglerConfig(): string {
  let text = readFileSync(path.join(server, 'wrangler.jsonc'), 'utf8');
  const localFile = path.join(server, 'wrangler.local.json');
  if (existsSync(localFile)) {
    const values = JSON.parse(readFileSync(localFile, 'utf8')) as Record<string, string>;
    for (const [name, value] of Object.entries(values)) if (value) text = text.split(`REPLACE_${name}`).join(value);
  }
  return text;
}

export function writeWranglerConfig(): string {
  const out = path.join(server, GENERATED);
  writeFileSync(out, filledWranglerConfig());
  return out;
}

/**
 * The placeholders a production deploy still needs filled: those left above the config's `env` block (which is only for
 * the dev and local environments). Cloudflare refuses a deploy with any of them left (scripts/release.ts checks first).
 */
export function missingForProduction(text: string): string[] {
  const env = text.search(/^\s*"env"\s*:/m);
  const top = env < 0 ? text : text.slice(0, env);
  return [...new Set([...top.matchAll(/REPLACE_([A-Z0-9_]+)/g)].map((m) => m[1]))];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeWranglerConfig();
