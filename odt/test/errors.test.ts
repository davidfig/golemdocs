import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeZip } from '@golemdocs/docx';
import { OdtError, readOdt } from '../src/index.ts';
import { minimalContent, odtPackage } from './fixtures.ts';

const enc = new TextEncoder();

async function rejects(input: Uint8Array | Promise<Uint8Array>, message: RegExp): Promise<void> {
  await assert.rejects(readOdt(await input), (e: unknown) => {
    assert.ok(e instanceof OdtError, `an OdtError, not ${(e as Error)?.constructor?.name}: ${(e as Error)?.message}`);
    assert.match((e as Error).message, message);
    return true;
  });
}

test('garbage is rejected with a clear error', async () => {
  await rejects(new Uint8Array(0), /empty/);
  await rejects(enc.encode('hello, world'), /not an OpenDocument text file/);
  await rejects(Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251), /not an OpenDocument text file/);
  await rejects(enc.encode('<html><body>hi</body></html>'), /not an OpenDocument text file/);
  await rejects(enc.encode('<office:document'), /not well-formed/);
});

test('other packages are named', async () => {
  await rejects(writeZip([{ name: '[Content_Types].xml', data: enc.encode('<Types/>') }, { name: 'word/document.xml', data: enc.encode('<w:document/>') }]), /Word \(\.docx\)/);
  await rejects(odtPackage({ content: minimalContent(''), mimetype: 'application/vnd.oasis.opendocument.spreadsheet' }), /OpenDocument spreadsheet/);
  await rejects(writeZip([{ name: 'mimetype', data: enc.encode('application/vnd.oasis.opendocument.text'), compress: false }]), /content\.xml is missing/);
  await rejects(writeZip([{ name: 'a.txt', data: enc.encode('x') }]), /content\.xml is missing/);
});

test('broken parts are reported', async () => {
  await rejects(odtPackage({ content: '<office:document-content><office:body><office:text><text:p>' }), /content\.xml is not well-formed/);
  await rejects(odtPackage({ content: '<foo/>' }), /unexpected root/);
  await rejects(
    odtPackage({
      content: '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body><office:spreadsheet/></office:body></office:document-content>',
    }),
    /not a text document/,
  );
  await rejects(odtPackage({ content: minimalContent('<text:p>ok</text:p>'), styles: '<office:document-styles><unclosed>' }), /styles\.xml is not well-formed/);
  // A truncated package.
  const good = await odtPackage({ content: minimalContent('<text:p>ok</text:p>') });
  await rejects(good.subarray(0, good.length - 30), /not an OpenDocument text file/);
});

test('odd but readable input does not crash', async () => {
  // Deep nesting, huge repeat counts, dangling references, unknown elements.
  const deep = '<text:span>'.repeat(5000) + 'deep' + '</text:span>'.repeat(5000);
  const body = `
    <text:p text:style-name="Missing">${deep}</text:p>
    <table:table><table:table-column table:number-columns-repeated="1000000"/>
      <table:table-row table:number-rows-repeated="1048576"><table:table-cell table:number-columns-spanned="99999"/></table:table-row>
    </table:table>
    <text:list text:continue-list="nowhere" text:style-name="Nope"><text:list-item text:start-value="abc"><text:p>x</text:p></text:list-item></text:list>
    <text:p><office:annotation-end office:name="none"/><text:bookmark-end text:name="none"/><foo:bar xmlns:foo="urn:x">text</foo:bar><text:s text:c="-5"/></text:p>
    <draw:frame><draw:image xlink:href="Pictures/missing.png"/></draw:frame>`;
  const { document, extension } = await readOdt(await odtPackage({ content: minimalContent(body) }));
  assert.ok(document.body.length >= 4);
  assert.ok(extension.objects?.length);
  assert.equal(extension.namespaces?.foo, 'urn:x');
});

test('repeat counts cannot multiply a small file into millions of cells', async () => {
  const row = '<table:table-row table:number-rows-repeated="256"><table:table-cell table:number-columns-repeated="256"/></table:table-row>';
  const wide = '<table:table-cell table:number-columns-spanned="256"/>'.repeat(40);
  const body = `<table:table>${row.repeat(40)}</table:table><table:table><table:table-row>${wide}</table:table-row></table:table>`;
  const { document } = await readOdt(await odtPackage({ content: minimalContent(body) }));
  const tables = document.body.filter((b) => b.kind === 'table');
  const cells = tables[0].rows.reduce((n, r) => n + (r.kind === 'row' ? r.cells.length : 0), 0);
  assert.ok(cells <= 200_000, `${cells} cells`);
  assert.equal(tables[0].rows[0].kind === 'row' && tables[0].rows[0].cells.length, 256, 'ordinary repeats still repeat');
  assert.ok(tables[1].grid.length <= 1024 + 40, `${tables[1].grid.length} grid columns`);
});

test('a deeply nested comment does not overflow the stack', async () => {
  const deep = '<text:span>'.repeat(20000) + 'note' + '</text:span>'.repeat(20000);
  const body = `<text:p>x<office:annotation><dc:creator>A</dc:creator><text:p>${deep}</text:p></office:annotation></text:p>`;
  const { document } = await readOdt(await odtPackage({ content: minimalContent(body) }));
  assert.deepEqual(document.comments[0].paragraphs, ['note']);
});
