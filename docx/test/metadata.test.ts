// Document properties: docProps/core.xml and app.xml (src/docx/metadata.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpcPackage, REL, WordDocument, parseXml, serializeXml, writeAppProperties, writeCoreProperties } from '../src/index.ts';

const PROPERTIES = {
  title: 'Annual report',
  subject: 'Results',
  author: 'Ada Lovelace',
  keywords: 'yearly, finance',
  comments: 'Draft for review',
  category: 'Reports',
  lastModifiedBy: 'Grace Hopper',
  created: '2026-01-02T03:04:05Z',
  modified: '2026-09-29T17:30:00Z',
  manager: 'Charles Babbage',
  company: 'Analytical Engines Ltd',
};

test('properties are written to docProps and read back', async () => {
  const doc = await WordDocument.create();
  assert.deepEqual(doc.properties, {});
  doc.properties = { ...PROPERTIES };
  const bytes = await doc.write();
  const back = await WordDocument.read(bytes);
  assert.deepEqual(back.properties, PROPERTIES);
  // In the parts a reader such as Word looks for, with the right relationships.
  const pkg = await OpcPackage.read(bytes);
  const rels = await pkg.relationships('');
  assert.ok(rels.byType(REL.coreProperties).length === 1 && rels.byType(REL.extendedProperties).length === 1);
  const core = await pkg.text('docProps/core.xml');
  assert.match(core, /<dc:title>Annual report<\/dc:title>/);
  assert.match(core, /<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-02T03:04:05Z<\/dcterms:created>/);
  assert.match(await pkg.text('docProps/app.xml'), /<Company>Analytical Engines Ltd<\/Company>/);
});

test('changing properties keeps what else is in the parts; clearing takes an element away', async () => {
  const doc = await WordDocument.create();
  doc.properties = { title: 'First', author: 'Ada', company: 'X' };
  const once = await WordDocument.read(await doc.write());
  // Something a producer put in the core part that this doesn't know.
  const pkg = await OpcPackage.read(await once.write());
  const core = (await pkg.text('docProps/core.xml')).replace('</cp:coreProperties>', '<cp:contentStatus>Final</cp:contentStatus></cp:coreProperties>');
  pkg.set('docProps/core.xml', core);
  const withExtra = await WordDocument.read(await pkg.write());
  withExtra.properties = { ...withExtra.properties, title: 'Second' };
  delete withExtra.properties.author;
  const saved = await OpcPackage.read(await withExtra.write());
  const text = await saved.text('docProps/core.xml');
  assert.match(text, /<dc:title>Second<\/dc:title>/);
  assert.doesNotMatch(text, /dc:creator/, 'the cleared one is gone');
  assert.match(text, /<cp:contentStatus>Final<\/cp:contentStatus>/, 'the unknown element stayed');
  assert.deepEqual((await WordDocument.read(await withExtra.write())).properties, { title: 'Second', company: 'X' });
});

test('a document whose properties did not change is written without touching them', async () => {
  const doc = await WordDocument.create();
  const before = await OpcPackage.read(await doc.write());
  assert.equal(before.has('docProps/core.xml'), false, 'no properties, no part');
  doc.properties = { title: 'T' };
  const bytes = await doc.write();
  const again = await WordDocument.read(bytes);
  const first = await OpcPackage.read(await again.write());
  const second = await OpcPackage.read(await (await WordDocument.read(await again.write())).write());
  assert.equal(await first.text('docProps/core.xml'), await second.text('docProps/core.xml'));
  // Empty values are not properties.
  const empty = await WordDocument.create();
  empty.properties = { title: '   ' };
  assert.equal((await OpcPackage.read(await empty.write())).has('docProps/app.xml'), false);
});

test('a property added to a part that does not declare its namespace gets the declaration', () => {
  // A minimal core part from another producer: only cp is declared.
  const core = writeCoreProperties(parseXml('<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"/>'), { title: 'T', created: '2026-01-01T00:00:00Z' });
  const xml = serializeXml(core);
  assert.match(xml, /xmlns:dc="http:\/\/purl.org\/dc\/elements\/1.1\/"/);
  assert.match(xml, /xmlns:dcterms=/);
  assert.match(xml, /xmlns:xsi=/);
  // An app part whose root is prefixed: the new element takes the same prefix.
  const app = writeAppProperties(parseXml('<ep:Properties xmlns:ep="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"/>'), { company: 'C' });
  assert.match(serializeXml(app), /<ep:Company>C<\/ep:Company>/);
});
