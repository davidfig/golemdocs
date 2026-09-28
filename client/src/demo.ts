// Temporary demo content for the text renderer: every font and face, word-wrapped to a
// Letter-size text column. `?repeat=N` repeats it for stress testing.

import type { FontLibrary, FontRequest } from './text/fontLibrary.ts';
import { TextBatch, packColor } from './text/textBatch.ts';

const SAMPLE =
  'The quick brown fox jumps over the lazy dog. Sphinx of black quartz, judge my vow! ' +
  'Typography in a word processor has to match the original exactly: every advance width, ' +
  'line height and page break depends on it. Numbers 0123456789, punctuation (“quotes”, ‘apostrophes’, ' +
  'dashes – and —, ellipses…) and accents: café, naïve, façade, Ångström, Ærøskøbing, Łódź, € 1.234,56.';

const LEFT = 72; // 1in margins on Letter paper
const COLUMN_WIDTH = 468;
const BODY_SIZE = 11;
const HEADING_SIZE = 16;
const INK = packColor(0x1f1f1f);
const ACCENT = packColor(0x2b579a);

type Styled = FontRequest & { label: string };

export async function buildDemo(library: FontLibrary, repeat: number): Promise<TextBatch[]> {
  const batches = new Map<string, TextBatch>();

  async function batchFor(request: FontRequest): Promise<TextBatch> {
    const resolved = library.resolve(request);
    let batch = batches.get(resolved.key);
    if (!batch) {
      const face = await library.load(resolved.face);
      batch = new TextBatch(face, {
        skew: resolved.syntheticItalic ? 0.2 : 0,
        embolden: resolved.syntheticBold ? 0.02 : 0,
      });
      batches.set(resolved.key, batch);
    }
    return batch;
  }

  // Load every face up front, in parallel.
  const styles: Styled[][] = library.families.map((family) => {
    const names: [string, FontRequest][] = [
      ['Regular', { font: family.wordName }],
      ['Bold', { font: family.wordName, bold: true }],
      ['Italic', { font: family.wordName, italic: true }],
      ['Bold Italic', { font: family.wordName, bold: true, italic: true }],
    ];
    for (const alias of Object.keys(family.aliases)) names.push([alias, { font: alias }]);
    return names.map(([label, request]) => ({ ...request, label }));
  });
  await Promise.all(styles.flat().map(batchFor));

  let y = 72;
  for (let r = 0; r < repeat; r++) {
    for (let f = 0; f < library.families.length; f++) {
      const family = library.families[f];
      const heading = await batchFor({ font: family.wordName, bold: true });
      y += heading.face.ascent * HEADING_SIZE;
      heading.addText(`${family.wordName} – ${family.substitute}`, LEFT, y, HEADING_SIZE, ACCENT);
      y += (heading.face.lineHeight - heading.face.ascent) * HEADING_SIZE + 6;

      for (const style of styles[f]) {
        const batch = await batchFor(style);
        y = wrap(batch, `${style.label}: ${SAMPLE}`, y, BODY_SIZE) + 8;
      }
      y += 12;
    }
  }

  // Group by face so the renderer binds each atlas once.
  const list = [...batches.values()];
  const faces = [...new Set(list.map((batch) => batch.face))];
  return faces.flatMap((face) => list.filter((batch) => batch.face === face));
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
