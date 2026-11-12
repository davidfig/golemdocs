// Updating a document's live blocks (docs/live-blocks.md §1, §6): each block's source is looked up and produced again, and a
// block whose result changed gets the new one. A block whose source is missing or gives an error keeps its last result
// (principle 6) and is reported. The document is changed in place; nothing changes when nothing differs.

import type { Block, Drawing, Inline, WordDocument } from '@golemdocs/docx';
import { findLiveIn, retag } from './liveMarks.ts';
import type { LiveAt, LiveTag } from './liveMarks.ts';
import { resultBlocks, resultInlines } from './result.ts';
import type { LiveError, LiveResult } from './result.ts';
import { resultOf, stampOf } from './sources.ts';
import { placeBlocks } from './textSource.ts';
import type { SourceLookup } from './sources.ts';

export interface LiveProblem {
  source: string;
  code: LiveError;
  detail?: string;
}

export interface UpdateReport {
  /** Blocks given a new result. */
  updated: number;
  /** Blocks left as they were because their source failed. */
  problems: LiveProblem[];
}

/** The first drawing in some content: a picture already placed keeps the size it was given. */
function placedSize(nodes: (Block | Inline)[]): { width: number; height: number } | undefined {
  for (const node of nodes) {
    if (node.kind === 'run') {
      const drawing = node.content.find((c): c is Drawing => c.kind === 'drawing');
      if (drawing) return { width: drawing.width, height: drawing.height };
    } else if (node.kind === 'paragraph' || node.kind === 'wrapper' || node.kind === 'hyperlink') {
      const found = placedSize(node.children as (Block | Inline)[]);
      if (found) return found;
    }
  }
  return undefined;
}

/** Puts a result in a block's place, with its new stamp. */
function place(at: LiveAt, result: LiveResult, stamp: string, document: WordDocument): boolean {
  const tag: LiveTag = { source: at.tag.source, stamp };
  const keep = placedSize(at.wrapper.children);
  if (at.kind === 'block') {
    const blocks = result.kind === 'blocks' ? placeBlocks(result, document) : resultBlocks(result, document, at.tag.source, keep);
    if (!blocks) return false;
    at.list[at.index] = retag(at.wrapper, tag, blocks);
  } else {
    const inlines = resultInlines(result, document, at.tag.source, keep);
    if (!inlines) return false;
    at.list[at.index] = retag(at.wrapper, tag, inlines);
  }
  return true;
}

/**
 * Brings every live block of a document up to date. `force` rewrites blocks whose stamp already matches (a block whose
 * result was edited by hand outside the app is put right only this way, or when its source changes).
 */
export function updateLive(document: WordDocument, lookup: SourceLookup, options: { force?: boolean } = {}): Promise<UpdateReport> {
  return updateLiveIn(document.body, document, lookup, options);
}

/** The same for some blocks headed for `document` (pasted ones): pictures are added to it, tables sized to its page. */
export async function updateLiveIn(blocks: Block[], document: WordDocument, lookup: SourceLookup, options: { force?: boolean } = {}): Promise<UpdateReport> {
  const report: UpdateReport = { updated: 0, problems: [] };
  const live = findLiveIn(blocks);
  if (!live.length) return report;
  // Each source is produced once, however many blocks show it.
  const results = new Map<string, Promise<LiveResult>>();
  const files = new Map<string, ReturnType<SourceLookup>>();
  const resultFor = (source: string): Promise<LiveResult> => {
    let found = results.get(source);
    if (!found) results.set(source, (found = resultOf(source, lookup, files)));
    return found;
  };
  // Replaced from the last so the places found stay right (two blocks can share a list).
  for (const at of live.reverse()) {
    const result = await resultFor(at.tag.source);
    if (result.kind === 'error') {
      report.problems.push({ source: at.tag.source, code: result.code, ...(result.detail !== undefined && { detail: result.detail }) });
      continue;
    }
    const stamp = stampOf(result);
    if (stamp === at.tag.stamp && !options.force) continue;
    if (place(at, result, stamp, document)) report.updated++;
  }
  return report;
}
