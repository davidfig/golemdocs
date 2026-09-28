// Font showcase for the text renderer: every font and face, word-wrapped on one tall sheet.
// `?repeat=N` repeats it for stress testing.

import { LETTER, Page } from './document/page.ts';
import type { FontLibrary, FontRequest } from './text/fontLibrary.ts';
import { packColor, type TextBatch } from './text/textBatch.ts';

const SAMPLE =
  'The quick brown fox jumps over the lazy dog. Sphinx of black quartz, judge my vow! ' +
  'Typography in a word processor has to match the original exactly: every advance width, ' +
  'line height and page break depends on it. Numbers 0123456789, punctuation (“quotes”, ‘apostrophes’, ' +
  'dashes – and —, ellipses…) and accents: café, naïve, façade, Ångström, Ærøskøbing, Łódź, € 1.234,56.';

const LEFT = LETTER.margin.left;
const COLUMN_WIDTH = LETTER.width - LETTER.margin.left - LETTER.margin.right;
const BODY_SIZE = 11;
const HEADING_SIZE = 16;
const INK = packColor(0x1f1f1f);
const ACCENT = packColor(0x2b579a);

export async function buildFontDemo(library: FontLibrary, repeat: number): Promise<Page[]> {
  const styles = library.families.map((family) => {
    const requests: [string, FontRequest][] = [
      ['Regular', { font: family.wordName }],
      ['Bold', { font: family.wordName, bold: true }],
      ['Italic', { font: family.wordName, italic: true }],
      ['Bold Italic', { font: family.wordName, bold: true, italic: true }],
    ];
    for (const alias of Object.keys(family.aliases)) requests.push([alias, { font: alias }]);
    return requests;
  });
  await Promise.all(styles.flat().map(([, request]) => library.load(library.resolve(request).face)));

  const page = new Page(0, 0, LETTER.width, 0);
  let y = LETTER.margin.top;
  for (let r = 0; r < repeat; r++) {
    for (let f = 0; f < library.families.length; f++) {
      const family = library.families[f];
      const heading = page.batch(library, { font: family.wordName, bold: true });
      y += heading.face.ascent * HEADING_SIZE;
      heading.addText(`${family.wordName} – ${family.substitute}`, LEFT, y, HEADING_SIZE, ACCENT);
      y += (heading.face.lineHeight - heading.face.ascent) * HEADING_SIZE + 6;
      for (const [label, request] of styles[f]) {
        y = wrap(page.batch(library, request), `${label}: ${SAMPLE}`, y, BODY_SIZE) + 8;
      }
      y += 12;
    }
  }
  page.height = y + LETTER.margin.bottom;
  return [page];
}

/** Greedy word wrap into the column. Returns the y below the paragraph. */
function wrap(batch: TextBatch, text: string, top: number, size: number): number {
  const lineHeight = batch.face.lineHeight * size;
  const space = batch.measure(' ', size);
  let y = top + batch.face.ascent * size;
  let x = LEFT;
  for (const word of text.split(' ')) {
    const width = batch.measure(word, size);
    if (x > LEFT && x + width > LEFT + COLUMN_WIDTH) {
      x = LEFT;
      y += lineHeight;
    }
    batch.addText(word, x, y, size, INK);
    x += width + space;
  }
  return y - batch.face.ascent * size + lineHeight;
}
