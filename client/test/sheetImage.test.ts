// The memory image (docs/spreadsheets.md, "The memory image"): a workbook mapped from its image is the workbook read from
// its file, and an image is used only for exactly the file it was made from.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Image, ImageWriter, fingerprint, openImage } from '../src/image/container.ts';
import { Kind } from '../src/sheet/model/column.ts';
import { isWorksheet } from '../src/sheet/model/workbook.ts';
import type { Workbook } from '../src/sheet/model/workbook.ts';
import type { Worksheet } from '../src/sheet/model/worksheet.ts';
import { KIND, SCHEMA, mapWorkbook, workbookImage } from '../src/sheet/image.ts';
import { readWorkbook } from '../src/sheet/xlsx/read.ts';
import { writeWorkbook } from '../src/sheet/xlsx/write.ts';

const DIR = path.join(import.meta.dirname, 'fixtures/sheets/oracle');

/** Everything a reader of the model sees, for comparing two workbooks. */
function describe(book: Workbook): unknown {
  return {
    active: book.activeSheet,
    names: book.names,
    sheets: book.sheets.map((sheet) => {
      if (!isWorksheet(sheet)) return sheet;
      const cells: unknown[] = [];
      sheet.grid.columns.forEach((column, c) =>
        column?.forEach(0, sheet.grid.rows, (row, kind, value, style) => cells.push([row, c, kind, kind === Kind.String ? book.strings.get(value) : value, style])),
      );
      return {
        name: sheet.name,
        extent: [sheet.grid.rows, sheet.grid.cols],
        cells,
        formulas: sheet.grid.columns.map((c) => c?.formulas ?? []),
        rows: [...sheet.rowSizes.specials()].map((r) => [r, sheet.rowSizes.size(r)]),
        cols: [...sheet.colSizes.specials()].map((c) => [c, sheet.colSizes.size(c)]),
        merges: sheet.merges,
        pane: sheet.pane,
        attrs: [...sheet.cellAttrs],
      };
    }),
  };
}

test('the container keeps typed sections aligned and refuses a different source, kind or schema', async () => {
  const source = await fingerprint(new Uint8Array([1, 2, 3]));
  const writer = new ImageWriter('test', 3, source);
  writer.array('bytes', new Uint8Array([1, 2, 3]));
  writer.array('doubles', new Float64Array([1.5, -2.25]));
  writer.json('meta', { a: 1 });
  const bytes = writer.finish();
  const image = Image.parse(bytes)!;
  assert.deepEqual([...image.array<Float64Array>('doubles')], [1.5, -2.25]);
  assert.deepEqual(image.json('meta'), { a: 1 });
  assert.ok(openImage(bytes, 'test', 3, source));
  assert.equal(openImage(bytes, 'test', 4, source), null, 'another schema');
  assert.equal(openImage(bytes, 'other', 3, source), null, 'another kind');
  assert.equal(openImage(bytes, 'test', 3, await fingerprint(new Uint8Array([1, 2, 4]))), null, 'another file');
  assert.equal(openImage(new Uint8Array(40), 'test', 3, source), null, 'not an image');
});

test('a workbook mapped from its image is the workbook read from its file', async () => {
  for (const name of readdirSync(DIR).filter((f) => f.endsWith('.xlsx'))) {
    const xlsx = readFileSync(path.join(DIR, name));
    const read = await readWorkbook(xlsx);
    const source = await fingerprint(xlsx);
    const mapped = await mapWorkbook(workbookImage(read, source), xlsx, source);
    assert.ok(mapped, name);
    assert.deepEqual(describe(mapped), describe(read), name);
  }
});

test('a mapped workbook edits without touching its image, and saves as the read one does', async () => {
  const xlsx = readFileSync(path.join(DIR, 'math.xlsx'));
  const source = await fingerprint(xlsx);
  const imageBytes = workbookImage(await readWorkbook(xlsx), source);
  const copy = imageBytes.slice();
  const mapped = (await mapWorkbook(imageBytes, xlsx, source))!;
  const sheet = mapped.sheets[0] as Worksheet;
  sheet.grid.set(1, 0, Kind.String, mapped.strings.add('edited'), 0);
  sheet.grid.insertRows(3, 2);
  sheet.rowSizes.set(1, 40);
  sheet.dirty.cells = true;
  assert.deepEqual(imageBytes, copy, 'the image is never written to');
  const back = await readWorkbook(await writeWorkbook(mapped));
  const again = back.sheets[0] as Worksheet;
  assert.equal(back.strings.get(again.grid.columns[0]!.value(1)), 'edited');
  assert.equal(again.rowSizes.size(1), 40);
  assert.equal(KIND, 'sheet');
  assert.ok(SCHEMA >= 1);
});

test('a sheet not read yet stays unread through the image, and reads from the file when asked', async () => {
  const xlsx = readFileSync(path.join(DIR, 'math.xlsx'));
  const source = await fingerprint(xlsx);
  const partial = await readWorkbook(xlsx, { activeOnly: true });
  const mapped = (await mapWorkbook(workbookImage(partial, source), xlsx, source))!;
  assert.equal(mapped.source!.parts[1].loaded, false);
  const { loadSheet } = await import('../src/sheet/xlsx/read.ts');
  await loadSheet(mapped, 1);
  assert.equal((mapped.sheets[1] as Worksheet).grid.columns[0]!.value(0), 1);
});
