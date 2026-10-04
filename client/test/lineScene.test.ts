// Where lines, characters, carets and selections are in a big text file's document space (src/textEditor/scene.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LineIndex } from '../src/textEditor/lineIndex.ts';
import { CELL, LINE, LineScene } from '../src/textEditor/scene.ts';
import type { Entries } from '../src/textEditor/scene.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

/** Lays every entry out, as drawing does for those in view, so the heights are exact. */
function settleAll(s: LineScene, count: number): void {
  for (let entry = 0; entry < count; entry++) s.settle(entry);
}

async function scene(text: string, columns = 10): Promise<{ scene: LineScene; index: LineIndex }> {
  const index = new LineIndex(bytes(text), 0);
  await index.build();
  const all: Entries = { get count() { return index.count; }, lineOf: (e) => e, entryOf: (l) => l };
  const s = new LineScene(() => index, () => all);
  s.columns = columns;
  s.rebuild();
  settleAll(s, index.count);
  return { scene: s, index };
}

test('rows are estimated from the length of each line and laying a line out corrects them', async () => {
  const { scene: s } = await scene('short\n' + 'x'.repeat(35) + '\nend\n', 10);
  assert.equal(s.totalRows, 1 + 4 + 1);
  assert.equal(s.top(2), 5 * LINE);
  // The estimate goes by bytes (never fewer than characters), so wide characters, which are three bytes and two cells, are over-counted.
  const wide = await scene('日本語日本語日本語日本語日本語\n', 10);
  wide.scene.rebuild(); // back to the estimate
  assert.equal(wide.scene.totalRows, 5); // 45 bytes
  assert.equal(wide.scene.settle(0), -2); // thirty cells: really three
  assert.equal(wide.scene.totalRows, 3);
  assert.equal(wide.scene.settle(0), 0);
});

test('the entry at a height, and the row in it', async () => {
  const { scene: s } = await scene('a\n' + 'b'.repeat(25) + '\nc\n', 10);
  assert.deepEqual(s.locate(0), { entry: 0, within: 0 });
  assert.deepEqual(s.locate(LINE * 1.5), { entry: 1, within: 0 });
  assert.deepEqual(s.locate(LINE * 3.2), { entry: 1, within: 2 });
  assert.deepEqual(s.locate(LINE * 4.2), { entry: 2, within: 0 });
  assert.deepEqual(s.locate(1e9), { entry: 2, within: 0 });
});

test('without wrapping every line is one row and the content is as wide as the widest line seen', async () => {
  const { scene: s } = await scene('abc\n' + 'x'.repeat(200) + '\n');
  s.wrap = false;
  s.rebuild();
  assert.equal(s.totalRows, 2);
  s.layout(0);
  s.layout(1);
  assert.equal(s.widest, 200);
  assert.equal(s.bounds.width, s.textLeft + 200 * CELL + 6);
  assert.equal(s.layout(1).rows.length, 1);
});

test('a caret box and a click agree', async () => {
  const { scene: s } = await scene('hello world\n日本 tab\there\nlast\n', 8);
  for (const pos of [{ line: 0, col: 0 }, { line: 0, col: 5 }, { line: 0, col: 9 }, { line: 1, col: 1 }, { line: 1, col: 3 }, { line: 1, col: 8 }, { line: 2, col: 4 }]) {
    const box = s.caretBox(pos)!;
    const hit = s.pointAt(box.x + 0.01, box.y + LINE / 2)!;
    assert.deepEqual(hit, pos, JSON.stringify(pos));
  }
  // The right half of a cell goes to the next character.
  const at = s.caretBox({ line: 0, col: 2 })!;
  assert.deepEqual(s.pointAt(at.x + CELL * 0.6, at.y + 1), { line: 0, col: 3 });
  assert.deepEqual(s.pointAt(at.x + CELL * 0.4, at.y + 1), { line: 0, col: 2 });
});

test('a click above, below and beyond the text lands at the start, the end, and the end of the line', async () => {
  const { scene: s } = await scene('abc\ndef\n');
  assert.deepEqual(s.pointAt(0, -50), { line: 0, col: 0 });
  assert.deepEqual(s.pointAt(0, 1e6), { line: 1, col: 3 });
  assert.deepEqual(s.pointAt(1e6, LINE * 0.5), { line: 0, col: 3 });
  assert.deepEqual(s.pointAt(-1e6, LINE * 0.5), { line: 0, col: 0 });
});

