import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfDocument, type LoadOptions } from '../src/index.ts';

export const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', name)));

export const load = (name: string, options?: LoadOptions): PdfDocument => PdfDocument.load(fixture(name), options);

export const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

export const latin1 = (b: Uint8Array): string => String.fromCharCode(...b);

/** All pages' text, whitespace collapsed. */
export const docText = (doc: PdfDocument): string =>
  doc.pages
    .map((p) => p.extractText().text)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();

/** The text every producer fixture contains. */
export const LINE1 = 'The quick brown fox jumps over the lazy dog.';
export const LINE2 = 'Café naïve résumé – “quoted” fi fl 1234';

/**
 * Checks a saved file's structure the way a strict reader would: every in-use entry of every
 * classic xref table points at "num gen obj". Returns the number of entries checked.
 */
export function checkXrefTables(bytes: Uint8Array): number {
  const text = latin1Big(bytes);
  let checked = 0;
  for (let at = text.indexOf('\nxref\n'); at >= 0; at = text.indexOf('\nxref\n', at + 1)) {
    let p = at + 6;
    for (;;) {
      const head = /^(\d+) (\d+)\r?\n/.exec(text.slice(p, p + 40));
      if (!head) break;
      p += head[0].length;
      const first = Number(head[1]);
      for (let i = 0; i < Number(head[2]); i++, p += 20) {
        const row = text.slice(p, p + 20);
        const m = /^(\d{10}) (\d{5}) ([nf])/.exec(row);
        if (!m) throw new Error(`bad xref row ${JSON.stringify(row)}`);
        if (m[3] !== 'n') continue;
        const target = text.slice(Number(m[1]), Number(m[1]) + 30);
        if (!new RegExp(`^${first + i} ${Number(m[2])} obj`).test(target)) throw new Error(`xref for ${first + i} points at ${JSON.stringify(target)}`);
        checked++;
      }
    }
  }
  return checked;
}

function latin1Big(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}
