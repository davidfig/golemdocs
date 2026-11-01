// Notes (Excel's comments, the yellow kind): read from a sheet's comments part, shown as a red mark in their cell's corner
// and a card when the pointer rests on the cell, and kept with their cells when rows and columns move: the comments part
// is written with the notes' cells as they are now, and so is the VML drawing Excel shows them with (each note's shape
// names its cell's row and column, and its anchor).

import { child, el, elements, serializeXml, textContent } from '@golemdocs/docx';
import type { OpcPackage, XmlElement } from '@golemdocs/docx';

type Relationships = Awaited<ReturnType<OpcPackage['relationships']>>;
import { cellName, parseCell } from './refs.ts';

export interface Note {
  row: number;
  col: number;
  author: string;
  text: string;
  /** Where the note's VML shape last said it was (the drawing is rewritten from there to here); null for a note made
   * here, which has no shape yet. */
  drawn: { row: number; col: number } | null;
  element: XmlElement;
}

export interface NoteParts {
  comments: string;
  vml: string | null;
  /** The comments part's root (its authors, and anything else in it). */
  root: XmlElement;
  /** The sheet's relationship to the VML drawing, for parts made here (the sheet's `<legacyDrawing>` names it). */
  vmlRId?: string;
}

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const COMMENTS_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml';
const VML_TYPE = 'application/vnd.openxmlformats-officedocument.vmlDrawing';

/** A note made here (Sheet › New Note). */
export function newNote(row: number, col: number, author: string, text: string): Note {
  return withText({ row, col, author, text: '', drawn: null, element: el('comment', { ref: cellName(row, col), authorId: 0 }) }, text);
}

/** The note with other text (its element rewritten as one run, as Excel writes a note typed in it). */
export function withText(note: Note, text: string): Note {
  const t = el('t', { 'xml:space': 'preserve' }, [text]);
  const element = el('comment', { ...note.element.attrs }, [...note.element.children.filter((c) => typeof c !== 'string' && c.name !== 'text'), el('text', {}, [el('r', {}, [t])])]);
  return { ...note, text, element };
}

/** The parts a sheet's first note needs: a comments part and the VML drawing Excel shows it with, related from the sheet. */
export function newNoteParts(pkg: OpcPackage, sheetRels: Relationships): NoteParts {
  const comments = pkg.uniqueName('xl/comments', 'xml');
  const vml = pkg.uniqueName('xl/drawings/vmlDrawing', 'vml');
  sheetRels.add(`${REL}/comments`, comments);
  const vmlRId = sheetRels.add(`${REL}/vmlDrawing`, vml);
  // Each VML drawing numbers its shapes from its own block (idmap): one past the others'.
  const blocks = pkg.partNames.filter((n) => n.endsWith('.vml')).length + 1;
  pkg.set(vml, `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="${blocks}"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype></xml>`, VML_TYPE);
  const root = el('comments', { xmlns: MAIN }, [el('authors'), el('commentList')]);
  return { comments, vml, root, vmlRId };
}

/** The sheet has no notes left: its comments part goes, and the VML drawing if notes were all it held. */
export async function removeNoteParts(pkg: OpcPackage, sheetRels: Relationships, parts: NoteParts): Promise<boolean> {
  for (const rel of sheetRels.list.filter((r) => sheetRels.partName(r) === parts.comments)) sheetRels.remove(rel.id);
  pkg.delete(parts.comments);
  if (!parts.vml) return false;
  const shapes = (await pkg.text(parts.vml)).match(/<v:shape\b[\s\S]*?<\/v:shape>/g) ?? [];
  if (shapes.some((shape) => !/ObjectType="Note"/.test(shape))) return false;
  for (const rel of sheetRels.list.filter((r) => sheetRels.partName(r) === parts.vml)) sheetRels.remove(rel.id);
  pkg.delete(parts.vml);
  return true;
}

/** A hidden note's shape, beside its cell, in Excel's look (pale yellow, a shadow). */
function noteShape(id: number, row: number, col: number): string {
  const anchor = [col + 1, 15, Math.max(0, row - 1), 10, col + 3, 15, Math.max(0, row - 1) + 4, 4].join(', ');
  return `<v:shape id="_x0000_s${id}" type="#_x0000_t202" style="position:absolute;margin-left:59.25pt;margin-top:1.5pt;width:108pt;height:59.25pt;z-index:${id % 1024};visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${anchor}</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>${row}</x:Row><x:Column>${col}</x:Column></x:ClientData></v:shape>`;
}

/** `_x000D_`-style escapes as their characters, and a carriage return as a line break. */
const unescape = (s: string): string => s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/\r\n?/g, '\n');

