// The comments part (word/comments.xml): reading it into Comment objects and writing them
// back. Comments that haven't changed are written as they were read (all their formatting);
// changed and new ones are written as plain paragraphs.

import type { Comment } from '../model/types.ts';
import { el, elements, textContent, type XmlElement } from '../xml/xml.ts';

export interface CommentsPart {
  comments: Comment[];
  rootAttrs: Record<string, string>;
  /** Each comment's element as read, and the comment it was read as (to tell if it changed). */
  originals: Map<string, { comment: string; xml: XmlElement }>;
}

export function readComments(root: XmlElement): CommentsPart {
  const comments: Comment[] = [];
  const originals = new Map<string, { comment: string; xml: XmlElement }>();
  for (const e of elements(root)) {
    if (e.name !== 'w:comment') continue;
    const id = e.attrs['w:id'];
    if (id === undefined) continue;
    const comment: Comment = {
      id,
      author: e.attrs['w:author'] ?? '',
      ...(e.attrs['w:initials'] !== undefined && { initials: e.attrs['w:initials'] }),
      ...(e.attrs['w:date'] !== undefined && { date: e.attrs['w:date'] }),
      paragraphs: [...elements(e)].filter((p) => p.name === 'w:p').map(paragraphText),
    };
    comments.push(comment);
    originals.set(id, { comment: JSON.stringify(comment), xml: e });
  }
  return { comments, rootAttrs: { ...root.attrs }, originals };
}

/** Text of a comment paragraph: its text, tabs and breaks (the annotation reference mark is skipped). */
function paragraphText(p: XmlElement): string {
  let out = '';
  const visit = (e: XmlElement) => {
    for (const c of elements(e)) {
      if (c.name === 'w:t') out += textContent(c);
      else if (c.name === 'w:tab') out += '\t';
      else if (c.name === 'w:br' || c.name === 'w:cr') out += '\n';
      else if (c.name !== 'w:rPr' && c.name !== 'w:pPr' && c.name !== 'w:annotationRef') visit(c);
    }
  };
  visit(p);
  return out;
}

export function writeComments(part: Pick<CommentsPart, 'comments' | 'rootAttrs' | 'originals'>): XmlElement {
  const children = part.comments.map((comment) => {
    const original = part.originals.get(comment.id);
    if (original && original.comment === JSON.stringify(comment)) return original.xml;
    return el(
      'w:comment',
      { 'w:id': comment.id, 'w:author': comment.author, 'w:date': comment.date, 'w:initials': comment.initials },
      (comment.paragraphs.length ? comment.paragraphs : ['']).map((text, i) =>
        el('w:p', {}, [
          el('w:pPr', {}, [el('w:pStyle', { 'w:val': 'CommentText' })]),
          ...(i === 0 ? [el('w:r', {}, [el('w:rPr', {}, [el('w:rStyle', { 'w:val': 'CommentReference' })]), el('w:annotationRef')])] : []),
          ...(text ? [el('w:r', {}, [el('w:t', { 'xml:space': 'preserve' }, [text])])] : []),
        ]),
      ),
    );
  });
  return el('w:comments', { ...part.rootAttrs }, children);
}
