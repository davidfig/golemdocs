// Editing the text of a shape (docs/architecture/drawingml.md): positions are a paragraph and a character offset in it (a line break and a
// field count as their text), and every change is made to the `a:p` / `a:r` / `a:t` XML directly, keeping each run's own
// properties. Typing joins the run before the caret, as PowerPoint does; a new run takes the paragraph's end properties.

import { cloneElement, el, type XmlElement } from '@golemdocs/docx';
import { ensure, insertBefore, kid, kids, localKid, ownText, prefixOf, replaceKid } from './ooxml.ts';

export interface TextPos {
  p: number;
  o: number;
}

export const comparePos = (a: TextPos, b: TextPos): number => a.p - b.p || a.o - b.o;
export const minPos = (a: TextPos, b: TextPos): TextPos => (comparePos(a, b) <= 0 ? a : b);
export const maxPos = (a: TextPos, b: TextPos): TextPos => (comparePos(a, b) <= 0 ? b : a);

/** The paragraphs of a text body. */
export function paragraphsOf(txBody: XmlElement): XmlElement[] {
  return kids(txBody, 'a:p');
}

/** The text of a run-level element as offsets count it. */
export function itemText(item: XmlElement): string {
  if (item.name === 'a:br') return '\n';
  if (item.name === 'a:r' || item.name === 'a:fld') return kids(item, 'a:t').map(ownText).join('');
  return '';
}

const isItem = (c: XmlElement): boolean => c.name === 'a:r' || c.name === 'a:br' || c.name === 'a:fld';

export function paragraphLength(p: XmlElement): number {
  let n = 0;
  for (const c of kids(p)) if (isItem(c)) n += itemText(c).length;
  return n;
}

export function plainText(p: XmlElement): string {
  return kids(p)
    .filter(isItem)
    .map(itemText)
    .join('');
}

function setRunText(run: XmlElement, text: string): void {
  const t = kid(run, 'a:t') ?? ensure(run, 'a:t');
  t.children = [text];
  // A run holds one a:t.
  run.children = run.children.filter((c) => typeof c === 'string' || c.name !== 'a:t' || c === t);
}

/** Run properties for new text: the given ones, else the end of paragraph's (without what only marks the end). */
function runProps(p: XmlElement, from?: XmlElement): XmlElement {
  const source = from ? kid(from, 'a:rPr') : kid(p, 'a:endParaRPr');
  const rPr = source ? cloneElement(source) : el('a:rPr', { lang: 'en-US' });
  rPr.name = 'a:rPr';
  const attrs = { ...rPr.attrs };
  delete attrs.dirty;
  rPr.attrs = { ...attrs, dirty: '0' };
  return rPr;
}

/** Splits the paragraph's runs so one boundary falls at offset `o`; returns the index (in `p.children`) of the first item after it. */
export function splitAt(p: XmlElement, o: number): number {
  let at = 0;
  for (let i = 0; i < p.children.length; i++) {
    const c = p.children[i];
    if (typeof c === 'string' || !isItem(c)) continue;
    const len = itemText(c).length;
    if (o <= at) return i;
    if (o < at + len) {
      if (c.name !== 'a:r') return i + 1;
      const text = itemText(c);
      const head = cloneElement(c);
      setRunText(head, text.slice(0, o - at));
      setRunText(c, text.slice(o - at));
      p.children.splice(i, 0, head);
      return i + 1;
    }
    at += len;
  }
  // Past the last run: before the end properties.
  const end = p.children.findIndex((c) => typeof c !== 'string' && c.name === 'a:endParaRPr');
  return end < 0 ? p.children.length : end;
}

/** Inserts plain text (no line ends) at an offset; `style` is a run whose properties new text takes. */
export function insertText(p: XmlElement, o: number, text: string, style?: XmlElement): void {
  if (!text) return;
  const index = splitAt(p, o);
  const before = [...p.children.slice(0, index)].reverse().find((c): c is XmlElement => typeof c !== 'string' && isItem(c));
  if (!style && before?.name === 'a:r') {
    setRunText(before, itemText(before) + text);
    return;
  }
  const after = p.children.slice(index).find((c): c is XmlElement => typeof c !== 'string' && isItem(c));
  if (!style && !before && after?.name === 'a:r') {
    setRunText(after, text + itemText(after));
    return;
  }
  const rPr = style ? (kid(style, 'a:rPr') ? cloneElement(kid(style, 'a:rPr')!) : runProps(p)) : runProps(p, before?.name === 'a:fld' ? before : undefined);
  p.children.splice(index, 0, el('a:r', {}, [rPr, el('a:t', {}, [text])]));
}

