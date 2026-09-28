// Paginates plain text the way Word would with a new blank document's defaults. A stand-in
// until there's a real document model; the line breaking and pagination carry over.

import { packColor, type TextBatch } from '../text/textBatch.ts';
import type { FontLibrary, FontRequest } from '../text/fontLibrary.ts';
import type { MsdfFace } from '../text/msdfFace.ts';
import { LETTER, Page, type PageSetup } from './page.ts';

interface ParagraphStyle {
  font: FontRequest;
  size: number;
  color: number;
  /** Multiple of the font's single line height. */
  lineSpacing: number;
  spaceBefore: number;
  spaceAfter: number;
  /** Don't leave this paragraph alone at the bottom of a page. */
  keepWithNext: boolean;
}

/** Word's "Normal" style (pre-Aptos): Calibri 11pt, 1.08 lines, 8pt after. */
const NORMAL: ParagraphStyle = {
  font: { font: 'Calibri' },
  size: 11,
  color: packColor(0x000000),
  lineSpacing: 1.08,
  spaceBefore: 0,
  spaceAfter: 8,
  keepWithNext: false,
};

/** Word's "Heading 1" (Calibri Light isn't in the font set yet, so plain Calibri). */
const HEADING: ParagraphStyle = {
  font: { font: 'Calibri' },
  size: 16,
  color: packColor(0x2f5496),
  lineSpacing: 1.08,
  spaceBefore: 12,
  spaceAfter: 0,
  keepWithNext: true,
};

export interface Paragraph {
  text: string;
  style: ParagraphStyle;
}

/**
 * Splits hard-wrapped plain text (e.g. Project Gutenberg) into paragraphs at blank lines,
 * joining wrapped lines and collapsing whitespace. Short all-caps lines become headings.
 */
export function parsePlainText(source: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  for (const block of source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
    const text = block.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const heading = text.length <= 60 && /[A-Z]/.test(text) && text === text.toUpperCase();
    paragraphs.push({ text, style: heading ? HEADING : NORMAL });
  }
  return paragraphs;
}

/** Greedy line breaking at spaces. Returns [start, end) character ranges of each line. */
function breakLines(face: MsdfFace, text: string, size: number, maxWidth: number): number[] {
  const breaks: number[] = [];
  const space = face.advance(face.glyph(0x20)) * size;
  let lineStart = 0;
  let lineWidth = 0;
  let wordStart = 0;
  while (wordStart <= text.length) {
    let wordEnd = text.indexOf(' ', wordStart);
    if (wordEnd < 0) wordEnd = text.length;
    const width = face.measure(text, wordStart, wordEnd) * size;
    if (wordStart > lineStart && lineWidth + space + width > maxWidth) {
      breaks.push(lineStart, wordStart - 1);
      lineStart = wordStart;
      lineWidth = width;
    } else {
      lineWidth += (wordStart > lineStart ? space : 0) + width;
    }
    wordStart = wordEnd + 1;
  }
  breaks.push(lineStart, text.length);
  return breaks;
}

export async function layoutPlainText(
  library: FontLibrary,
  source: string,
  setup: PageSetup = LETTER,
): Promise<Page[]> {
  const paragraphs = parsePlainText(source);

  // Load every face the styles use before laying out.
  const styles = [...new Set(paragraphs.map((p) => p.style))];
  const faces = new Map<ParagraphStyle, MsdfFace>();
  await Promise.all(
    styles.map(async (style) => faces.set(style, await library.load(library.resolve(style.font).face))),
  );

  const { margin } = setup;
  const contentWidth = setup.width - margin.left - margin.right;
  const contentBottom = setup.height - margin.bottom;
  const pages: Page[] = [];
  let page!: Page;
  let batches = new Map<ParagraphStyle, TextBatch>();
  let y = 0; // page-relative

  const newPage = () => {
    page = new Page(0, pages.length * (setup.height + setup.gap), setup.width, setup.height);
    pages.push(page);
    batches = new Map();
    y = margin.top;
  };
  const batchFor = (style: ParagraphStyle) => {
    let batch = batches.get(style);
    if (!batch) {
      batch = page.batch(library, style.font);
      batches.set(style, batch);
    }
    return batch;
  };
  const lineHeight = (style: ParagraphStyle) => faces.get(style)!.lineHeight * style.size * style.lineSpacing;

  newPage();
  for (let p = 0; p < paragraphs.length; p++) {
    const { text, style } = paragraphs[p];
    const face = faces.get(style)!;
    const height = lineHeight(style);
    const ascent = face.ascent * style.size;
    const lines = breakLines(face, text, style.size, contentWidth);
    const lineCount = lines.length / 2;

    // Space before is suppressed at the top of a page, as in Word.
    if (y > margin.top) y += style.spaceBefore;

    for (let l = 0; l < lineCount; l++) {
      let needed = height;
      const next = paragraphs[p + 1];
      if (style.keepWithNext && l === lineCount - 1 && next) needed += style.spaceAfter + lineHeight(next.style);
      if (y + needed > contentBottom && y > margin.top) newPage();

      const line = text.slice(lines[l * 2], lines[l * 2 + 1]);
      batchFor(style).addText(line, page.x + margin.left, page.y + y + ascent, style.size, style.color);
      y += height;
    }
    y += style.spaceAfter;
  }
  return pages;
}
