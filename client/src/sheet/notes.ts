// Notes (Excel's comments, the yellow kind): read from a sheet's comments part, shown as a red mark in their cell's corner
// and a card when the pointer rests on the cell, and kept with their cells when rows and columns move: the comments part
// is written with the notes' cells as they are now, and so is the VML drawing Excel shows them with (each note's shape
// names its cell's row and column, and its anchor).

import { child, elements, serializeXml, textContent } from '@golemdocs/docx';
import type { OpcPackage, XmlElement } from '@golemdocs/docx';
import { cellName, parseCell } from './refs.ts';

export interface Note {
  row: number;
  col: number;
  author: string;
  text: string;
  /** Where the note's VML shape last said it was (the drawing is rewritten from there to here). */
  drawn: { row: number; col: number };
  element: XmlElement;
}

export interface NoteParts {
  comments: string;
  vml: string | null;
  /** The comments part's root (its authors, and anything else in it). */
  root: XmlElement;
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
  if (list) {
    for (const n of notes) n.element.attrs.ref = cellName(n.row, n.col);
    list.children = notes.map((n) => n.element);
  }
  pkg.set(parts.comments, serializeXml(parts.root), 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml');
  if (!parts.vml) return;
  const vml = await pkg.text(parts.vml);
  const moved = new Map(notes.map((n) => [`${n.drawn.row}:${n.drawn.col}`, n]));
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
  pkg.set(parts.vml, out, 'application/vnd.openxmlformats-officedocument.vmlDrawing');
  for (const n of notes) n.drawn = { row: n.row, col: n.col };
}

