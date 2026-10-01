// Writes server/wrangler.generated.jsonc: server/wrangler.jsonc with the REPLACE_… placeholders filled
// in from server/wrangler.local.json (git-ignored; see wrangler.local.example.json). The committed config
// carries no account-specific ids; the server's wrangler scripts run `--config wrangler.generated.jsonc`.
// Without a local file the placeholders stay, and `pnpm dev` falls back to the offline mode.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server');

export const GENERATED = 'wrangler.generated.jsonc';

export function writeWranglerConfig(): string {
  let text = readFileSync(path.join(server, 'wrangler.jsonc'), 'utf8');
  const localFile = path.join(server, 'wrangler.local.json');
  if (existsSync(localFile)) {
    const values = JSON.parse(readFileSync(localFile, 'utf8')) as Record<string, string>;
    for (const [name, value] of Object.entries(values)) if (value) text = text.split(`REPLACE_${name}`).join(value);
  }
  const out = path.join(server, GENERATED);
  writeFileSync(out, text);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeWranglerConfig();
