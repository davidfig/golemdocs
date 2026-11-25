// The cell editor's box (sheet/editorBox.ts): the cell's own, then wider to the view's width, then taller.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editorBox, growSpan } from '../src/sheet/editorBox.ts';
import { darkPageColor } from '../src/webgl/program.ts';
import { dateInput, parseDateInput } from '../src/sheet/input.ts';

const VIEW = { x0: 30, y0: 50, x1: 1030, y1: 650 };
const CELL = { x0: 230, y0: 90, x1: 330, y1: 110 };
/** Text so wide on one line, wrapping into lines 20 high. */
const text = (width: number) => ({ width, height: (w: number) => Math.ceil(width / w) * 20 });

test('text that fits leaves the box the size of its cell', () => {
  assert.deepEqual(editorBox(CELL, VIEW, text(80), 'start', false), CELL);
});

test('longer text grows the box right, then left to the full width, then down', () => {
  assert.deepEqual(editorBox(CELL, VIEW, text(400), 'start', false), { ...CELL, x1: 630 });
  assert.deepEqual(editorBox(CELL, VIEW, text(900), 'start', false), { ...CELL, x0: 130, x1: 1030 });
  assert.deepEqual(editorBox(CELL, VIEW, text(2500), 'start', false), { x0: 30, x1: 1030, y0: 90, y1: 150 });
});

test('right-aligned and centered cells grow from the edge their text is on', () => {
  assert.deepEqual(growSpan(230, 330, 200, 30, 1030, 'end'), [130, 330]);
  assert.deepEqual(growSpan(230, 330, 200, 30, 1030, 'middle'), [180, 380]);
});

test('a wrapped cell keeps its width and grows down', () => {
  assert.deepEqual(editorBox(CELL, VIEW, text(250), 'start', true), { ...CELL, y1: 150 });
});

test('the box stays in view: up from the bottom, and no taller than the view', () => {
  const low = { ...CELL, y0: 630, y1: 650 };
  assert.deepEqual(editorBox(low, VIEW, text(2500), 'start', false), { x0: 30, x1: 1030, y0: 590, y1: 650 });
  assert.deepEqual(editorBox(CELL, VIEW, text(90_000), 'start', false), VIEW);
});

test('a cell cut by the view, or scrolled out of it', () => {
  assert.deepEqual(growSpan(950, 1100, 10, 30, 1030, 'start'), [950, 1030]);
  assert.deepEqual(growSpan(-50, 60, 200, 30, 1030, 'start'), [-50, 150]);
  assert.deepEqual(growSpan(1200, 1300, 500, 30, 1030, 'start'), [1200, 1300]);
});

test("today's date is typed the way a typed date is read back", () => {
  assert.equal(dateInput(new Date(2026, 10, 5)), '11/5/2026');
  assert.equal(parseDateInput(dateInput(new Date(2026, 10, 5)))?.format, 'm/d/yyyy');
});

test('dark pages turn white to the dark page, black to light, as the shaders do', () => {
  assert.equal(darkPageColor(0xffffff), 0x28292d);
  assert.equal(darkPageColor(0x000000), 0xe3e3e0);
});
