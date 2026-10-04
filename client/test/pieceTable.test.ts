// Editing a big text file: the piece table, the line index kept in step with it, and undo (src/textEditor).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LineIndex, lineText } from '../src/textEditor/lineIndex.ts';
import { PieceTable } from '../src/textEditor/pieceTable.ts';
import { TextDocument } from '../src/textEditor/textDocument.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** A small deterministic random number generator, so a failure can be run again. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function fresh(model: Uint8Array): Promise<LineIndex> {
  const index = new LineIndex(model);
  await index.build();
  return index;
}

/** Every line of an index, as text, with where it starts. */
const lines = (index: LineIndex) => Array.from({ length: index.count }, (_, i) => `${index.range(i).from}:${lineText(index, i).text}`);

test('a piece table reads back what was put in, across pieces', () => {
  const table = new PieceTable(bytes('hello world'));
  table.replace(5, 0, bytes(','));
  table.replace(0, 0, bytes('>> '));
  table.replace(table.length, 0, bytes('!'));
  assert.equal(text(table.flatten()), '>> hello, world!');
  assert.equal(text(table.slice(3, 8)), 'hello');
  assert.equal(text(table.slice(8, 12)), ', wo');
  assert.equal(table.byteAt(3), 'h'.charCodeAt(0));
  assert.equal(table.indexOf('w'.charCodeAt(0)), 10);
  assert.equal(table.indexOf('z'.charCodeAt(0)), -1);
  table.replace(3, 6, new Uint8Array(0));
  assert.equal(text(table.flatten()), '>>  world!');
});

test('typing one character after another stays in one piece', () => {
  const table = new PieceTable(bytes('ab'));
  table.replace(1, 0, bytes('x'));
  for (let i = 0; i < 200; i++) table.replace(2 + i, 0, bytes('y'));
  assert.equal(table.pieceCount, 3);
  assert.equal(table.length, 203);
});

test('an empty table can be typed into and emptied', () => {
  const table = new PieceTable();
  assert.equal(table.length, 0);
  assert.equal(table.replace(0, 0, new Uint8Array(0)), null);
  table.replace(0, 0, bytes('abc'));
  table.replace(0, 3, new Uint8Array(0));
  assert.equal(table.length, 0);
  assert.equal(text(table.flatten()), '');
});

test('random edits match a plain array, and the line index matches one built from scratch', async () => {
  for (const [seed, alphabet, start] of [
    [1, ['a', 'b', '\n', 'é', ' '], 'one\ntwo\n\nthree é\nfour'],
    [2, ['a', '\r\n', '\n', 'z'], 'a\r\nb\r\nc\n'],
    [3, ['a', '\r', 'q'], 'one\rtwo\r\rthree\r'],
    [4, ['x', '\n'], ''],
    [5, ['x', 'y', '\n', '\n'], '\n'],
  ] as const) {
    const next = random(seed);
    let model = bytes(start);
    const doc = new TextDocument(model, 0);
    await doc.index.build();
    for (let step = 0; step < 400; step++) {
      const at = Math.floor(next() * (model.length + 1));
      const remove = next() < 0.5 ? 0 : Math.floor(next() * Math.min(12, model.length - at + 1));
      let insert = '';
      for (let n = Math.floor(next() * 5); n > 0; n--) insert += alphabet[Math.floor(next() * alphabet.length)];
      const added = bytes(insert);
      doc.replace(at, remove, added);
      const copy = new Uint8Array(model.length - Math.min(remove, model.length - at) + added.length);
      copy.set(model.subarray(0, at));
      copy.set(added, at);
      copy.set(model.subarray(at + Math.min(remove, model.length - at)), at + added.length);
      model = copy;
      if (step % 7 === 0 || step > 390) {
        assert.equal(text(doc.table.flatten()), text(model), `seed ${seed} step ${step}: text`);
        assert.deepEqual(lines(doc.index), lines(await fresh(model)), `seed ${seed} step ${step}: lines`);
      }
    }
  }
});

test('undo and redo walk back and forward through random edits', async () => {
  const next = random(42);
  const original = 'alpha\nbeta\r\ngamma\n\ndelta';
  const doc = new TextDocument(bytes(original), 0);
  await doc.index.build();
  const states: Uint8Array[] = [bytes(original)];
  for (let step = 0; step < 150; step++) {
    const length = doc.table.length;
    const at = Math.floor(next() * (length + 1));
    const remove = next() < 0.4 ? 0 : Math.floor(next() * Math.min(8, length - at + 1));
    const insert = ['x', 'yy', '\n', 'é\n', '', 'q'][Math.floor(next() * 6)];
    // No grouping, so each edit is a step of its own.
    if (doc.replace(at, remove, bytes(insert))) states.push(doc.table.flatten().slice());
  }
  for (let i = states.length - 1; i > 0; i--) {
    assert.deepEqual(doc.table.flatten(), states[i]);
    assert.deepEqual(lines(doc.index), lines(await fresh(states[i])));
    assert.ok(doc.undo());
  }
  assert.equal(text(doc.table.flatten()), original);
  assert.equal(doc.canUndo, false);
  for (let i = 1; i < states.length; i++) {
    assert.ok(doc.redo());
    assert.deepEqual(doc.table.flatten(), states[i]);
    assert.deepEqual(lines(doc.index), lines(await fresh(states[i])));
  }
  assert.equal(doc.redo(), null);
});

