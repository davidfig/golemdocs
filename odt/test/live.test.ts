import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WordDocument, ZipArchive, writeZip, type Block, type Hyperlink, type Inline, type Paragraph, type Run, type Wrapper } from '@golemdocs/docx';
import { readOdt, writeOdt } from '../src/index.ts';
import { liveTagOf, liveWrapperOf } from '../src/live.ts';
import { find, textOf, validateOdt } from './validate.ts';

// Live blocks (live.ts) as LibreOffice keeps them: checked by opening and saving the written files in LibreOffice 26.8
// (docs/live-blocks.md, M0 results).

const run = (text: string, properties: Run['properties'] = {}): Run => ({ kind: 'run', properties, content: [{ kind: 'text', text }], attrs: {} });
const para = (...children: Inline[]): Paragraph => ({ kind: 'paragraph', properties: {}, children, attrs: {} });
const link = (url: string, ...children: Inline[]): Hyperlink => ({ kind: 'hyperlink', url, children, attrs: {} });

const BLOCK = 'live:Budget.xlsx#Expenses by=ab12 stamp=3f9a';
const VALUE = 'live:Budget.xlsx#Total by=ab12 stamp=77';

async function document(body: Block[]): Promise<WordDocument> {
  const doc = await WordDocument.create();
  doc.body = body;
  return doc;
}

/** The inlines of a paragraph as text, with each live value and link marked, and bold and italic runs. */
function show(inlines: Inline[]): string {
  return inlines
    .map((i) => {
      if (i.kind === 'run') return i.content.map((c) => (c.kind === 'text' ? c.text : '')).join('') + (i.properties.bold ? '{b}' : '') + (i.properties.italic ? '{i}' : '');
      if (i.kind === 'hyperlink') return `<a ${i.url}>${show(i.children)}</a>`;
      if (i.kind === 'wrapper') return `<${liveTagOf(i)}>${show(i.children)}</>`;
      return '';
    })
    .join('|');
}

test('two live blocks with the same tag get unique section names and read back with the exact tag', async () => {
  const doc = await document([
    liveWrapperOf<Block>(BLOCK, [para(run('one'))]),
    para(run('between')),
    liveWrapperOf<Block>(BLOCK, [para(run('two'))]),
    liveWrapperOf<Block>(BLOCK, [para(run('three'))]),
  ]);
  const bytes = await writeOdt(doc);
  const { content } = await validateOdt(bytes);
  const names = find(content, 'text:section').map((s) => s.attrs['text:name']);
  assert.deepEqual(names, [BLOCK, `${BLOCK} copy=2`, `${BLOCK} copy=3`]);
  const { document: back } = await readOdt(bytes);
  assert.deepEqual(
    back.body.map((b) => liveTagOf(b)),
    [BLOCK, null, BLOCK, BLOCK],
  );
  // A tag that itself ends like the suffix keeps it.
  const odd = 'live:Notes copy=2';
  const again = await readOdt(await writeOdt(await document([liveWrapperOf<Block>(odd, [para(run('x'))]), liveWrapperOf<Block>(odd, [para(run('y'))])])));
  assert.deepEqual(again.document.body.map((b) => liveTagOf(b)), [odd, odd]);
});

test('a live value keeps its bold and italic runs (a text:meta), and a plain one in one format stays a field', async () => {
  const doc = await document([
    para(run('Value: '), liveWrapperOf<Inline>(VALUE, [run('$4,'), run('210', { bold: true }), run('  net', { italic: true })]), run(' end')),
    para(run('All bold: '), liveWrapperOf<Inline>(VALUE, [run('9', { bold: true })])),
  ]);
  const bytes = await writeOdt(doc);
  const { content } = await validateOdt(bytes);
  const metas = find(content, 'text:meta');
  assert.equal(metas.length, 1);
  assert.equal(metas[0].attrs['xhtml:content'], VALUE);
  assert.equal(textOf(metas[0]), '$4,210 net');
  assert.equal(find(metas[0], 'text:s').length, 1, 'the second space is kept');
  const fields = find(content, 'text:text-input');
  assert.equal(fields.length, 1);
  assert.equal(fields[0].attrs['text:description'], VALUE);
  const { document: back } = await readOdt(bytes);
  assert.equal(show((back.body[0] as Paragraph).children), `Value: |<${VALUE}>$4,|210{b}|  net{i}</>| end`);
  assert.equal(show((back.body[1] as Paragraph).children), `All bold: |<${VALUE}>9{b}</>`);
});

test('a live value inside a link keeps its tag, plain or formatted, and a link inside a live value stays in it', async () => {
  const doc = await document([
    para(run('See '), link('http://a.example', run('x '), liveWrapperOf<Inline>(VALUE, [run('5')]), run(' y')), run(' z')),
    para(link('http://b.example', run('n '), liveWrapperOf<Inline>(VALUE, [run('1', { bold: true }), run('2')]))),
    para(liveWrapperOf<Inline>(VALUE, [run('see '), link('http://c.example', run('here', { italic: true }))])),
  ]);
  const bytes = await writeOdt(doc);
  await validateOdt(bytes);
  const { document: back } = await readOdt(bytes);
  assert.deepEqual(
    back.body.map((b) => show((b as Paragraph).children)),
    [
      `See |<a http://a.example>x |<${VALUE}>5</>| y</a>| z`,
      `<a http://b.example>n |<${VALUE}>1{b}|2</></a>`,
      `<${VALUE}>see |<a http://c.example>here{i}</a></>`,
    ],
  );
});

