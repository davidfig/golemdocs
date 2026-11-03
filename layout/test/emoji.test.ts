import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WordDocument, type Paragraph, type Run } from '@golemdocs/docx';
import { addEmoji, emojiAt, emojiPageKey, emojiSequence, FontSet, layoutDocument, type GlyphList } from '../src/index.ts';

// Uses the generated emoji pages in client/public/fonts (`pnpm fonts:emoji`).
const FONT_DIR = path.resolve(import.meta.dirname, '../../client/public/fonts');
const loaded: string[] = [];
const loadFonts = () =>
  FontSet.load(async (p) => {
    loaded.push(p);
    return JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8'));
  });

/** The emoji clusters of a string, by the UTF-16 length emojiAt finds at each one (other characters are skipped). */
function clusters(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; ) {
    const n = emojiAt(text, i);
    if (n) out.push(text.slice(i, i + n));
    i += n || 1;
  }
  return out;
}

test('emoji sequences are found whole', () => {
  const family = '👨‍👩‍👧‍👦';
  const flag = '🇯🇵';
  const keycap = '1️⃣';
  const toned = '👍🏽';
  const scotland = '🏴󠁧󠁢󠁳󠁣󠁴󠁿';
  const heart = '❤️';
  const zwjToned = '🧑🏽‍💻';
  assert.deepEqual(clusters(`a${family}b${flag}${keycap} ${toned}${scotland}${heart}${zwjToned}😀`), [family, flag, keycap, toned, scotland, heart, zwjToned, '😀']);
  // Two flags side by side are two flags, not one pair in the middle.
  assert.deepEqual(clusters('🇺🇸🇫🇷'), ['🇺🇸', '🇫🇷']);
});

test('text-style pictographs are not emoji unless asked to be', () => {
  assert.deepEqual(clusters('☺ ❤ ↔ © 1 #'), []);
  assert.deepEqual(clusters('☺️ ❤️'), ['☺️', '❤️']);
  // U+FE0E asks for text even where the default is emoji.
  assert.deepEqual(clusters('😀︎'), []);
  // A joiner to something that isn't a pictograph doesn't join.
  assert.deepEqual(clusters('😀‍a'), ['😀']);
});

test('page keys follow the first code point and the skin tone', () => {
  assert.deepEqual(emojiSequence('❤️‍🔥'), [0x2764, 0x200d, 0x1f525]);
  assert.equal(emojiPageKey([0x1f600]), 0x1f600);
  assert.equal(emojiPageKey([0x1f44d, 0x1f3fd]), 0x1f44d + 3 * 0x200000);
  // A skin tone alone is its own swatch.
  assert.equal(emojiPageKey([0x1f3fb]), 0x1f3fb);
  const keys = new Set<number>();
  addEmoji('hi 😀 and 👍🏽, plain ☺', keys);
  assert.deepEqual([...keys], [0x1f600, 0x1f44d + 3 * 0x200000]);
});

test('every generated emoji page holds what its coverage says, and only that', async () => {
  const fonts = await loadFonts();
  const pages = fonts.pages('emoji');
  assert.ok(pages.length > 1, 'emoji are split into several pages');
  for (const family of pages) {
    const ranges = JSON.parse(readFileSync(path.join(FONT_DIR, family.page!.coverage), 'utf8')) as number[];
    const layout = JSON.parse(readFileSync(path.join(FONT_DIR, family.faces[0].layout), 'utf8')) as { atlas: { type: string }; glyphs: { unicode?: number; sequence?: number[] }[] };
    assert.equal(layout.atlas.type, 'color');
    for (const g of layout.glyphs) {
      const key = emojiPageKey(g.sequence ?? [g.unicode!]);
      let covered = false;
      for (let r = 0; r < ranges.length; r += 2) if (key >= ranges[r] && key <= ranges[r + 1]) covered = true;
      assert.ok(covered, `${family.id} lists the page key of ${String.fromCodePoint(...(g.sequence ?? [g.unicode!]))}`);
    }
  }
});

const run = (text: string): Run => ({ kind: 'run', properties: { size: 22 }, content: [{ kind: 'text', text }], attrs: {} });
const paragraph = (text: string): Paragraph => ({ kind: 'paragraph', properties: {}, children: [run(text)], attrs: {} });

async function layoutText(text: string) {
  const fonts = await loadFonts();
  loaded.length = 0;
  const doc = await WordDocument.create();
  doc.body = [paragraph(text)];
  const page = (await layoutDocument(doc, fonts)).pages[0];
  const emoji = [...page.glyphs.values()].filter((list) => list.metrics.color) as GlyphList[];
  return { page, emoji, count: emoji.reduce((n, list) => n + list.count, 0) };
}

test('a document draws each emoji sequence as one color glyph, loading only the pages it uses', async () => {
  const text = 'Family 👨‍👩‍👧‍👦 flag 🇯🇵 keycap 1️⃣ thumbs 👍🏽 end';
  const { page, count } = await layoutText(text);
  assert.equal(count, 4);
  const pagesLoaded = loaded.filter((p) => p.startsWith('emoji-') && p.endsWith('regular.json'));
  assert.ok(pagesLoaded.length >= 1 && pagesLoaded.length < 6, `loaded ${pagesLoaded.join(', ')}`);
  // The caret steps over each sequence as one character: no stop of its own inside one.
  const line = page.lines[0];
  const at = (s: string) => text.indexOf(s);
  const family = at('👨');
  const stop = (offset: number) => line.stops[offset - line.start];
  for (let k = 1; k < '👨‍👩‍👧‍👦'.length; k++) assert.equal(stop(family + k), stop(family), `stop ${k} inside the family`);
  assert.ok(stop(family + '👨‍👩‍👧‍👦'.length) > stop(family), 'the family has a width');
});

test('an unknown ZWJ sequence draws its parts, still as one character', async () => {
  // A joiner between two emoji that make no sequence of their own.
  const text = '😀‍🍕';
  const { page, count } = await layoutText(text);
  assert.equal(count, 2);
  const line = page.lines[0];
  for (let k = 1; k < text.length; k++) assert.equal(line.stops[k], line.stops[0]);
});

test('a line never breaks inside an emoji sequence', async () => {
  const text = '👨‍👩‍👧‍👦'.repeat(200);
  const { page } = await layoutText(text);
  assert.ok(page.lines.length > 1);
  for (const line of page.lines) assert.equal(line.start % '👨‍👩‍👧‍👦'.length, 0, `line starts at ${line.start}`);
});

test('a character beyond the BMP is one glyph, not two halves', async () => {
  const { page } = await layoutText('a😀b');
  const line = page.lines[0];
  assert.equal(line.stops[2], line.stops[1], 'no stop between the surrogates');
});