test('typing in a row is one undo step, and a pause or another kind of edit starts a new one', async () => {
  const doc = new TextDocument(bytes('start'), 0);
  await doc.index.build();
  let at = 5;
  for (const ch of 'abc') {
    doc.replace(at, 0, bytes(ch), 'type', 1000);
    at++;
  }
  doc.replace(at, 0, bytes('d'), 'type', 5000); // a pause
  doc.replace(0, 1, new Uint8Array(0), 'delete', 5100);
  assert.equal(text(doc.table.flatten()), 'tartabcd');
  doc.undo();
  assert.equal(text(doc.table.flatten()), 'startabcd');
  doc.undo();
  assert.equal(text(doc.table.flatten()), 'startabc');
  doc.undo();
  assert.equal(text(doc.table.flatten()), 'start');
  assert.equal(doc.canUndo, false);
});

test('backspacing in a row is one undo step, and the caret goes back to where it began', async () => {
  const doc = new TextDocument(bytes('hello'), 0);
  await doc.index.build();
  doc.replace(4, 1, new Uint8Array(0), 'backspace', 0);
  doc.replace(3, 1, new Uint8Array(0), 'backspace', 10);
  doc.replace(2, 1, new Uint8Array(0), 'backspace', 20);
  assert.equal(text(doc.table.flatten()), 'he');
  const change = doc.undo();
  assert.equal(text(doc.table.flatten()), 'hello');
  assert.equal(change?.caret, 2);
  assert.equal(doc.redo()?.caret, 2);
  assert.equal(text(doc.table.flatten()), 'he');
});

test('a change reports the lines it touched and whether there are more or fewer', async () => {
  const doc = new TextDocument(bytes('a\nb\nc\n'), 0);
  await doc.index.build();
  const split = doc.replace(1, 0, bytes('\n'));
  assert.deepEqual([split?.firstLine, split?.lineDelta], [0, 1]);
  assert.equal(doc.index.count, 4);
  const join = doc.replace(1, 1, new Uint8Array(0));
  assert.equal(join?.lineDelta, -1);
  const inside = doc.replace(0, 0, bytes('zz'));
  assert.deepEqual([inside?.firstLine, inside?.lastLine, inside?.lineDelta], [0, 0, 0]);
});

test('a rewritten text can be swapped in, and undone and redone, without losing the edits before it', async () => {
  const doc = new TextDocument(bytes('one\ntwo\n'), 0);
  await doc.index.build();
  doc.replace(0, 0, bytes('0 '));
  const rewritten = new TextDocument(bytes('REWRITTEN\n'), 0);
  await rewritten.index.build();
  doc.swap({ table: rewritten.table, index: rewritten.index });
  assert.equal(text(doc.table.flatten()), 'REWRITTEN\n');
  assert.equal(doc.index.count, 1);
  doc.undo();
  assert.equal(text(doc.table.flatten()), '0 one\ntwo\n');
  assert.equal(doc.index.count, 2);
  doc.undo();
  assert.equal(text(doc.table.flatten()), 'one\ntwo\n');
  doc.redo();
  doc.redo();
  assert.equal(text(doc.table.flatten()), 'REWRITTEN\n');
});

test('editing a 500,000-line file touches only the lines around the edit', async () => {
  const big = new Uint8Array(bytes('x'.repeat(99) + '\n').length * 500_000);
  const line = bytes('x'.repeat(99) + '\n');
  for (let i = 0; i < 500_000; i++) big.set(line, i * line.length);
  const doc = new TextDocument(big);
  await doc.index.build();
  assert.equal(doc.index.count, 500_000);
  const started = performance.now();
  for (let i = 0; i < 200; i++) doc.replace(40_000_000 + i, 0, bytes('k'), 'type');
  doc.replace(40_000_300, 0, bytes('\n'));
  const elapsed = performance.now() - started;
  assert.equal(doc.index.count, 500_001);
  assert.equal(lineText(doc.index, 399_999).text.startsWith('x'), true);
  assert.equal(lineText(doc.index, 400_000).text.startsWith('kkk'), true);
  assert.ok(elapsed < 250, `201 edits took ${elapsed.toFixed(0)} ms`);
});
