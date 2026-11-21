// Memory for long documents (a book of 30,000 pages ran a tab out of memory): a session keeps only the most recently laid-out
// paragraphs for reuse, a laid-out line holds its arrays in one buffer, and a page is sent without spare room in its buffers.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WordDocument, insertText, type Paragraph, type Run } from '@golemdocs/docx';
import { FontSet, GLYPH_INSTANCE_BYTES, LayoutSession, RECT_INSTANCE_BYTES, encodePage, layoutDocument, type PageLayout } from '../src/index.ts';
import { PARAGRAPH_CACHE_LINES, ParagraphCache, type CachedParagraph, type ParagraphLayout } from '../src/paragraph.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../../client/public/fonts');
const hasFonts = existsSync(path.join(FONT_DIR, 'manifest.json'));
const skip = hasFonts ? {} : { skip: 'run `pnpm fonts` first' };
const fonts = hasFonts ? await FontSet.load(async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'))) : null;

const run = (text: string): Run => ({ kind: 'run', properties: {}, attrs: {}, content: [{ kind: 'text', text }] });
const paragraph = (text: string): Paragraph => ({ kind: 'paragraph', properties: {}, children: [run(text)], attrs: {} });
/** A cache entry of `lines` lines (only the count matters to the cache). */
const entry = (lines: number): CachedParagraph => ({ key: '', layout: { lines: Array.from({ length: lines }) } as unknown as ParagraphLayout });

test('the paragraph cache lets the least recently used go once it holds too many lines', () => {
  const cache = new ParagraphCache(10);
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(paragraph);
  cache.set(a, entry(4));
  cache.set(b, entry(4));
  assert.equal(cache.size, 8);
  // Using a makes b the oldest.
  assert.ok(cache.get(a));
  cache.set(c, entry(4));
  assert.equal(cache.get(b), undefined, 'the least recently used went');
  assert.ok(cache.get(a));
  assert.ok(cache.get(c));
  assert.equal(cache.size, 8);
  // Replacing an entry counts only its new lines.
  cache.set(a, entry(1));
  assert.equal(cache.size, 5);
  assert.equal(cache.delete(a), true);
  assert.equal(cache.delete(a), false);
  assert.equal(cache.size, 4);
  // One paragraph longer than the whole cap is still kept, alone.
  cache.set(d, entry(25));
  assert.ok(cache.get(d));
  assert.equal(cache.get(c), undefined);
  assert.equal(cache.size, 25);
});

/** A page's content as comparable data. */
function describe(page: PageLayout): string {
  const parts = [`${page.width}x${page.height} #${page.number}`];
  for (const [key, list] of [...page.glyphs.entries()].sort(([x], [y]) => x.localeCompare(y))) parts.push(`${key}:${list.count}:${Buffer.from(list.bytes).toString('base64')}`);
  parts.push(`lines:${page.lines.map((l) => `${l.start}-${l.end}@${l.y.toFixed(3)}:${[...l.stops].map((s) => s.toFixed(2)).join(' ')}`).join(',')}`);
  return parts.join('\n');
}

const TEXT = 'the quick brown fox jumps over a lazy dog while seven wizards box quietly and then some '.repeat(5);

test('a book longer than the cache is laid out the same after an edit to a paragraph the cache has let go', skip, async () => {
  const doc = await WordDocument.create();
  // About five lines each: twice as many lines as the cache keeps.
  doc.body = Array.from({ length: Math.ceil((PARAGRAPH_CACHE_LINES * 2) / 5) }, (_, i) => paragraph(`${i}: ${TEXT}`));
  const session = await LayoutSession.create(doc, fonts!);
  await session.run({ mergeOverlays: false });
  const cache = (session as unknown as { paragraphCache: ParagraphCache }).paragraphCache;
  assert.ok(cache.size > 0 && cache.size <= PARAGRAPH_CACHE_LINES, `the cache holds ${cache.size} lines, at most ${PARAGRAPH_CACHE_LINES}`);

  // The first paragraph was laid out first, so it is long gone from the cache; the last is still in it.
  const first = doc.body[0] as Paragraph;
  const last = doc.body.at(-1) as Paragraph;
  assert.ok(cache.get(first) === undefined, 'the first paragraph was let go');
  assert.ok(cache.get(last) !== undefined, 'the last paragraph is kept');
  insertText(first, 3, 'an inserted phrase long enough to push words onto the next line ');
  insertText(last, 0, 'and at the end too ');
  session.invalidate([first, last], { structural: false });
  await session.run({ mergeOverlays: false });

  const reference = await layoutDocument(doc, fonts!, { mergeOverlays: false });
  assert.equal(session.pages.length, reference.pages.length);
  for (const i of [0, 1, Math.floor(reference.pages.length / 2), reference.pages.length - 1]) {
    assert.equal(describe(session.pages[i]), describe(reference.pages[i]), `page ${i}`);
  }
});

test("a laid-out line's arrays share one buffer, and its caret stops have their own", skip, async () => {
  const doc = await WordDocument.create();
  doc.body = [paragraph(TEXT)];
  const session = await LayoutSession.create(doc, fonts!);
  await session.run({ mergeOverlays: false });
  const cache = (session as unknown as { paragraphCache: ParagraphCache }).paragraphCache;
  const line = cache.get(doc.body[0] as Paragraph)!.layout.lines[0];
  assert.ok(line.glyph.length > 10);
  for (const name of ['x', 'size', 'dy', 'style', 'font'] as const) {
    assert.equal(line[name].length, line.glyph.length, name);
    assert.equal(line[name].buffer, line.glyph.buffer, `${name} shares the line's buffer`);
  }
  // Pages keep a line's stops after the cache lets the line go: they must not hold the rest of it.
  assert.notEqual(line.stops.buffer, line.glyph.buffer);
  // No rectangles on plain text: the shared empty arrays, no buffer of their own.
  assert.equal(line.rects.length, 0);
  assert.equal(line.rects.buffer.byteLength, 0);
});

test('a page is sent with buffers just the size of what they hold', skip, async () => {
  const doc = await WordDocument.create();
  doc.body = Array.from({ length: 40 }, (_, i) => paragraph(`${i}: ${TEXT}`));
  const reference = await layoutDocument(doc, fonts!, { mergeOverlays: false });
  const page = reference.pages[0];
  const glyphs = page.glyphCount;
  assert.ok(glyphs > 100);
  const { page: encoded, transferables } = encodePage(page);
  assert.ok(encoded.text.length > 0);
  for (const text of encoded.text) assert.equal(text.instances.byteLength, text.count * GLYPH_INSTANCE_BYTES);
  assert.equal(encoded.background.instances.byteLength, encoded.background.count * RECT_INSTANCE_BYTES);
  assert.equal(encoded.foreground.instances.byteLength, encoded.foreground.count * RECT_INSTANCE_BYTES);
  assert.equal(encoded.text.reduce((n, t) => n + t.count, 0), glyphs, 'every glyph is still there');
  assert.equal(transferables.length, encoded.text.length + 2);
});

test("a finished page's lines keep their caret stops in one buffer, unchanged", skip, async () => {
  const doc = await WordDocument.create();
  doc.body = Array.from({ length: 40 }, (_, i) => paragraph(`${i}: ${TEXT}`));
  const session = await LayoutSession.create(doc, fonts!);
  await session.run({ mergeOverlays: false });
  const cache = (session as unknown as { paragraphCache: ParagraphCache }).paragraphCache;
  const page = session.pages[0];
  assert.ok(page.lines.length > 10);
  const buffer = page.lines[0].stops.buffer;
  for (const line of page.lines) {
    assert.equal(line.stops.buffer, buffer, 'one buffer for the page');
    // The same positions as the paragraph's own layout of that line.
    const laid = cache.get(line.paragraph)!.layout.lines.find((l) => l.start === line.start && l.end === line.end)!;
    assert.deepEqual([...line.stops], [...laid.stops]);
  }
});
