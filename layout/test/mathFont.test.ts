import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FontSet } from '../src/index.ts';

// Uses the generated math font in client/public/fonts (run `pnpm fonts --only libertinus-math`).
const FONT_DIR = path.resolve(import.meta.dirname, '../../client/public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'libertinus-math', 'math.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : null;

const CP = (c: string) => c.codePointAt(0)!;

test('the math font is not a font a document can pick by name', skip, () => {
  assert.ok(fonts!.mathFamily);
  assert.equal(fonts!.isKnown('Libertinus Math'), false);
  assert.equal(fonts!.resolve({ font: 'Libertinus Math' }).family.id, 'calibri'); // falls back like any unknown name
});

test('ensureMath loads the face and its MATH data once', skip, async () => {
  assert.equal(fonts!.mathData, undefined);
  assert.equal(await fonts!.ensureMath(), true);
  const data = fonts!.mathData!;
  assert.ok(data.constants.axisHeight > 0.2 && data.constants.axisHeight < 0.3);
  assert.equal(data.constants.scriptPercentScaleDown, 0.8);
  assert.ok(fonts!.metrics(fonts!.mathFace!));
  await fonts!.ensureMath();
  assert.equal(fonts!.mathData, data);
});

test('code points reach glyphs; size variants are reached by position', skip, async () => {
  await fonts!.ensureMath();
  const face = fonts!.metrics(fonts!.mathFace!)!;
  const data = fonts!.mathData!;
  for (const c of ['x', '(', '√', '∑', '∫', 'α', '𝑥', '𝔸', '∞', '→']) assert.ok(face.has(CP(c)), c);

  const paren = face.glyph(CP('('));
  const construction = data.vertical[String(paren)];
  assert.equal(construction.variants[0][0], paren, 'the first variant is the glyph itself');
  assert.ok(construction.variants.length > 3);
  assert.ok(construction.variants.every(([, size], i, all) => i === 0 || size > all[i - 1][1]), 'variants grow');
  // Beyond the largest variant, a glyph assembly of pieces builds any size.
  const parts = construction.assembly!.parts;
  assert.ok(parts.some((p) => p[4] === 1), 'has an extender piece');
  for (const [glyph] of parts) assert.ok(glyph < face.glyphCount);
  // Variants have no code point of their own, but have geometry.
  const big = construction.variants[construction.variants.length - 1][0];
  assert.equal(face.layout.glyphs[big].unicode, undefined);
  assert.equal(face.visible[big], 1);
});

test('the radical, integral and stretchy arrows have constructions; italics and accents have positions', skip, async () => {
  await fonts!.ensureMath();
  const face = fonts!.metrics(fonts!.mathFace!)!;
  const data = fonts!.mathData!;
  assert.ok(data.vertical[String(face.glyph(CP('√')))]?.assembly);
  assert.ok(data.vertical[String(face.glyph(CP('∫')))]?.variants.length >= 2);
  assert.ok(data.horizontal[String(face.glyph(CP('→')))]);
  assert.ok(data.italics[String(face.glyph(CP('𝑓')))] > 0, 'math italic f leans out to the right');
  assert.ok(String(face.glyph(CP('𝑥'))) in data.topAccent);
  assert.ok(data.minConnectorOverlap > 0);
});
