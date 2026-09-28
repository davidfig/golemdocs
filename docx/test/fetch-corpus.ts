// Fetches the round-trip test corpus (see corpus.ts). Needs git.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { CORPUS_COMMIT, CORPUS_DIR, CORPUS_REPO } from './corpus.ts';

function git(args: string[], cwd?: string): void {
  const result = spawnSync('git', args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
}

const checkout = `${CORPUS_DIR}.git-checkout`;
rmSync(checkout, { recursive: true, force: true });
git(['clone', '--quiet', '--filter=blob:none', '--no-checkout', CORPUS_REPO, checkout]);
git(['sparse-checkout', 'set', '--no-cone', 'test-data/document/*.docx'], checkout);
git(['checkout', '--quiet', CORPUS_COMMIT], checkout);

rmSync(CORPUS_DIR, { recursive: true, force: true });
mkdirSync(CORPUS_DIR, { recursive: true });
const source = path.join(checkout, 'test-data/document');
for (const file of readdirSync(source)) if (file.endsWith('.docx')) cpSync(path.join(source, file), path.join(CORPUS_DIR, file));
rmSync(checkout, { recursive: true, force: true });
console.log(`${readdirSync(CORPUS_DIR).length} documents in ${path.relative(process.cwd(), CORPUS_DIR)}`);
if (!existsSync(CORPUS_DIR)) process.exit(1);
