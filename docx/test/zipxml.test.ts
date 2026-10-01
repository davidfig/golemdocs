import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { crc32 } from '../src/zip/crc32.ts';
import { ZipArchive, ZipEntry, ZipError, writeZip } from '../src/zip/zip.ts';
import { deflateRaw } from '../src/zip/deflate.ts';
import { XmlError, el, parseXml, serializeXml } from '../src/xml/xml.ts';
import { OpcPackage } from '../src/opc/package.ts';

import { CORPUS_DIR as CORPUS, corpusFiles } from './corpus.ts';

const files = corpusFiles() ?? [];
const needsCorpus = files.length ? {} : { skip: 'run `pnpm --filter @golemdocs/docx corpus` first' };

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

test('zip: an entry that inflates past its declared size is refused, not inflated in full', async () => {
  const data = new Uint8Array(100_000);
  const raw = await deflateRaw(data);
  // The header claims 10 bytes: a ZIP bomb's lie.
  const bytes = await writeZip([{ name: 'bomb.xml', entry: new ZipEntry('bomb.xml', 8, crc32(data), 10, raw) }]);
  await assert.rejects(ZipArchive.read(bytes).entries.get('bomb.xml')!.read(), ZipError);
  // The truth still reads.
  const honest = await writeZip([{ name: 'ok.xml', data }]);
  assert.deepEqual(await ZipArchive.read(honest).entries.get('ok.xml')!.read(), data);
});

test('xml: a start tag with a stray slash is an error, not an endless loop', () => {
  assert.throws(() => parseXml('<a><b/'), XmlError);
  assert.throws(() => parseXml('<a><b / x="1"></b></a>'), XmlError);
  assert.deepEqual(parseXml('<a><b/></a>').children, [{ name: 'b', attrs: {}, children: [] }]);
});

test('xml: character references to characters XML forbids read as U+FFFD instead of throwing', () => {
  assert.deepEqual(parseXml('<a>x&#0;&#x110000;&#xD800;y&#x1F600;</a>').children, ['x\uFFFD\uFFFD\uFFFDy\u{1F600}']);
});

test('xml: characters XML 1.0 cannot hold are left out when writing', () => {
  const xml = serializeXml(el('a', { v: 'x\u0001y\ttab' }, ['one\u000Btwo\u0000 & \uFFFF<three>']), false);
  assert.equal(xml, '<a v="xy&#9;tab">onetwo &amp; &lt;three&gt;</a>');
  assert.doesNotThrow(() => parseXml(xml));
});

test('opc: malformed content types and relationships are skipped, not fatal', async () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const bytes = await writeZip([
    { name: '[Content_Types].xml', data: enc('<Types><Default ContentType="application/xml"/><Override Extension="xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>') },
    { name: '_rels/.rels', data: enc('<Relationships><Relationship Type="t"/><Relationship Id="rId1" Target="a.xml"/><Relationship Id="rId2" Type="x/officeDocument" Target="b.xml"/></Relationships>') },
    { name: 'b.xml', data: enc('<b/>') },
  ]);
  const pkg = await OpcPackage.read(bytes);
  const rels = await pkg.relationships('');
  assert.deepEqual(rels.list.map((r) => r.id), ['rId1', 'rId2']);
  assert.equal(rels.byId(undefined as unknown as string), undefined);
  assert.equal(pkg.contentType('_rels/.rels'), 'application/vnd.openxmlformats-package.relationships+xml');
});

test('opc: adding a relationship a Strict document already has reuses it', async () => {
  const pkg = OpcPackage.create();
  const rels = await pkg.relationships('word/document.xml');
  rels.list.push({ id: 'rId1', type: 'http://purl.oclc.org/ooxml/officeDocument/relationships/styles', target: 'styles.xml', external: false });
  assert.equal(rels.add('http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles', 'word/styles.xml'), 'rId1');
  assert.equal(rels.list.length, 1);
});
