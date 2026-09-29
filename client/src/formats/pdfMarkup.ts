// A PDF's markup annotations carried into its reflowed text: when a PDF is edited as Word (or
// Markdown, or text), highlights, underlines and strikeouts become that formatting on the same
// words, and notes (and comments on marked text) become comments. The annotations themselves stay
// in the document's pdf extension, for its own pages.
//
// Annotations mark areas of a page, not text, so the text is found again: the characters under
// each marked line are looked up in the reflowed paragraphs, in reading order. Text that reflow
// changed beyond recognition (or that isn't there) is skipped.

import { commentEnd, commentReference, commentStart, formatText, insertInlines, paragraphsIn, paragraphText, type Paragraph, type WordDocument } from '@word/docx';
import { parseDate, quadBoxes, type Annotation, type PdfDocument } from '@word/pdf';
import { pageCharacters, type PdfCharacter } from './pdfText.ts';

/** Word's highlight colors, which are named (w:highlight), with their RGB. */
const HIGHLIGHTS: [string, number, number, number][] = [
  ['yellow', 1, 1, 0],
  ['green', 0, 1, 0],
  ['cyan', 0, 1, 1],
  ['magenta', 1, 0, 1],
  ['red', 1, 0, 0],
  ['blue', 0, 0, 1],
  ['lightGray', 0.75, 0.75, 0.75],
];

/** A found piece of text: a paragraph and model offsets. */
interface Found {
  paragraph: Paragraph;
  from: number;
  to: number;
}

/** Applies the annotations to a document reflowed from `pdf`. */
export function markupToDocument(document: WordDocument, pdf: PdfDocument, annotations: readonly Annotation[]): void {
  if (!annotations.length) return;
  const finder = new TextFinder(paragraphsIn(document.body));
  const characters = new Map<number, PdfCharacter[]>();
  const charactersOf = (page: number) => {
    let chars = characters.get(page);
    if (!chars) characters.set(page, (chars = page < pdf.pageCount ? pageCharacters(pdf, page) : []));
    return chars;
  };
  let nextComment = Math.max(-1, ...document.comments.map((c) => Number(c.id)).filter(Number.isFinite)) + 1;
  const comments: { at: Found; text: string; author?: string; modified?: string }[] = [];

  for (const a of [...annotations].sort(readingOrder)) {
    const chars = charactersOf(a.page);
    if (a.kind === 'note') {
      const words = noteLine(chars, a);
      const at = words && finder.find(words);
      if (at) comments.push({ at, text: a.contents, author: a.author, modified: a.modified });
      continue;
    }
    const found: Found[] = [];
    for (const box of quadBoxes(a.quads)) {
      const text = textIn(chars, box);
      const at = text && finder.find(text);
      if (at) found.push(at);
    }
    for (const at of found) {
      formatText(at.paragraph, at.from, at.to, (p) => {
        if (a.kind === 'highlight') p.highlight = nearestHighlight(a.color);
        else if (a.kind === 'underline') p.underline = { val: 'single', color: hex(a.color) };
        else p.strike = true;
      });
    }
    if (a.contents && found.length) {
      const first = found[0];
      const last = found[found.length - 1];
      comments.push({ at: first.paragraph === last.paragraph ? { ...first, to: last.to } : first, text: a.contents, author: a.author, modified: a.modified });
    }
  }

  // Markers last, each paragraph's from its end, so the offsets found stay good.
  const ordered = comments.map((c) => ({ ...c, id: String(nextComment++) }));
  const byParagraph = new Map<Paragraph, { offset: number; marker: 'start' | 'end'; id: string }[]>();
  for (const c of ordered) {
    const list = byParagraph.get(c.at.paragraph) ?? [];
    list.push({ offset: c.at.to, marker: 'end', id: c.id }, { offset: c.at.from, marker: 'start', id: c.id });
    byParagraph.set(c.at.paragraph, list);
    const date = c.modified ? parseDate(c.modified) : undefined;
    document.comments.push({ id: c.id, author: c.author ?? '', ...(date && { date: date.toISOString().replace(/\.\d+Z$/, 'Z') }), paragraphs: c.text.split(/\r\n?|\n/) });
  }
  for (const [paragraph, markers] of byParagraph) {
    markers.sort((x, y) => y.offset - x.offset || (x.marker === 'end' ? -1 : 1));
    for (const m of markers) insertInlines(paragraph, m.offset, m.marker === 'end' ? [commentEnd(m.id), commentReference(m.id)] : [commentStart(m.id)]);
  }
}