/** An ODT the app wrote, with the body (office:text's content) swapped for this XML, as LibreOffice would have written it. */
async function withText(xml: string): Promise<Uint8Array> {
  const zip = ZipArchive.read(await writeOdt(await document([para(run('x'))])));
  const files: { name: string; data: Uint8Array }[] = [];
  for (const [name, entry] of zip.entries) files.push({ name, data: await entry.read() });
  const content = files.find((f) => f.name === 'content.xml')!;
  const before = new TextDecoder().decode(content.data);
  const after = before.replace(/(<office:text[^>]*>)[\s\S]*(<\/office:text>)/, `$1${xml}$2`);
  assert.notEqual(after, before);
  content.data = new TextEncoder().encode(after);
  return writeZip(files.map((f) => ({ name: f.name, data: f.data, compress: f.name !== 'mimetype' })));
}

test('a live value as LibreOffice writes it back: its own namespace prefix, and the meta moved outside a link it filled', async () => {
  // LibreOffice renames the RDFa prefix and, when a value is a link's whole text, puts the link inside the meta.
  const lo =
    `<text:p><text:meta xml:id="golem-live-1" xhtml:content="${VALUE}" xmlns:gen="urn:golemdocs:" xhtml:property="gen:live" xhtml:about="urn:golemdocs:live">` +
    `<text:a xlink:type="simple" xlink:href="http://d.example/">1</text:a></text:meta></text:p>`;
  const { document: back } = await readOdt(await withText(lo));
  assert.equal(show((back.body[0] as Paragraph).children), `<${VALUE}><a http://d.example/>1</a></>`);
});

test("LibreOffice's own content controls: live values, and a live table's tag it moved into the first cell", async () => {
  // What LibreOffice writes for a .docx with live blocks converted to ODT (checked with LibreOffice 26.8).
  const control = (tag: string, plainText: boolean, inner: string): string =>
    `<loext:content-control${plainText ? ' loext:plain-text="true"' : ''} loext:tag="${tag}" loext:lock="sdtContentLocked"${inner ? `>${inner}</loext:content-control>` : '/>'}`;
  const table = (first: string): string =>
    `<table:table table:name="T"><table:table-column/><table:table-column/><table:table-row>` +
    `<table:table-cell office:value-type="string">${first}</table:table-cell>` +
    `<table:table-cell office:value-type="string"><text:p>b</text:p></table:table-cell></table:table-row></table:table>`;
  const inner = 'live:Inner.xlsx#T stamp=1';
  const { document: back } = await readOdt(
    await withText(
      `<text:p>Value: ${control(VALUE, false, '$4,<text:span text:style-name="T1">210</text:span>')} end</text:p>` +
        table(`<text:p>${control(BLOCK, true, 'Item x')}</text:p>`) +
        table(`<text:p>${control(BLOCK, true, '')}</text:p>`) +
        table(`<text:p>${control(VALUE, false, '42')} items</text:p>`) +
        table(table(`<text:p>${control(inner, true, 'in')}</text:p>`) + '<text:p/>') +
        `<text:p>${control('mine', false, 'theirs')}</text:p>`,
    ),
  );
  assert.equal(show((back.body[0] as Paragraph).children), `Value: |<${VALUE}>$4,210</>| end`);
  // Moved tags go back around their tables, as in a .docx (docx liveRepair.ts), the plain-text mark dropped.
  assert.deepEqual(back.body.slice(1).map((b) => liveTagOf(b)), [BLOCK, BLOCK, null, null, null]);
  const firstCell = (b: Block): Block[] => {
    const t = b.kind === 'wrapper' ? b.children[0] : b;
    assert.ok(t.kind === 'table' && t.rows[0].kind === 'row' && t.rows[0].cells[0].kind === 'cell');
    return t.rows[0].cells[0].children;
  };
  assert.equal(show((firstCell(back.body[1])[0] as Paragraph).children), 'Item x');
  const props = (back.body[1] as Wrapper<Block>).shell.children.find((c) => typeof c !== 'string' && c.name === 'w:sdtPr');
  assert.ok(props && typeof props !== 'string' && !props.children.some((c) => typeof c !== 'string' && c.name === 'w:text'));
  // A live value first in a plain table's cell stays a value; a nested table's moved tag is put back at its depth.
  assert.equal(show((firstCell(back.body[3])[0] as Paragraph).children), `<${VALUE}>42</>| items`);
  assert.equal(liveTagOf(firstCell(back.body[4])[0]), inner);
  // Someone else's control is read as its text.
  assert.equal(show((back.body[5] as Paragraph).children), 'theirs');
  // Written again, they are the app's own forms.
  const { content } = await validateOdt(await writeOdt(back));
  assert.deepEqual(find(content, 'text:section').map((s) => s.attrs['text:name']), [BLOCK, `${BLOCK} copy=2`, inner]);
});