test('a caret in the second row of a wrapped line is on that row', async () => {
  const { scene: s } = await scene('abcdefghijklmnopqrstuvwxyz\nnext\n', 10);
  assert.deepEqual(s.caretBox({ line: 0, col: 12 })!, { x: s.textLeft + 2 * CELL, y: LINE, width: 0, height: LINE });
  assert.deepEqual(s.pointAt(s.textLeft + 2 * CELL + 1, LINE * 1.5), { line: 0, col: 12 });
  assert.deepEqual(s.caretBox({ line: 1, col: 0 })!.y, 3 * LINE);
});

test('a selection inside one line is one rectangle, across a wrap two, and across lines a block with the line breaks shown', async () => {
  const { scene: s } = await scene('abcdefghijklmnopqrstuvwxyz\nsecond\nthird\n', 10);
  const sel = (a: [number, number], b: [number, number]) => ({ anchor: { line: a[0], col: a[1] }, focus: { line: b[0], col: b[1] } });
  assert.deepEqual(s.selection(sel([1, 2], [1, 5]), 0, 2), [{ x: s.textLeft + 2 * CELL, y: 3 * LINE, width: 3 * CELL, height: LINE }]);
  assert.equal(s.selection(sel([0, 8], [0, 14]), 0, 2).length, 2);
  const block = s.selection(sel([0, 24], [2, 2]), 0, 2);
  // Two characters of the last row of the first line (and its line break), the whole second line (and break), two of the third.
  assert.deepEqual(block.map((r) => [r.y / LINE, r.width / CELL]), [[2, 3], [3, 7], [4, 2]]);
  assert.deepEqual(s.selection(sel([1, 2], [1, 2]), 0, 2), []);
  // Only the entries asked for are visited.
  assert.equal(s.selection(sel([0, 0], [2, 5]), 2, 2).length, 1);
});

test('an empty line inside a selection shows as one cell', async () => {
  const { scene: s } = await scene('a\n\nb\n');
  const rects = s.selection({ anchor: { line: 0, col: 0 }, focus: { line: 2, col: 1 } }, 0, 2);
  assert.deepEqual(rects.map((r) => r.width / CELL), [2, 1, 1]);
});

test('matches are found on each row they fall in', async () => {
  const { scene: s } = await scene('foo bar foo\nxxfooxx\n', 8);
  const rects = s.matches(/foo/g, false, 0, 1);
  // 'foo bar foo' wraps after eight cells: the first foo and the start of the second row's foo.
  assert.deepEqual(rects.map((r) => [r.y / LINE, (r.x - s.textLeft) / CELL, r.width / CELL]), [[0, 0, 3], [1, 0, 3], [2, 2, 3]]);
});

test('the gutter is as wide as the biggest line number, and a click there is a click on the numbers', async () => {
  const small = await scene('a\nb\n');
  const big = await scene(Array.from({ length: 12000 }, (_, i) => String(i)).join('\n'));
  assert.equal(small.scene.gutterCells, 3);
  assert.equal(big.scene.gutterCells, 7);
  assert.equal(small.scene.inGutter(CELL), true);
  assert.equal(small.scene.inGutter(small.scene.textLeft + CELL), false);
});

test('the number of columns follows the window at 100% and says whether it changed', async () => {
  const { scene: s } = await scene('abc\n');
  assert.equal(s.setViewportWidth(s.textLeft + 6 + 100 * CELL), true);
  assert.equal(s.columns, 100);
  assert.equal(s.setViewportWidth(s.textLeft + 6 + 100 * CELL), false);
  s.setViewportWidth(10);
  assert.equal(s.columns, 20);
});

test('a line cut at the length shown puts its caret at the end of what is shown', async () => {
  const { scene: s } = await scene(`${'x'.repeat(30_000)}\nnext\n`, 100);
  assert.equal(s.layout(0).text.length, 20_000);
  assert.deepEqual(s.pointAt(1e6, LINE * 0.5), { line: 0, col: 100 });
});
