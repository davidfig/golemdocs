// A document's comments as PDF annotations, for export. Each comment is a sticky note (a /Text
// annotation) in the page margin beside the first line of the text it comments on; a reply is a
// note in reply to its parent's (/IRT, §12.5.6.4) at the same spot; a resolved thread is marked the
// way Acrobat does it, with a further, invisible reply that sets the state "Completed" (of the
// "Review" model). A comment with no place in the laid-out text (say, one on a header) goes to
// the top of the first page, so none is dropped.

import { commentRanges, paragraphsIn, type Comment, type WordDocument } from '@golemdocs/docx';
import { toVisible, type PageLayout } from '@golemdocs/layout';
import { formatDate, noteRect, type Annotation } from '@golemdocs/pdf';

/** Sticky-note yellow. */
const NOTE_COLOR: [number, number, number] = [1, 0.85, 0.2];

/** A PDF date string for an ISO 8601 date, undefined when it isn't one. */
function pdfDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  return /Z$/i.test(iso) ? `D:${at.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z` : formatDate(at);
}

/** Where each comment's first line is: its page and the line's box, in top-left page coordinates. */
function placements(document: WordDocument, pages: readonly PageLayout[]): Map<string, { page: number; x: number; y: number; height: number }> {
  const ranges = commentRanges(paragraphsIn(document.body));
  const out = new Map<string, { page: number; x: number; y: number; height: number }>();
  for (const [id, range] of ranges) {
    for (let p = 0; p < pages.length && !out.has(id); p++) {
      for (const line of pages[p].lines) {
        if (line.paragraph !== range.start.paragraph) continue;
        const at = toVisible(line.spans, range.start.offset);
        if (at < line.start || (at >= line.end && !line.last)) continue;
        out.set(id, { page: p, x: Math.min(line.x, line.column), y: line.y, height: line.height });
        break;
      }
    }
  }
  return out;
}

/** The annotations for a document's comments, in the pages' point coordinates (y up). */
export function commentAnnotations(document: WordDocument, pages: readonly PageLayout[]): Annotation[] {
  if (!document.comments.length) return [];
  const where = placements(document, pages);
  const byId = new Map(document.comments.map((c) => [c.id, c]));
  const iconHeight = -noteRect(0, 0)[1];
  const iconWidth = noteRect(0, 0)[2];
  /** The thread's first comment, following parents (a broken or circular chain ends where it breaks). */
  const rootOf = (c: Comment): Comment => {
    const seen = new Set<string>();
    while (c.parentId && byId.has(c.parentId) && !seen.has(c.id)) {
      seen.add(c.id);
      c = byId.get(c.parentId)!;
    }
    return c;
  };
  const out: Annotation[] = [];
  const states: Annotation[] = [];
  for (const c of document.comments) {
    const root = rootOf(c);
    const spot = where.get(root.id) ?? { page: 0, x: 72, y: 36, height: iconHeight };
    const height = pages[spot.page]?.height ?? 792;
    const x = Math.max(0, spot.x - iconWidth - 2);
    // The icon's middle on the line's middle, so a reader (or our importer) finds the line by it.
    const rect = noteRect(x, height - (spot.y + spot.height / 2) + iconHeight / 2);
    const isReply = c !== root && byId.has(c.parentId ?? '');
    const modified = pdfDate(c.date);
    const annotation: Annotation = {
      id: `comment${c.id}`,
      page: spot.page,
      kind: 'note',
      rect,
      quads: [],
      color: NOTE_COLOR,
      contents: c.paragraphs.join('\n'),
      ...(c.author && { author: c.author }),
      ...(modified && { modified }),
      ...(isReply && { replyTo: `comment${c.parentId}` }),
    };
    out.push(annotation);
    if (c.resolved && !isReply) {
      states.push({ ...annotation, id: `comment${c.id}-state`, contents: '', replyTo: annotation.id, state: 'Completed' });
    }
  }
  return [...out, ...states];
}
