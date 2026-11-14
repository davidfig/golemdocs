import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sdtTag, WordDocument, writeZip, ZipArchive, type Block, type Inline } from '../src/index.ts';

// A live table as LibreOffice (26.8) writes it back to .docx (liveRepair.ts). Checked by saving the app's own .docx
// through `soffice --convert-to docx:"MS Word 2007 XML"`: Writer keeps a live table's tag only when the table's first cell
// starts with text (or is empty), and then moves it there as a plain-text control (`<w:text/>`) whose content starts
// with an empty run. When the first cell starts with anything else (a live value, a link, a bookmark, another control, a
// nested table), Writer's import drops the table's tag altogether, so there is nothing to put back. Inline live values
// it writes without `<w:text/>`. The fixtures below are its layout, trimmed of properties.

const TABLE_TAG = 'live:Budget.xlsx#Expenses by=ab12 stamp=3f9a';
const VALUE_TAG = 'live:Budget.xlsx#Total by=ab12 stamp=77';

const control = (tag: string, plainText: boolean, content: string): string =>
  `<w:sdt><w:sdtPr><w:tag w:val="${tag}"/><w:lock w:val="sdtContentLocked"/>${plainText ? '<w:text/>' : ''}</w:sdtPr><w:sdtContent><w:r></w:r>${content}</w:sdtContent></w:sdt>`;
const r = (text: string, bold = false): string => `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const p = (...inner: string[]): string => `<w:p>${inner.join('')}</w:p>`;
const cell = (...inner: string[]): string => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${inner.join('')}</w:tc>`;
const table = (...cells: string[]): string => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${cells.map(() => '<w:gridCol w:w="2000"/>').join('')}</w:tblGrid><w:tr>${cells.join('')}</w:tr></w:tbl>`;

/** A .docx made by the app's writer with its body swapped for this XML. */
async function withBody(body: string): Promise<WordDocument> {
  const zip = ZipArchive.read(await (await WordDocument.create()).write());
  const xml = await zip.entries.get('word/document.xml')!.text();
  const swapped = xml.replace(/<w:body>[\s\S]*?(<w:sectPr)/, `<w:body>${body}$1`);
  assert.notEqual(swapped, xml);
  const entries = [...zip.entries.values()].map((e) => (e.name === 'word/document.xml' ? { name: e.name, data: new TextEncoder().encode(swapped) } : { name: e.name, entry: e }));
  return WordDocument.read(await writeZip(entries));
}

const tagOf = (b: Block | Inline): string | null => (b.kind === 'wrapper' ? (sdtTag(b.shell) ?? null) : null);
const text = (inlines: Inline[]): string => inlines.map((i) => (i.kind === 'run' ? i.content.map((c) => (c.kind === 'text' ? c.text : '')).join('') : i.kind === 'wrapper' || i.kind === 'hyperlink' ? `[${text(i.children)}]` : '')).join('');
function firstCell(b: Block): Block[] {
  const t = b.kind === 'wrapper' ? b.children[0] : b;
  assert.equal(t.kind, 'table');
  const row = t.kind === 'table' ? t.rows[0] : undefined;
  const c = row?.kind === 'row' ? row.cells[0] : undefined;
  assert.equal(c?.kind, 'cell');
  return c!.kind === 'cell' ? c!.children : [];
}

test('a live table tag LibreOffice moved into the first cell goes back around the table (text, bold text, empty cell, two paragraphs)', async () => {
  const doc = await withBody(
    table(cell(p(control(TABLE_TAG, true, r('Item', true) + r(' x')))), cell(p(r('b')))) +
      table(cell(p(control(TABLE_TAG, true, '<w:r></w:r>'))), cell(p(r('b')))) +
      table(cell(p(control(TABLE_TAG, true, r('p1'))), p(r('p2'))), cell(p(r('b')))),
  );
  assert.deepEqual(doc.body.slice(0, 3).map(tagOf), [TABLE_TAG, TABLE_TAG, TABLE_TAG]);
  for (const b of doc.body.slice(0, 3)) {
    // The plain-text mark goes; the lock stays.
    const props = b.kind === 'wrapper' ? b.shell.children.find((c) => typeof c !== 'string' && c.name === 'w:sdtPr') : undefined;
    assert.ok(props && typeof props !== 'string');
    assert.deepEqual(props.children.map((c) => (typeof c === 'string' ? c : c.name)), ['w:tag', 'w:lock']);
  }
  const cells = doc.body.slice(0, 3).map(firstCell);
  assert.equal(text((cells[0][0] as { children: Inline[] }).children), 'Item x');
  assert.equal(cells[0][0].kind === 'paragraph' && cells[0][0].children.some((i) => i.kind === 'run' && i.properties.bold), true, 'the cell keeps its bold');
  assert.equal(text((cells[1][0] as { children: Inline[] }).children), '');
  assert.deepEqual(cells[2].map((b) => (b.kind === 'paragraph' ? text(b.children) : b.kind)), ['p1', 'p2']);
});

test('a live value at the start of a first cell stays a value: LibreOffice writes it without <w:text/>', async () => {
  // A plain table whose first cell is a live value, or starts with one; and a live table whose first cell started with
  // a live value, after LibreOffice dropped the table's tag (only the value's is left).
  const doc = await withBody(
    table(cell(p(control(VALUE_TAG, false, r('7')))), cell(p(r('b')))) +
      table(cell(p(control(VALUE_TAG, false, r('8')), r(' more'))), cell(p(r('b')))) +
      table(cell(p(control(VALUE_TAG, false, r('42')), r(' items'))), cell(p(r('b')))),
  );
  assert.deepEqual(doc.body.slice(0, 3).map(tagOf), [null, null, null]);
  const firsts = doc.body.slice(0, 3).map((b) => firstCell(b)[0]);
  assert.deepEqual(
    firsts.map((f) => (f.kind === 'paragraph' ? f.children.filter((i) => i.kind === 'wrapper').map(tagOf) : [])),
    [[VALUE_TAG], [VALUE_TAG], [VALUE_TAG]],
  );
});

test('a moved tag is put back at any depth, and a plain-text control that is not a live one, or not first, is left alone', async () => {
  const inner = 'live:Inner.xlsx#T stamp=1';
  const doc = await withBody(
    // A live table in a cell of another (whose own tag LibreOffice dropped: the cell started with a table).
    table(cell(table(cell(p(control(inner, true, r('in'))))), p('<w:r></w:r>')), cell(p(r('b')))) +
      // Someone's own plain-text control.
      table(cell(p(control('mine', true, r('x')))), cell(p(r('b')))) +
      // A moved-looking live control after text in the cell.
      table(cell(p(r('before '), control(TABLE_TAG, true, r('x')))), cell(p(r('b')))),
  );
  assert.deepEqual(doc.body.slice(0, 3).map(tagOf), [null, null, null]);
  const nested = firstCell(doc.body[0])[0];
  assert.equal(tagOf(nested), inner);
  assert.equal(firstCell(nested)[0].kind, 'paragraph');
  assert.equal(firstCell(doc.body[1])[0].kind === 'paragraph' && tagOf((firstCell(doc.body[1])[0] as { children: Inline[] }).children[0]), 'mine');
});
