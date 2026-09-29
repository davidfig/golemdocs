// Fetches pdf.js's test PDFs (~1,000 files, ~120 MB, many deliberately broken or unusual)
// into .cache/pdfjs with a sparse, blobless git clone, pinned to a commit for reproducibility.
//
//   pnpm --filter @word/pdf fetch-corpus && pnpm --filter @word/pdf corpus

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'https://github.com/mozilla/pdf.js.git';
const COMMIT = '91041fb94d6744bc2a5bccd9aad28d617faa8195';
const dir = join(import.meta.dirname, '../../.cache/pdfjs');

const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'inherit' });

if (!existsSync(join(dir, '.git'))) {
  execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', '--sparse', REPO, dir], { stdio: 'inherit' });
}
git('sparse-checkout', 'set', 'test/pdfs');
git('fetch', '--depth', '1', '--filter=blob:none', 'origin', COMMIT);
git('checkout', '--detach', COMMIT);
console.log(`pdf.js test corpus at ${COMMIT.slice(0, 10)} in ${dir}/test/pdfs`);
