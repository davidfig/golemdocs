// Real-world .docx files for round-trip tests: Apache POI's Word test corpus (Apache-2.0),
// fetched at a pinned commit into the repo's .cache/ by `pnpm --filter @word/docx corpus`.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const CORPUS_REPO = 'https://github.com/apache/poi';
export const CORPUS_COMMIT = '581a4cba5973743e35482163c8848ced8b7ae4f0';
export const CORPUS_DIR = path.resolve(import.meta.dirname, '../../.cache/docx-corpus');

/** Corpus .docx file names, or null if the corpus hasn't been fetched. */
export function corpusFiles(): string[] | null {
  if (!existsSync(CORPUS_DIR)) return null;
  const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.docx'));
  return files.length ? files : null;
}