const readingOrder = (a: Annotation, b: Annotation) => a.page - b.page || b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0];

/** The characters whose middles are inside a user-space box, as text. */
function textIn(chars: readonly PdfCharacter[], [x0, y0, x1, y1]: readonly number[]): string {
  let out = '';
  for (const c of chars) {
    const x = (c.user[0] + c.user[2]) / 2;
    const y = (c.user[1] + c.user[3]) / 2;
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out += c.text;
  }
  return out.trim();
}

/** The first words of the line a note sits beside (the one nearest its middle, to its right if it can). */
function noteLine(chars: readonly PdfCharacter[], note: Annotation): string | null {
  const y = (note.rect[1] + note.rect[3]) / 2;
  let best: PdfCharacter | null = null;
  let bestDistance = Infinity;
  for (const c of chars) {
    const distance = Math.abs((c.user[1] + c.user[3]) / 2 - y) + (c.user[0] < note.rect[0] ? 1000 : 0);
    if (distance < bestDistance) {
      best = c;
      bestDistance = distance;
    }
  }
  if (!best) return null;
  const line = chars.filter((c) => c.line === best.line).map((c) => c.text).join('');
  const words = line.trim().split(/\s+/).slice(0, 6).join(' ');
  return words || null;
}

function nearestHighlight([r, g, b]: readonly number[]): string {
  let best = HIGHLIGHTS[0];
  let bestDistance = Infinity;
  for (const h of HIGHLIGHTS) {
    const d = (h[1] - r) ** 2 + (h[2] - g) ** 2 + (h[3] - b) ** 2;
    if (d < bestDistance) {
      best = h;
      bestDistance = d;
    }
  }
  return best[0];
}

const hex = (rgb: readonly number[]) => rgb.map((c) => Math.round(Math.min(Math.max(c, 0), 1) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();

/**
 * Finds text in paragraphs in reading order: each search starts where the last match ended
 * (then wraps around once). Whitespace is ignored (a PDF may position words without spaces
 * between them), and so is a hyphen ending a line, which reflow joins up.
 */
class TextFinder {
  /** Per paragraph: its text without whitespace, and each character's model offset. */
  private readonly texts: { paragraph: Paragraph; text: string; offsets: number[] }[];
  private at = { index: 0, from: 0 };

  constructor(paragraphs: readonly Paragraph[]) {
    this.texts = paragraphs.map((paragraph) => {
      const raw = paragraphText(paragraph);
      let text = '';
      const offsets: number[] = [];
      for (let i = 0; i < raw.length; i++) {
        if (/\s/.test(raw[i])) continue;
        text += raw[i];
        offsets.push(i);
      }
      return { paragraph, text, offsets };
    });
  }

  find(query: string): Found | null {
    const needle = query.replace(/-\s*$/, '').replace(/\s+/g, '');
    if (needle.length < 2) return null;
    const n = this.texts.length;
    for (let k = 0; k <= n; k++) {
      const index = (this.at.index + k) % n;
      const entry = this.texts[index];
      const from = k === 0 ? this.at.from : 0;
      const i = entry.text.indexOf(needle, from);
      if (i < 0) continue;
      const end = i + needle.length;
      this.at = { index, from: end };
      return { paragraph: entry.paragraph, from: entry.offsets[i], to: entry.offsets[end - 1] + 1 };
    }
    return null;
  }
}
