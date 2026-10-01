// Runs every PDF in a directory through the reader and writer and reports what broke:
//   load → every page's text → full save → reload → same pages and text
//                            → incremental save → reload → same pages
//
//   pnpm --filter @golemdocs/pdf corpus [dir] [--only name] [--verbose]
//
// The default directory is pdf.js's test corpus, fetched by `pnpm --filter @golemdocs/pdf fetch-corpus`.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EncryptionError, PdfDocument, PdfError } from '../src/index.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--only')) ?? join(import.meta.dirname, '../../.cache/pdfjs/test/pdfs');
const only = option('--only');
const verbose = flag('--verbose');

type Outcome = 'ok' | 'not-pdf' | 'encrypted' | 'crash' | 'mismatch';
const counts: Record<Outcome, number> = { ok: 0, 'not-pdf': 0, encrypted: 0, crash: 0, mismatch: 0 };
const problems: string[] = [];
let warned = 0;
let slowest: [string, number][] = [];

const pageTexts = (doc: PdfDocument) => doc.pages.map((p) => p.extractText().text);

async function check(file: string): Promise<Outcome> {
  const bytes = new Uint8Array(readFileSync(file));
  let doc: PdfDocument;
  try {
    doc = PdfDocument.load(bytes);
  } catch (e) {
    if (e instanceof EncryptionError) return 'encrypted';
    if (e instanceof PdfError && /not a PDF|no document catalog/.test(e.message)) return 'not-pdf';
    throw e;
  }
  if (doc.warnings.length) warned++;
  const texts = pageTexts(doc);

  const full = PdfDocument.load(await doc.save());
  if (full.pageCount !== texts.length) throw mismatch(`full save: ${full.pageCount} pages, was ${texts.length}`);
  const fullTexts = pageTexts(full);
  const diff = fullTexts.findIndex((t, i) => t !== texts[i]);
  if (diff >= 0) throw mismatch(`full save: page ${diff + 1} text differs`);
  // Damage in the source (a corrupt compressed stream) is carried over as is; anything else is new.
  const before = new Set(doc.warnings.map((w) => w.replace(/^object \d+: /, '')));
  const added = full.warnings.filter((w) => !before.has(w.replace(/^object \d+: /, '')));
  if (added.length) throw mismatch(`full save reloads with new warnings: ${added[0]}`);

  if (!doc.security) {
    const inc = PdfDocument.load(await doc.save({ incremental: true }));
    if (inc.pageCount !== texts.length) throw mismatch(`incremental save: ${inc.pageCount} pages, was ${texts.length}`);
  }
  return 'ok';
}

class Mismatch extends Error {}
const mismatch = (m: string) => new Mismatch(m);

const files = readdirSync(dir)
  .filter((f) => f.toLowerCase().endsWith('.pdf') && (!only || f.includes(only)))
  .sort();
const started = performance.now();
for (const name of files) {
  const file = join(dir, name);
  if (statSync(file).size > 50_000_000) continue;
  const t0 = performance.now();
  let outcome: Outcome;
  try {
    outcome = await check(file);
  } catch (e) {
    outcome = e instanceof Mismatch ? 'mismatch' : 'crash';
    problems.push(`${outcome.toUpperCase()} ${name}: ${e instanceof Mismatch ? e.message : (e as Error).stack?.split('\n').slice(0, 4).join(' | ')}`);
  }
  const ms = performance.now() - t0;
  slowest.push([name, ms]);
  counts[outcome]++;
  if (verbose) console.log(`${outcome.padEnd(9)} ${ms.toFixed(0).padStart(6)}ms ${name}`);
}
slowest = slowest.sort((a, b) => b[1] - a[1]).slice(0, 5);

console.log(problems.join('\n'));
console.log(`\n${files.length} files in ${((performance.now() - started) / 1000).toFixed(1)}s:`, counts, `(${warned} loaded with warnings)`);
console.log('slowest:', slowest.map(([n, ms]) => `${n} ${ms.toFixed(0)}ms`).join(', '));
if (counts.crash || counts.mismatch) process.exitCode = 1;
