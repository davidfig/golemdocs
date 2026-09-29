// Mapping between a paragraph's visible offsets and its model offsets (src/offsets.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toModel, toVisible, visibleLength, type SourceSpan } from '../src/offsets.ts';

const text = (visible: number, model: number, length: number): SourceSpan => ({ visible, model, length, modelLength: length, text: true });

/** "ab" [2 hidden characters] "cd": visible 0..4, model 0..6. */
const hidden: SourceSpan[] = [text(0, 0, 2), text(2, 4, 2)];
/** "ab", then a field showing "123" (visible 2..5) made of 20 model positions, then "cd". */
const field: SourceSpan[] = [text(0, 0, 2), { visible: 2, model: 2, length: 3, modelLength: 20, text: false }, text(5, 22, 2)];

test('with no spans everything is offset 0', () => {
  assert.equal(toModel([], 7), 0);
  assert.equal(toVisible([], 7), 0);
  assert.equal(visibleLength([]), 0);
});

test('plain text maps one to one, and each offset survives a round trip', () => {
  const plain = [text(0, 0, 10)];
  for (let i = 0; i <= 10; i++) {
    assert.equal(toModel(plain, i), i);
    assert.equal(toVisible(plain, i), i);
  }
  assert.equal(visibleLength(plain), 10);
  for (let v = 0; v <= 4; v++) assert.equal(toVisible(hidden, toModel(hidden, v)), v, `visible ${v}`);
});

test('offsets past the end map to the end', () => {
  assert.equal(toModel(hidden, 99), 6);
  assert.equal(toVisible(hidden, 99), 4);
});

test('toModel: at a boundary around hidden content, text typed continues the text before it', () => {
  assert.equal(toModel(hidden, 1), 1);
  assert.equal(toModel(hidden, 2), 2, 'right after "ab", not after the hidden characters');
  assert.equal(toModel(hidden, 3), 5);
  assert.equal(toModel(hidden, 4), 6);
  assert.equal(toModel(hidden, 0), 0);
});

test('toVisible: a position inside hidden content moves to the next visible one', () => {
  assert.equal(toVisible(hidden, 2), 2);
  assert.equal(toVisible(hidden, 3), 2);
  assert.equal(toVisible(hidden, 4), 2);
  assert.equal(toVisible(hidden, 5), 3);
  assert.equal(toVisible(hidden, 6), 4);
  assert.equal(toVisible(hidden, 0), 0);
});

test('an atomic item is entered only at its edges', () => {
  // Visible: inside the shown "123" the model position is the field's start.
  assert.equal(toModel(field, 2), 2);
  assert.equal(toModel(field, 3), 2);
  assert.equal(toModel(field, 4), 2);
  assert.equal(toModel(field, 5), 22, 'after the field: past all 20 of its positions');
  assert.equal(toModel(field, 6), 23);
  // Model: any position inside the field's instruction is the end of what it shows.
  assert.equal(toVisible(field, 2), 2);
  assert.equal(toVisible(field, 3), 5);
  assert.equal(toVisible(field, 21), 5);
  assert.equal(toVisible(field, 22), 5);
  assert.equal(toVisible(field, 24), 7);
  assert.equal(visibleLength(field), 7);
});

test('a first span that does not start at 0 clamps offsets before it', () => {
  const late = [text(5, 8, 3)];
  assert.equal(toModel(late, 2), 8);
  assert.equal(toVisible(late, 2), 0);
  assert.equal(toModel(late, 6), 9);
  assert.equal(toVisible(late, 9), 6);
});

test('lookups across many spans find the right one (binary search)', () => {
  const spans: SourceSpan[] = [];
  for (let i = 0; i < 100; i++) spans.push(text(i * 3, i * 5, 3)); // every 3 visible chars followed by 2 hidden
  for (let i = 0; i < 100; i++) {
    assert.equal(toModel(spans, i * 3 + 1), i * 5 + 1);
    assert.equal(toVisible(spans, i * 5 + 2), i * 3 + 2);
    assert.equal(toVisible(spans, i * 5 + 4), i * 3 + 3, 'hidden gap moves forward');
  }
  assert.equal(visibleLength(spans), 300);
});
