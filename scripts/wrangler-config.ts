// Writes server/wrangler.generated.jsonc: server/wrangler.jsonc with the REPLACE_… placeholders filled
// in from server/wrangler.local.json (git-ignored; see wrangler.local.example.json): the account, the
// directory databases, and the production DOMAIN (or "workers.dev" for none, see docs/self-hosting.md). The committed config
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
    text = fillWranglerConfig(text, values);
  }
  return text;
}

/** Sentinel DOMAIN: no custom domain, served at the Worker's own workers.dev address. */
export const WORKERS_DEV = 'workers.dev';

/** `text` with each `REPLACE_<name>` replaced by its value from `values` (empty values are left as placeholders). */
export function fillWranglerConfig(text: string, values: Record<string, string>): string {
  if (values.DOMAIN?.trim() === WORKERS_DEV) {
    const routes = /"routes":\s*\[\s*\{\s*"pattern":\s*"REPLACE_DOMAIN",\s*"custom_domain":\s*true\s*\}\s*\]/;
    if (!routes.test(text)) throw new Error('wrangler.jsonc: could not find the production route to replace with workers.dev');
    text = text.replace(routes, '"routes": [],\n\t"workers_dev": true');
  }
  for (const [name, value] of Object.entries(values)) if (value) text = text.split(`REPLACE_${name}`).join(value.trim());
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
