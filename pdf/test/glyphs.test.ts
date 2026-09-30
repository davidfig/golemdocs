import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PdfDocument, TrueTypeFont, extractText } from '../src/index.ts';

// The math font's TrueType build, next to the app's atlases (run `pnpm fonts` to make it).
const FONT = path.resolve(import.meta.dirname, '../../client/public/fonts/libertinus-math/regular.ttf');
const skip = existsSync(FONT) ? {} : { skip: 'run `pnpm fonts` first' };
const bytes = () => new Uint8Array(readFileSync(FONT));

/** The extent of the points in an M/L/Q/Z path. */
function extent(d: string): { x0: number; y0: number; x1: number; y1: number } {
  const nums = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const xs = nums.filter((_, i) => i % 2 === 0);
  const ys = nums.filter((_, i) => i % 2 === 1);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

test('glyphPath draws a glyph: closed contours whose extent is the glyph box', skip, () => {
  const font = TrueTypeFont.parse(bytes());
  const gid = font.glyphForCodePoint(0x78); // x
  const d = font.glyphPath(gid);
  assert.match(d, /^M/);
  assert.equal((d.match(/M/g) ?? []).length, (d.match(/Z/g) ?? []).length, 'every contour closes');
  const box = extent(d);
  // A lowercase x of a 1000-unit font: about half an em wide and tall, sitting on the baseline.
  assert.ok(box.y0 > -30 && box.y0 < 30, `baseline ${box.y0}`);
  assert.ok(box.y1 > 400 && box.y1 < 560, `x-height ${box.y1}`);
  assert.ok(box.x1 - box.x0 > 350 && box.x1 - box.x0 < 650);
  // A glyph with a hole has two contours (an o).
  assert.equal((font.glyphPath(font.glyphForCodePoint(0x6f)).match(/M/g) ?? []).length, 2);
  assert.equal(font.glyphPath(font.glyphForCodePoint(0x20)), '', 'a space has no outline');
  assert.equal(font.glyphPath(99999), '');
});

test('composite glyphs (accented letters) draw their parts moved into place', skip, () => {
  const font = TrueTypeFont.parse(bytes());
  const plain = extent(font.glyphPath(font.glyphForCodePoint(0x65))); // e
  const accented = font.glyphPath(font.glyphForCodePoint(0xe9)); // é
  assert.ok(accented.length > 0);
  assert.ok(extent(accented).y1 > plain.y1 + 100, 'the accent stands above the e');
});

test('glyphs can be shown by index, and extract as the text they stand for', skip, async () => {
  const pdf = PdfDocument.create();
  const font = pdf.embedFont(bytes());
  const x = font.font.glyphForCodePoint(0x1d465);
  const parenVariant = font.font.glyphForCodePoint(0x28) + 2170; // some glyph with no character of its own
  const page = pdf.addPage([200, 100]);
  const d = page.draw({ origin: 'top-left' });
  d.textRun([{ text: '𝑥', glyph: x, advance: 12 }, { text: '', glyph: parenVariant }, { text: '=', glyph: font.font.glyphForCodePoint(0x3d) }], 20, 50, { font, size: 10 });
  d.finish();
  const saved = await pdf.save();
  const back = PdfDocument.load(saved);
  const text = extractText(back.pages[0]).text;
  assert.ok(text.includes('𝑥'), text);
  assert.ok(text.includes('='), text);
});
