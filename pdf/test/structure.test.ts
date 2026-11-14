import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PdfDict, PdfDocument, PdfRef, PdfString, StructureTree, isName, setXmpMetadata, type StructNode } from '../src/index.ts';

test('XMP metadata: title, language and tools, escaped, and the PDF/UA identification only when asked', async () => {
  const doc = PdfDocument.create();
  doc.addPage();
  setXmpMetadata(doc, { title: 'Profit & <loss>', lang: 'de', creator: 'Golem Docs', pdfua: true });
  const back = PdfDocument.load(await doc.save());
  const metadata = back.catalog.get('Metadata');
  assert.ok(isName((back.resolve(metadata) as { dict: PdfDict }).dict.get('Subtype'), 'XML'));
  const xml = new TextDecoder().decode(back.streamData(metadata));
  assert.match(xml, /<rdf:li xml:lang="x-default">Profit &amp; &lt;loss&gt;<\/rdf:li>/);
  assert.match(xml, /<dc:language><rdf:Bag><rdf:li>de<\/rdf:li>/);
  assert.match(xml, /<xmp:CreatorTool>Golem Docs<\/xmp:CreatorTool>/);
  assert.match(xml, /<pdfuaid:part>1<\/pdfuaid:part>/);
  setXmpMetadata(doc, { title: 'Plain' });
  assert.doesNotMatch(new TextDecoder().decode(doc.streamData(doc.catalog.get('Metadata'))), /<pdfuaid:part>/);
});

test('a tagged document: marked content, an element over two pages, artifacts, the parent tree and the catalog', async () => {
  const doc = PdfDocument.create();
  doc.setMetadata('Title', 'Report');
  const tree = new StructureTree(doc);
  const font = doc.standardFont('Helvetica');
  const pages = [doc.addPage(), doc.addPage()];
  const heading: StructNode = { type: 'H1', children: [] };
  const paragraph: StructNode = { type: 'P', children: [] };
  tree.root.children.push(heading, paragraph, { type: 'Figure', alt: 'A chart', children: [], attributes: { Layout: { BBox: [0, 0, 10, 10] } } });
  pages.forEach((page, i) => {
    const d = page.draw();
    d.artifact(() => d.text(`Page ${i + 1}`, 300, 20, { font, size: 9 }), { type: 'Pagination', subtype: 'Footer' });
    if (i === 0) {
      const mark = tree.mark(page);
      heading.children.push(mark);
      d.marked('H1', mark.mcid, () => d.text('Title', 72, 720, { font, size: 20 }));
    }
    const mark = tree.mark(page);
    paragraph.children.push(mark);
    d.marked('P', mark.mcid, () => d.text(`Part ${i + 1}`, 72, 700, { font, size: 12 }));
    d.finish();
  });
  tree.write({ lang: 'en-GB' });
  const back = PdfDocument.load(await doc.save());

  const catalog = back.catalog;
  assert.equal(back.dict(catalog.get('MarkInfo'))?.get('Marked'), true);
  assert.equal((catalog.get('Lang') as PdfString).text, 'en-GB');
  assert.equal(back.dict(catalog.get('ViewerPreferences'))?.get('DisplayDocTitle'), true);

  const root = back.dict(catalog.get('StructTreeRoot'))!;
  const document = back.dict(root.get('K'))!;
  assert.ok(isName(document.get('S'), 'Document'));
  const [h1, p, figure] = (document.get('K') as PdfRef[]).map((r) => back.dict(r)!);
  // The heading's one mark is on its page; the paragraph's second mark is on the other page, so it is an MCR.
  assert.equal(h1.get('K'), 0);
  assert.equal((h1.get('Pg') as PdfRef).key, back.pages[0].ref.key);
  const [first, second] = p.get('K') as [number, PdfDict];
  assert.equal(first, 1);
  assert.ok(isName(second.get('Type'), 'MCR'));
  assert.equal((second.get('Pg') as PdfRef).key, back.pages[1].ref.key);
  assert.equal(second.get('MCID'), 0);
  assert.equal((figure.get('Alt') as PdfString).text, 'A chart');
  assert.ok(isName(back.dict(figure.get('A'))!.get('O'), 'Layout'));

  // The parent tree maps each page's MCIDs back to their elements.
  const nums = back.array(back.dict(root.get('ParentTree'))!.get('Nums'))!;
  const owners = (page: number) => (back.array(nums[nums.indexOf(back.pages[page].dict.get('StructParents')!) + 1]) as PdfRef[]).map((r) => (back.dict(r)!.get('S') as { name: string }).name);
  assert.deepEqual(owners(0), ['H1', 'P']);
  assert.deepEqual(owners(1), ['P']);
  assert.equal(root.get('ParentTreeNextKey'), 2);

  // The footers are artifacts; their text is still on the page.
  const ops = back.pages[1].operations().map((o) => o.op);
  assert.deepEqual(ops.filter((op) => op === 'BDC' || op === 'EMC'), ['BDC', 'EMC', 'BDC', 'EMC']);
  assert.equal(back.pages[1].extractText().text.replace(/\s+/g, ' ').trim(), 'Page 2 Part 2');
});