export async function readNotes(pkg: OpcPackage, sheetPart: string, root: XmlElement): Promise<{ notes: Note[]; parts: NoteParts | null }> {
  const rels = await pkg.relationships(sheetPart);
  const comments = rels.list.find((r) => r.type.endsWith('/comments'));
  if (!comments) return { notes: [], parts: null };
  const commentsPart = rels.partName(comments);
  if (!pkg.has(commentsPart)) return { notes: [], parts: null };
  const legacy = child(root, 'legacyDrawing')?.attrs['r:id'];
  const vmlRel = legacy ? rels.byId(legacy) : rels.list.find((r) => r.type.endsWith('/vmlDrawing'));
  const vml = vmlRel ? rels.partName(vmlRel) : null;
  const xml = await pkg.xml(commentsPart);
  const authors = [...elements(child(xml, 'authors') ?? xml)].filter((a) => a.name === 'author').map((a) => textContent(a));
  const notes: Note[] = [];
  for (const c of elements(child(xml, 'commentList') ?? xml)) {
    if (c.name !== 'comment') continue;
    const at = parseCell(c.attrs.ref ?? '');
    if (!at) continue;
    const text = child(c, 'text');
    // Runs (`<r><t>`) or plain `<t>`, joined.
    const pieces = text ? [...elements(text)].flatMap((e) => (e.name === 't' ? [textContent(e)] : e.name === 'r' ? [textContent(child(e, 't') ?? e)] : [])) : [];
    notes.push({ row: at.row, col: at.col, author: authors[+(c.attrs.authorId ?? 0)] ?? '', text: unescape(pieces.join('')), drawn: { ...at }, element: c });
  }
  return { notes, parts: { comments: commentsPart, vml: vml && pkg.has(vml) ? vml : null, root: xml } };
}

/** Writes the comments part and the VML drawing with the notes where they now are (notes whose cells were deleted gone). */
export async function writeNotes(pkg: OpcPackage, notes: Note[], parts: NoteParts): Promise<void> {
  const list = child(parts.root, 'commentList');
  const authors = child(parts.root, 'authors');
  if (list) {
    // Each note names its author by its place in <authors>; a new author is added at the end.
    const names = authors ? [...elements(authors)].filter((a) => a.name === 'author').map((a) => textContent(a)) : [];
    for (const n of notes) {
      n.element.attrs.ref = cellName(n.row, n.col);
      let id = names.indexOf(n.author);
      if (id < 0 && authors) {
        id = names.push(n.author) - 1;
        authors.children.push(el('author', {}, [n.author]));
      }
      n.element.attrs.authorId = String(Math.max(0, id));
    }
    list.children = notes.map((n) => n.element);
  }
  pkg.set(parts.comments, serializeXml(parts.root), COMMENTS_TYPE);
  if (!parts.vml) return;
  const vml = await pkg.text(parts.vml);
  const moved = new Map(notes.flatMap((n) => (n.drawn ? [[`${n.drawn.row}:${n.drawn.col}` as string, n] as const] : [])));
  // Each note's shape: kept and moved with its note, or dropped with it. Shapes that are not notes stay as they are.
  const out = vml.replace(/<v:shape\b[\s\S]*?<\/v:shape>/g, (shape) => {
    const row = /<x:Row>(\d+)<\/x:Row>/.exec(shape);
    const col = /<x:Column>(\d+)<\/x:Column>/.exec(shape);
    if (!/ObjectType="Note"/.test(shape) || !row || !col) return shape;
    const note = moved.get(`${row[1]}:${col[1]}`);
    if (!note) return '';
    const dRow = note.row - +row[1];
    const dCol = note.col - +col[1];
    return shape
      .replace(/<x:Row>\d+<\/x:Row>/, `<x:Row>${note.row}</x:Row>`)
      .replace(/<x:Column>\d+<\/x:Column>/, `<x:Column>${note.col}</x:Column>`)
      .replace(/<x:Anchor>([^<]*)<\/x:Anchor>/, (_, anchor: string) => {
        // Left column, offset, top row, offset, right column, offset, bottom row, offset.
        const v = anchor.split(',').map((s) => +s.trim());
        if (v.length !== 8) return `<x:Anchor>${anchor}</x:Anchor>`;
        v[0] += dCol;
        v[4] += dCol;
        v[2] += dRow;
        v[6] += dRow;
        return `<x:Anchor>\n    ${v.join(', ')}</x:Anchor>`;
      });
  });
  // Notes made here get shapes, numbered on from the drawing's block.
  const block = +(/<o:idmap[^>]*data="(\d+)/.exec(vml)?.[1] ?? 1);
  let next = Math.max(block * 1024, ...[...vml.matchAll(/_x0000_s(\d+)/g)].map((m) => +m[1])) + 1;
  const added = notes.filter((n) => !n.drawn).map((n) => noteShape(next++, n.row, n.col)).join('');
  pkg.set(parts.vml, added ? out.replace(/<\/xml>\s*$/, `${added}</xml>`) : out, VML_TYPE);
  for (const n of notes) n.drawn = { row: n.row, col: n.col };
}

