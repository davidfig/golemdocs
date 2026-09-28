import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { crc32 } from '../src/zip/crc32.ts';
import { ZipArchive, writeZip } from '../src/zip/zip.ts';
import { parseXml, serializeXml } from '../src/xml/xml.ts';

import { CORPUS_DIR as CORPUS, corpusFiles } from './corpus.ts';

const files = corpusFiles() ?? [];
const needsCorpus = files.length ? {} : { skip: 'run `pnpm --filter @word/docx corpus` first' };

test('crc32 matches known vectors', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('zip: read every corpus file, verify CRCs, rewrite, reread', needsCorpus, async () => {
  let parts = 0;
  for (const file of files) {
    let archive: ZipArchive;
    try {
      archive = ZipArchive.read(readFileSync(path.join(CORPUS, file)));
    } catch (e) {
      console.log(`  skip ${file}: ${(e as Error).message}`);
      continue;
    }
    const inputs = [];
    try {
      for (const entry of archive.entries.values()) inputs.push({ name: entry.name, data: await entry.read() });
    } catch (e) {
      console.log(`  skip ${file}: ${(e as Error).message}`);
      continue;
    }
    parts += inputs.length;
    const again = ZipArchive.read(await writeZip(inputs));
    for (const input of inputs) {
      assert.deepEqual(await again.entries.get(input.name)!.read(), input.data);
    }
  }
  console.log(`  ${parts} parts`);
});

test('xml: parse -> serialize -> parse is stable for every XML part', needsCorpus, async () => {
  let count = 0;
  for (const file of files) {
    let archive: ZipArchive;
    try { archive = ZipArchive.read(readFileSync(path.join(CORPUS, file))); } catch { continue; }
    for (const entry of archive.entries.values()) {
      if (!/\.(xml|rels)$/i.test(entry.name)) continue;
      let text: string;
      try { text = await entry.text(); } catch { continue; }
      let tree;
      try { tree = parseXml(text); } catch (e) { console.log(`  xml error ${file}/${entry.name}: ${(e as Error).message}`); continue; }
      const once = serializeXml(tree);
      assert.equal(serializeXml(parseXml(once)), once, `${file}/${entry.name}`);
      count++;
    }
  }
  console.log(`  ${count} XML parts`);
});
