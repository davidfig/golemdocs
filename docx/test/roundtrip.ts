// Round-trips every corpus document and reports differences per part.
// Usage: tsx test/roundtrip.ts [filter]

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { WordDocument } from '../src/docx/document.ts';
import { OpcPackage } from '../src/opc/package.ts';
import { parseXml, serializeXml } from '../src/xml/xml.ts';
import { CORPUS_DIR } from './corpus.ts';
import { diffXmlText } from './xmlDiff.ts';

export interface RoundTripResult {
  file: string;
  error?: string;
  diffs: { part: string; diff: string }[];
  parts: number;
}

export async function roundTrip(file: string, bytes: Uint8Array): Promise<RoundTripResult> {
  const result: RoundTripResult = { file, diffs: [], parts: 0 };
  let doc: WordDocument;
  try {
    doc = await WordDocument.read(bytes);
  } catch (e) {
    result.error = `read: ${(e as Error).message}`;
    return result;
  }
  let written: Uint8Array;
  try {
    written = await doc.write();
  } catch (e) {
    result.error = `write: ${(e as Error).stack}`;
    return result;
  }
  const before = await OpcPackage.read(bytes);
  const after = await OpcPackage.read(written);
  for (const part of before.partNames) {
    if (!after.has(part)) {
      result.diffs.push({ part, diff: 'part missing after write' });
      continue;
    }
    result.parts++;
    const a = await before.bytes(part);
    const b = await after.bytes(part);
    if (!/\.(xml|rels)$/i.test(part)) {
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) result.diffs.push({ part, diff: 'binary content changed' });
      continue;
    }
    let diff: string | null;
    try {
      diff = diffXmlText(new TextDecoder().decode(a), new TextDecoder().decode(b));
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      // Too deep for the recursive differ: compare canonical serializations instead.
      const canon = (bytes: Uint8Array) =>
        serializeXml(parseXml(new TextDecoder().decode(bytes)))
          .replace(/>\s+</g, '><')
          .replace(/ xmlns:\w+="[^"]*"/g, '');
      diff = canon(a) === canon(b) ? null : 'differs (deep document, no detail)';
    }
    if (diff) result.diffs.push({ part, diff });
  }
  for (const part of after.partNames) if (!before.has(part)) result.diffs.push({ part, diff: 'new part after write' });
  return result;
}

if (import.meta.main ?? process.argv[1]?.endsWith('roundtrip.ts')) {
  const dir = CORPUS_DIR;
  const filter = process.argv[2];
  let clean = 0;
  let total = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.docx') && (!filter || f.includes(filter)))) {
    const result = await roundTrip(file, readFileSync(path.join(dir, file)));
    if (result.error?.startsWith('read:')) {
      console.log(`SKIP ${file}: ${result.error}`);
      continue;
    }
    total++;
    if (!result.error && !result.diffs.length) {
      clean++;
      continue;
    }
    console.log(`DIFF ${file}${result.error ? `: ${result.error}` : ''}`);
    for (const d of result.diffs.slice(0, 3)) console.log(`   ${d.part}: ${d.diff.slice(0, 300)}`);
  }
  console.log(`\n${clean}/${total} readable documents round-trip with no differences`);
}
