// Downloads for the font scripts, pinned by sha256 and cached in .cache/downloads.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CACHE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..', '.cache');

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Fetches a file once, checks its sha256, and returns its path in the cache. */
export async function download(url: string, expected: string): Promise<string> {
  const dest = path.join(CACHE, 'downloads', expected);
  if (existsSync(dest)) return dest;
  console.log(`  download ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const actual = sha256(data);
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${url}\n  expected ${expected}\n  actual   ${actual}`);
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(`${dest}.tmp`, data);
  renameSync(`${dest}.tmp`, dest);
  return dest;
}

