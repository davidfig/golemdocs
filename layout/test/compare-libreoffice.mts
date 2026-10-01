// Compares page counts with LibreOffice PDFs of the docx corpus.
// Usage: tsx test/compare-libreoffice.mts <dir of PDFs named like the .docx files>
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WordDocument } from '@golemdocs/docx';
import { FontSet, layoutDocument } from '../src/index.ts';

const fontDir = path.resolve(import.meta.dirname, '../../client/public/fonts');
const fonts = await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(fontDir, p), 'utf8')));
const corpus = path.resolve(import.meta.dirname, '../../.cache/docx-corpus');
const pdfs = process.argv[2];
let same = 0, total = 0, errors = 0;
const rows: string[] = [];
for (const f of readdirSync(corpus).filter((f) => f.endsWith('.docx'))) {
  let doc;
  try { doc = await WordDocument.read(readFileSync(path.join(corpus, f))); } catch { continue; }
  try {
    const t = performance.now();
    const layout = await layoutDocument(doc, fonts);
    const ms = performance.now() - t;
    const pdf = path.join(pdfs, f.replace(/\.docx$/, '.pdf'));
    const lo = existsSync(pdf) ? Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdf]).toString())![1]) : NaN;
    total++;
    if (lo === layout.pages.length) same++;
    rows.push(`${f.padEnd(60)} ours ${String(layout.pages.length).padStart(4)}  LO ${String(lo).padStart(4)}  ${ms.toFixed(0)}ms`);
  } catch (e) { errors++; rows.push(`${f}: ERROR ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`); }
}
console.log(rows.join('\n'));
console.log(`\nsame page count as LibreOffice: ${same}/${total}, errors: ${errors}`);
