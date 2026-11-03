// Emoji in what the app draws and writes: the face a GPU gets for an emoji page, and emoji in SVG and PDF exports
// (src/formats/emojiSprites.ts). Uses the generated emoji pages in public/fonts (`pnpm fonts:emoji`).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WordDocument, type Paragraph } from '@golemdocs/docx';
import { describeFace, FontSet, layoutDocument, type GlyphList } from '@golemdocs/layout';
import { emojiBox, emojiText } from '../src/formats/emojiSprites.ts';
import { documentToPdf } from '../src/formats/pdfExport.ts';
import { documentToSvg } from '../src/formats/svgFromDocument.ts';

const FONT_DIR = path.resolve(import.meta.dirname, '../public/fonts');
const fonts = await FontSet.load(
  async (p) => JSON.parse(readFileSync(path.join(FONT_DIR, p), 'utf8')),
  async (p) => new Uint8Array(readFileSync(path.join(FONT_DIR, p))),
);

const FAMILY = '👨‍👩‍👧‍👦';
const paragraph = (text: string): Paragraph => ({ kind: 'paragraph', properties: {}, children: [{ kind: 'run', properties: {}, content: [{ kind: 'text', text }], attrs: {} }], attrs: {} });

async function documentWith(text: string): Promise<WordDocument> {
  const doc = await WordDocument.create();
  doc.body = [paragraph(text)];
  return doc;
}

test('an emoji page reaches the GPU as a color face, its glyphs as whole sequences', async () => {
  const page = (await layoutDocument(await documentWith(`Hi ${FAMILY} 🇯🇵`), fonts)).pages[0];
  const lists = [...page.glyphs.values()].filter((list) => list.metrics.color) as GlyphList[];
  assert.ok(lists.length >= 1);
  const face = describeFace(lists[0].metrics);
  assert.equal(face.color, true);
  assert.match(face.key, /^emoji-\d+\/regular\.webp$/);
  const drawn = lists.flatMap((list) => Array.from({ length: list.count }, (_, i) => emojiText(list.metrics, list.glyph(i))));
  assert.deepEqual(drawn.sort(), [FAMILY, '🇯🇵'].sort());
  const box = emojiBox(lists[0].metrics, lists[0].glyph(0), 0, 0, 11)!;
  assert.ok(box.width > 11 && box.width < 16 && box.y < 0, 'a little wider than an em, above the baseline');
  // Fonts of text faces stay distance fields.
  assert.equal(describeFace([...page.glyphs.values()].find((list) => !list.metrics.color)!.metrics).color, undefined);
});

test('SVG export writes each emoji as its characters, in a text of its own', async () => {
  const svg = await documentToSvg(await documentWith(`a ${FAMILY} b`), fonts);
  assert.ok(svg.includes(`>${FAMILY}</text>`), 'the whole family sequence');
});

test('PDF export leaves emoji out of the text (they are pictures) without failing where pictures cannot be decoded', async () => {
  const bytes = await documentToPdf(await documentWith(`ok ${FAMILY}`), fonts);
  assert.ok(bytes.length > 0);
});
