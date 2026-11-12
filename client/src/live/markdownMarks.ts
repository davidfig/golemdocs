// How a live block is written in Markdown (docs/live-blocks.md §4): its result between two HTML comments, which Obsidian,
// GitHub and other Markdown apps hide, so they show an ordinary table or value.
//
//   <!-- golem:live Budget.xlsx#Expenses stamp=3f9a2c1e -->
//   | Item | Amount |
//   ...
//   <!-- /golem:live -->
//
// and inside a sentence: `So far <!-- golem:live Budget.xlsx#Total stamp=… -->$4,210<!-- /golem:live -->.`

import { parseLiveTag } from './liveMarks.ts';
import type { LiveTag } from './liveMarks.ts';

export const LIVE_CLOSE = '<!-- /golem:live -->';
const OPEN = /^ {0,3}<!-- golem:live (.+?) -->\s*$/;
const INLINE = /<!-- golem:live (.+?) -->([\s\S]*?)<!-- \/golem:live -->/g;

/** The opening marker for a block's tag. */
export const liveOpen = ({ source, stamp }: LiveTag): string => `<!-- golem:live ${source.replace(/--/g, '- -')}${stamp ? ` stamp=${stamp}` : ''} -->`;

/** The tag a line that is an opening marker on its own carries, or null. */
export function liveOpenTag(line: string): LiveTag | null {
  const m = OPEN.exec(line);
  return m ? parseLiveTag(`live:${m[1]}`) : null;
}

/** Whether a line is a closing marker on its own. */
export const liveClose = (line: string): boolean => line.trim() === LIVE_CLOSE;

/** A paragraph's text split at its inline live values: plain text, and each value's tag and the text between its markers. */
export function splitLiveInline(text: string): (string | { tag: LiveTag; text: string })[] {
  if (!text.includes('<!-- golem:live ')) return [text];
  const out: (string | { tag: LiveTag; text: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const tag = parseLiveTag(`live:${m[1]}`);
    if (!tag) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ tag, text: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
