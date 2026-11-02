// SPDX-License-Identifier: MIT
// The comments part (word/comments.xml): reading it into Comment objects and writing them
// back. Comments that haven't changed are written as they were read (all their formatting);
// changed and new ones are written as plain paragraphs. Replies and the resolved mark live in
// the extended part (word/commentsExtended.xml), which links comments by the w14:paraId of
// their last paragraph.

import type { Comment } from '../model/types.ts';
import { el, elements, textContent, type XmlElement } from '../xml/xml.ts';

export interface CommentsPart {
  comments: Comment[];
  rootAttrs: Record<string, string>;
  /** The extended part's root attributes as read (its namespaces and mc:Ignorable), if it had one. */
  extendedRootAttrs?: Record<string, string>;
  /** Each comment's element as read, and the comment it was read as (to tell if it changed). */
  originals: Map<string, { comment: string; xml: XmlElement }>;
}

/** The comment without what the extended part holds, to tell if its own part has to be rewritten. */
function content(c: Comment): string {
  const { parentId: _p, resolved: _r, ...rest } = c;
  return JSON.stringify(rest);
}

/** An attribute by its local name, whatever prefix the producer bound the namespace to. */
function local(e: XmlElement, name: string): string | undefined {
  for (const key in e.attrs) if (key === name || key.endsWith(`:${name}`)) return e.attrs[key];
  return undefined;
}

function lastParaId(comment: XmlElement): string | undefined {
  const paragraphs = [...elements(comment)].filter((p) => p.name === 'w:p');
  const last = paragraphs[paragraphs.length - 1];
  return last && local(last, 'paraId');
}

export function readComments(root: XmlElement, extended?: XmlElement): CommentsPart {
  const comments: Comment[] = [];
  const originals = new Map<string, { comment: string; xml: XmlElement }>();
  const byParaId = new Map<string, Comment>();
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
    originals.set(id, { comment: content(comment), xml: e });
    const paraId = lastParaId(e);
    if (paraId) byParaId.set(paraId, comment);
  }
  for (const ex of extended ? elements(extended) : []) {
    if (!ex.name.endsWith(':commentEx')) continue;
    const comment = byParaId.get(local(ex, 'paraId') ?? '');
    if (!comment) continue;
    const parent = byParaId.get(local(ex, 'paraIdParent') ?? '');
    if (parent && parent !== comment) comment.parentId = parent.id;
    if (local(ex, 'done') === '1' || local(ex, 'done') === 'true') comment.resolved = true;
  }
  return { comments, rootAttrs: { ...root.attrs }, ...(extended && { extendedRootAttrs: { ...extended.attrs } }), originals };
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

/** A paragraph id in Word's range (below 0x80000000), derived from the comment so it is stable. */
function paraId(comment: Comment, index: number): string {
  let h = 0x811c9dc5;
  for (const ch of `${comment.id}:${index}:${comment.paragraphs[index] ?? ''}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return ((h >>> 1) || 1).toString(16).toUpperCase().padStart(8, '0');
}

/** A paragraph's text as run content: tabs and line breaks as w:tab and w:br (the reverse of paragraphText). */
function textContentOf(text: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const piece of text.split(/(\t|\n)/)) {
    if (piece === '\t') out.push(el('w:tab'));
    else if (piece === '\n') out.push(el('w:br'));
    else if (piece) out.push(el('w:t', { 'xml:space': 'preserve' }, [piece]));
  }
  return out;
}

export interface WrittenComments {
  comments: XmlElement;
  /** word/commentsExtended.xml, when a comment is a reply or resolved (or the file had one). */
  extended?: XmlElement;
}

export function writeComments(part: Pick<CommentsPart, 'comments' | 'rootAttrs' | 'extendedRootAttrs' | 'originals'>, hadExtended = false): WrittenComments {
  const writeExtended = hadExtended || part.comments.some((c) => c.parentId || c.resolved);
  const ids = new Map<string, string>();
  const children = part.comments.map((comment) => {
    const original = part.originals.get(comment.id);
    if (original && original.comment === content(comment)) {
      let xml = original.xml;
      let id = lastParaId(xml);
      if (!id && writeExtended) {
        // Give the last paragraph an id so the extended part can point at it.
        id = paraId(comment, comment.paragraphs.length - 1);
        xml = { ...xml, children: [...xml.children] };
        const at = xml.children.map((c) => typeof c !== 'string' && c.name === 'w:p').lastIndexOf(true);
        if (at >= 0) {
          const p = xml.children[at] as XmlElement;
          xml.children[at] = { ...p, attrs: { 'w14:paraId': id, ...p.attrs } };
        }
      }
      if (id) ids.set(comment.id, id);
      return xml;
    }
    const texts = comment.paragraphs.length ? comment.paragraphs : [''];
    ids.set(comment.id, paraId(comment, texts.length - 1));
    return el(
      'w:comment',
      { 'w:id': comment.id, 'w:author': comment.author, 'w:date': comment.date, 'w:initials': comment.initials },
      texts.map((text, i) =>
        el('w:p', { 'w14:paraId': paraId(comment, i) }, [
          el('w:pPr', {}, [el('w:pStyle', { 'w:val': 'CommentText' })]),
          ...(i === 0 ? [el('w:r', {}, [el('w:rPr', {}, [el('w:rStyle', { 'w:val': 'CommentReference' })]), el('w:annotationRef')])] : []),
          ...(text ? [el('w:r', {}, textContentOf(text))] : []),
        ]),
      ),
    );
  });
  const comments = el('w:comments', { ...part.rootAttrs }, children);
  if (!writeExtended) return { comments };
  const extended = el(
    'w15:commentsEx',
    part.extendedRootAttrs
      ? { ...part.extendedRootAttrs }
      : {
          'xmlns:mc': 'http://schemas.openxmlformats.org/markup-compatibility/2006',
          'xmlns:w15': 'http://schemas.microsoft.com/office/word/2012/wordml',
          'mc:Ignorable': 'w15',
        },
    part.comments.map((c) => el('w15:commentEx', { 'w15:paraId': ids.get(c.id), 'w15:paraIdParent': c.parentId ? ids.get(c.parentId) : undefined, 'w15:done': c.resolved ? 1 : 0 })),
  );
  return { comments, extended };
}