/** A line break inside the paragraph (Shift+Enter). */
export function insertBreak(p: XmlElement, o: number): void {
  const index = splitAt(p, o);
  const before = [...p.children.slice(0, index)].reverse().find((c): c is XmlElement => typeof c !== 'string' && isItem(c));
  p.children.splice(index, 0, el('a:br', {}, [runProps(p, before?.name === 'a:r' ? before : undefined)]));
}

/** Removes the text between two offsets of a paragraph. */
export function deleteInParagraph(p: XmlElement, from: number, to: number): void {
  if (to <= from) return;
  const start = splitAt(p, from);
  const end = splitAt(p, to);
  const removed = p.children.slice(start, end).filter((c): c is XmlElement => typeof c !== 'string' && isItem(c));
  // Keeps the look of the text removed for the paragraph's end, when nothing is left.
  const lastRun = removed.filter((r) => r.name === 'a:r').pop();
  p.children = p.children.filter((c) => typeof c === 'string' || !removed.includes(c));
  if (!kids(p).some(isItem) && lastRun) {
    const rPr = kid(lastRun, 'a:rPr');
    if (rPr) replaceKid(p, 'a:endParaRPr', { ...cloneElement(rPr), name: 'a:endParaRPr' });
  }
}

/** Deletes from one position to another, joining the paragraphs at either end. */
export function deleteRange(txBody: XmlElement, a: TextPos, b: TextPos): TextPos {
  const from = minPos(a, b);
  const to = maxPos(a, b);
  const ps = paragraphsOf(txBody);
  if (from.p === to.p) {
    deleteInParagraph(ps[from.p], from.o, to.o);
    return from;
  }
  const first = ps[from.p];
  const last = ps[to.p];
  deleteInParagraph(first, from.o, paragraphLength(first));
  deleteInParagraph(last, 0, to.o);
  // The rest of the last paragraph joins the first.
  const moved = kids(last).filter(isItem);
  const end = first.children.findIndex((c) => typeof c !== 'string' && c.name === 'a:endParaRPr');
  if (end < 0) first.children.push(...moved);
  else first.children.splice(end, 0, ...moved);
  const between = ps.slice(from.p + 1, to.p + 1);
  txBody.children = txBody.children.filter((c) => typeof c === 'string' || !between.includes(c));
  return from;
}

/** Splits a paragraph at a position (Enter): the new paragraph keeps its properties. */
export function splitParagraph(txBody: XmlElement, at: TextPos): TextPos {
  const p = paragraphsOf(txBody)[at.p];
  const index = splitAt(p, at.o);
  const pPr = kid(p, 'a:pPr');
  const endPr = kid(p, 'a:endParaRPr');
  const tail = p.children.slice(index).filter((c): c is XmlElement => typeof c !== 'string' && isItem(c));
  p.children = p.children.filter((c) => typeof c === 'string' || !tail.includes(c));
  // The new paragraph's end takes the look of the text before the split.
  const lastRun = kids(p).filter((c) => c.name === 'a:r').pop();
  const endLook = lastRun && kid(lastRun, 'a:rPr') ? { ...cloneElement(kid(lastRun, 'a:rPr')!), name: 'a:endParaRPr' } : endPr ? cloneElement(endPr) : el('a:endParaRPr', { lang: 'en-US', dirty: '0' });
  const next = el('a:p', {}, [...(pPr ? [cloneElement(pPr)] : []), ...tail, endLook]);
  txBody.children.splice(txBody.children.indexOf(p) + 1, 0, next);
  return { p: at.p + 1, o: 0 };
}

/** Inserts text that may hold line ends: each `\n` starts a new paragraph. Returns where it ends. */
export function insertMultiline(txBody: XmlElement, at: TextPos, text: string): TextPos {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let pos = at;
  lines.forEach((line, i) => {
    if (i > 0) pos = splitParagraph(txBody, pos);
    const p = paragraphsOf(txBody)[pos.p];
    insertText(p, pos.o, line.replace(/\t/g, '\t'));
    pos = { p: pos.p, o: pos.o + line.length };
  });
  return pos;
}

/** The text between two positions, paragraphs joined with `\n`. */
export function textBetween(txBody: XmlElement, a: TextPos, b: TextPos): string {
  const from = minPos(a, b);
  const to = maxPos(a, b);
  const ps = paragraphsOf(txBody);
  const out: string[] = [];
  for (let i = from.p; i <= to.p; i++) {
    const text = plainText(ps[i]);
    out.push(text.slice(i === from.p ? from.o : 0, i === to.p ? to.o : text.length));
  }
  return out.join('\n');
}

