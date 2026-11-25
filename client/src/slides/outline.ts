// A deck as an outline and back (docs/slides.md): what Convert To and search see of a deck, and how a document becomes one.
// Deck → outline: each slide's title a heading, its other text as list items at their levels (or paragraphs), its tables as
// tables and its notes as a quote, written as Markdown so the Markdown reader makes the document. Outline → deck: each
// top-level heading starts a slide on Title and Content, and what follows it becomes the slide's bullets.

import { el, type XmlElement } from '@golemdocs/docx';
import { Deck, paragraphText, type SlidePart } from './deck.ts';
import { at, kid, kids, num } from './ooxml.ts';
import { placeholderOf } from './shapes.ts';
import { blankDeck } from './blank.ts';
import { Transaction } from './history.ts';
import { addSlide, deleteSlides, treeOf } from './edit.ts';

const md = (s: string): string => s.replace(/([\\`*_[\]#|<>])/g, '\\$1');

function bodyLines(txBody: XmlElement | undefined, bulleted: boolean): string[] {
  const out: string[] = [];
  for (const p of kids(txBody, 'a:p')) {
    const text = paragraphText(p).replace(/\u000b/g, ' ').trim();
    if (!text) continue;
    const pPr = kid(p, 'a:pPr');
    const level = num(pPr, 'lvl') ?? 0;
    const none = kid(pPr, 'a:buNone');
    const numbered = kid(pPr, 'a:buAutoNum');
    if ((bulleted && !none) || kid(pPr, 'a:buChar') || numbered) out.push(`${'  '.repeat(level)}${numbered ? '1.' : '-'} ${md(text)}`);
    else out.push(md(text));
  }
  return out;
}

function tableLines(tbl: XmlElement): string[] {
  const rows = kids(tbl, 'a:tr').map((tr) => kids(tr, 'a:tc').map((tc) => kids(kid(tc, 'a:txBody'), 'a:p').map(paragraphText).join(' ').replace(/\|/g, '\\|').trim()));
  if (!rows.length) return [];
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]): string => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)];
}

/** One slide as Markdown. */
export function slideMarkdown(deck: Deck, slide: SlidePart, index: number): string {
  let title = '';
  const blocks: string[] = [];
  const visit = (tree: XmlElement | undefined): void => {
    for (const shape of kids(tree)) {
      if (shape.name === 'p:grpSp') visit(shape);
      else if (shape.name === 'p:sp') {
        const ph = placeholderOf(shape);
        const txBody = kid(shape, 'p:txBody');
        if (ph && (ph.type === 'title' || ph.type === 'ctrTitle')) {
          title = kids(txBody, 'a:p').map(paragraphText).join(' ').replace(/\u000b/g, ' ').trim();
          continue;
        }
        if (ph && (ph.type === 'dt' || ph.type === 'ftr' || ph.type === 'sldNum')) continue;
        const lines = bodyLines(txBody, !!ph && (ph.type === 'body' || ph.type === 'obj'));
        if (lines.length) blocks.push(lines.join('\n'));
      } else if (shape.name === 'p:graphicFrame') {
        const tbl = at(shape, 'a:graphic/a:graphicData/a:tbl');
        if (tbl) blocks.push(tableLines(tbl).join('\n'));
      } else if (shape.name === 'p:pic') {
        const descr = kids(shape)[0] && kid(kids(shape)[0], 'p:cNvPr')?.attrs.descr;
        if (descr) blocks.push(`*${md(descr)}*`);
      }
    }
  };
  visit(at(slide.xml, 'p:cSld/p:spTree'));
  const notes = deck.notesText(slide).replace(/\u000b/g, '\n').trim();
  if (notes) blocks.push(notes.split('\n').map((l) => `> ${md(l)}`).join('\n'));
  return [`# ${md(title) || `Slide ${index + 1}`}`, ...blocks].join('\n\n');
}

/** The deck as Markdown, a section per slide. */
export function deckMarkdown(deck: Deck): string {
  return deck.slides.map((slide, i) => slideMarkdown(deck, slide, i)).join('\n\n');
}

/** The text of every slide and its notes, a line per paragraph (for search). */
export function deckLines(deck: Deck): string[] {
  const out: string[] = [];
  const visit = (tree: XmlElement | undefined): void => {
    for (const shape of kids(tree)) {
      if (shape.name === 'p:grpSp') visit(shape);
      for (const p of kids(kid(shape, 'p:txBody'), 'a:p')) out.push(paragraphText(p).replace(/\u000b/g, ' '));
      const tbl = at(shape, 'a:graphic/a:graphicData/a:tbl');
      for (const tr of kids(tbl, 'a:tr')) out.push(kids(tr, 'a:tc').map((tc) => kids(kid(tc, 'a:txBody'), 'a:p').map(paragraphText).join(' ')).join(' '));
    }
  };
  for (const slide of deck.slides) {
    visit(at(slide.xml, 'p:cSld/p:spTree'));
    for (const line of deck.notesText(slide).split(/[\n\u000b]/)) out.push(line);
  }
  return out.filter((l) => l.trim());
}

interface OutlineSlide {
  title: string;
  lines: { text: string; level: number; bullet: boolean }[];
}

/** Splits Markdown into slides: a slide per top-level heading (the highest level the text has). */
export function outlineSlides(markdown: string): OutlineSlide[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const levels = lines.map((l) => /^(#{1,6})\s/.exec(l)?.[1].length ?? 0).filter(Boolean);
  const top = levels.length ? Math.min(...levels) : 0;
  const slides: OutlineSlide[] = [];
  let current: OutlineSlide | null = null;
  const clean = (s: string): string => s.replace(/\\([\\`*_[\]#|<>])/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  for (const raw of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading && heading[1].length === top) {
      current = { title: clean(heading[2].trim()), lines: [] };
      slides.push(current);
      continue;
    }
    if (!raw.trim() || /^\|?\s*-{3,}/.test(raw)) continue;
    if (!current) {
      current = { title: '', lines: [] };
      slides.push(current);
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (heading) current.lines.push({ text: clean(heading[2]), level: 0, bullet: false });
    else if (item) current.lines.push({ text: clean(item[3]), level: Math.min(8, Math.floor(item[1].replace(/\t/g, '    ').length / 2)), bullet: true });
    else current.lines.push({ text: clean(raw.replace(/^>\s?/, '').trim()), level: 0, bullet: false });
  }
  return slides;
}

const para = (text: string, level: number, bullet: boolean): XmlElement =>
  el('a:p', {}, [el('a:pPr', { ...(level && { lvl: String(level) }), ...(!bullet && { marL: '0', indent: '0' }) }, bullet ? [] : [el('a:buNone')]), el('a:r', {}, [el('a:rPr', { lang: 'en-US', dirty: '0' }), el('a:t', {}, [text])])]);

/** A deck made from Markdown: a Title and Content slide for each top-level heading. */
export async function deckFromMarkdown(markdown: string): Promise<Uint8Array> {
  const deck = await Deck.read(await blankDeck());
  const slides = outlineSlides(markdown);
  if (!slides.length) return deck.write();
  const master = deck.masters[0];
  const layouts = deck.layoutsOf(master);
  const content = layouts.find((l) => l.xml.attrs.type === 'obj') ?? layouts[1];
  const tx = new Transaction(deck, 'outline');
  const first = deck.slides[0];
  for (const [i, s] of slides.entries()) {
    await addSlide(deck, content, i + 1, tx);
    const slide = deck.slides[i + 1];
    for (const sp of kids(treeOf(slide), 'p:sp')) {
      const ph = placeholderOf(sp);
      const txBody = kid(sp, 'p:txBody');
      if (!ph || !txBody) continue;
      const rest = kids(txBody).filter((c) => c.name !== 'a:p');
      if (ph.type === 'title') txBody.children = [...rest, para(s.title, 0, false)];
      else if (s.lines.length) txBody.children = [...rest, ...s.lines.map((l) => para(l.text, l.level, l.bullet))];
    }
  }
  // The blank deck's own empty title slide goes.
  await deleteSlides(deck, [first], tx);
  for (const name of tx.touched) {
    const part = deck.part(name);
    if (part) deck.markDirty(part);
  }
  return deck.write();
}
