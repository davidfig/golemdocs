// Where a cell's text goes (sheet/cellText.ts): emoji sequences are one unit, measured and placed whole.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eachUnit, placeText, units } from '../src/sheet/cellText.ts';
import type { Measure } from '../src/sheet/cellText.ts';
import type { DrawStyle } from '../src/sheet/protocol.ts';

const STYLE: DrawStyle = { font: 'Calibri', size: 10, bold: false, italic: false, underline: 0, strike: false, color: 0, fill: null, horizontal: 'general', vertical: 'bottom', wrap: false, shrink: false, indent: 0, rotation: 0, borders: [null, null, null, null] };
const BOX = { x0: 0, y0: 0, x1: 200, y1: 15 };
const FAMILY = '👨‍👩‍👧';
const FLAG = '🇫🇷';

/** Every character half an em; every emoji 1.25 em, or none while `loaded` is false. */
const measure = (loaded = true): Measure => ({ advance: () => 0.5, emoji: () => (loaded ? 1.25 : null), ascent: 0.75, descent: 0.25, lineHeight: 1.2 });

test('an emoji sequence (a family, a flag) is one unit; other text is a character at a time', () => {
  const seen: [number, string | undefined][] = [];
  eachUnit(`a${FAMILY}b${FLAG}`, (cp, emoji) => seen.push([cp, emoji]));
  assert.deepEqual(seen, [
    [0x61, undefined],
    [0x1f468, FAMILY],
    [0x62, undefined],
    [0x1f1eb, FLAG],
  ]);
  assert.deepEqual(units(`x${FAMILY}y`), ['x', FAMILY, 'y']);
});

test('a cell places an emoji as one glyph with its own width, or as its characters while its page loads', () => {
  const [line] = placeText(`a${FAMILY}b`, STYLE, 'text', BOX, 0, 200, measure());
  assert.deepEqual(
    line.chars.map((c) => c.emoji ?? String.fromCodePoint(c.cp)),
    ['a', FAMILY, 'b'],
  );
  // a at 2.25 (the padding), the family 5 later, b 12.5 after that.
  assert.deepEqual(
    line.chars.map((c) => c.x),
    [2.25, 7.25, 19.75],
  );
  const [loading] = placeText(`a${FAMILY}b`, STYLE, 'text', BOX, 0, 200, measure(false));
  assert.ok(loading.chars.length > 3);
  assert.ok(loading.chars.every((c) => !c.emoji));
});

test('a cell cut at its edge leaves an emoji out whole, and wrapping never splits one', () => {
  const [line] = placeText(`ab${FAMILY}`, STYLE, 'text', { x0: 0, y0: 0, x1: 20, y1: 15 }, 0, 20, measure());
  assert.deepEqual(
    line.chars.map((c) => c.emoji ?? String.fromCodePoint(c.cp)),
    ['a', 'b'],
  );
  const lines = placeText(FAMILY.repeat(4), { ...STYLE, wrap: true }, 'text', { x0: 0, y0: 0, x1: 34, y1: 200 }, 0, 34, measure());
  assert.ok(lines.length > 1);
  for (const l of lines) for (const c of l.chars) assert.equal(c.emoji, FAMILY);
});