/** The runs covering a range (split so they cover it exactly), across paragraphs. */
export function runsIn(txBody: XmlElement, a: TextPos, b: TextPos): XmlElement[] {
  const from = minPos(a, b);
  const to = maxPos(a, b);
  const ps = paragraphsOf(txBody);
  const out: XmlElement[] = [];
  for (let i = from.p; i <= to.p; i++) {
    const p = ps[i];
    const s = i === from.p ? from.o : 0;
    const e = i === to.p ? to.o : paragraphLength(p);
    if (e <= s) continue;
    const start = splitAt(p, s);
    const end = splitAt(p, e);
    for (const c of p.children.slice(start, end)) if (typeof c !== 'string' && (c.name === 'a:r' || c.name === 'a:fld')) out.push(c);
  }
  return out;
}

/** The run properties element of a run, made when it has none. */
export function rPrOf(run: XmlElement): XmlElement {
  const found = kid(run, 'a:rPr');
  if (found) return found;
  const made = el('a:rPr', { lang: 'en-US', dirty: '0' });
  run.children.unshift(made);
  return made;
}

/** The paragraph properties element of a paragraph, made when it has none. */
export function pPrOf(p: XmlElement): XmlElement {
  const found = kid(p, 'a:pPr');
  if (found) return found;
  const made = el('a:pPr');
  p.children.unshift(made);
  return made;
}

/** A word's start and end around an offset (for a double click). */
export function wordAt(text: string, o: number): [number, number] {
  const isWord = (c: string): boolean => /[\p{L}\p{N}_'’]/u.test(c);
  let s = o;
  let e = o;
  if (o < text.length && isWord(text[o])) {
    while (s > 0 && isWord(text[s - 1])) s--;
    while (e < text.length && isWord(text[e])) e++;
  } else if (o > 0 && isWord(text[o - 1])) {
    s = o - 1;
    while (s > 0 && isWord(text[s - 1])) s--;
  } else e = Math.min(text.length, o + 1);
  return [s, e];
}

/** Makes sure a shape has a text body (`p:txBody`, `xdr:txBody`: its own prefix) to type into. */
export function ensureBody(shape: XmlElement): XmlElement {
  let body = localKid(shape, 'txBody');
  if (!body) {
    body = el(`${prefixOf(shape.name)}:txBody`, {}, [el('a:bodyPr'), el('a:lstStyle'), el('a:p', {}, [el('a:endParaRPr', { lang: 'en-US', dirty: '0' })])]);
    shape.children.push(body);
  }
  if (!paragraphsOf(body).length) body.children.push(el('a:p', {}, [el('a:endParaRPr', { lang: 'en-US', dirty: '0' })]));
  return body;
}

// ---- List styles: the settings of each level -----------------------------------------------------------------------------

/** Children of a list style (`a:lstStyle`, `p:titleStyle`...), in schema order. */
const LIST_ORDER = ['a:defPPr', ...Array.from({ length: 9 }, (_, i) => `a:lvl${i + 1}pPr`), 'a:extLst'];
/** Children of a level's paragraph properties, in schema order. */
const PPR_ORDER = ['a:lnSpc', 'a:spcBef', 'a:spcAft', 'a:buClrTx', 'a:buClr', 'a:buSzTx', 'a:buSzPct', 'a:buSzPts', 'a:buFontTx', 'a:buFont', 'a:buNone', 'a:buAutoNum', 'a:buChar', 'a:buBlip', 'a:tabLst', 'a:defRPr', 'a:extLst'];

function addKid(parent: XmlElement, name: string, before: readonly string[]): XmlElement {
  const made = el(name);
  insertBefore(parent, made, before);
  return made;
}

/** A level's paragraph properties in a list style (`a:lvl2pPr` for level 1), made when missing. */
export function levelOf(list: XmlElement, level: number): XmlElement {
  const name = `a:lvl${Math.max(0, Math.min(8, level)) + 1}pPr`;
  return kid(list, name) ?? addKid(list, name, LIST_ORDER.slice(LIST_ORDER.indexOf(name) + 1));
}

/** A level's default run properties (`a:defRPr`), made when missing. */
export function levelRunOf(list: XmlElement, level: number): XmlElement {
  const lvl = levelOf(list, level);
  return kid(lvl, 'a:defRPr') ?? addKid(lvl, 'a:defRPr', PPR_ORDER.slice(PPR_ORDER.indexOf('a:defRPr') + 1));
}

/** The levels (0 to 8) of a text body's paragraphs, from `first` to `last` (all of them when not given). */
export function levelsIn(body: XmlElement, first = 0, last = Infinity): Set<number> {
  const out = new Set<number>();
  kids(body, 'a:p').forEach((p, i) => {
    if (i >= first && i <= last) out.add(Math.max(0, Math.min(8, Number(kid(p, 'a:pPr')?.attrs.lvl ?? 0) || 0)));
  });
  return out;
}
