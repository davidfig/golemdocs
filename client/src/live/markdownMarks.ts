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
// The tag is the marker's text up to the first " -->" (a source is written with no "--", but one typed by hand may have it).
const OPEN = /^ {0,3}<!-- golem:live ((?:(?!-->)[^\n])+?) -->\s*$/;
const INLINE_OPEN = /<!-- golem:live ((?:(?!-->)[^\n])+?) -->/y;

/**
 * A source as written in a marker: "%" and the second "-" of each "--" percent-encoded, as "--" can't stand in an HTML comment.
 * Decoding only "%25" and "%2D" keeps a marker written before this encoding (no "%25" or "%2D" in it) reading the same.
 */
const encodeSource = (source: string): string => source.replace(/%/g, '%25').replace(/--/g, '-%2D');
const decodeSource = (text: string): string => text.replace(/%(25|2D)/gi, (_m, hex: string) => (hex === '25' ? '%' : '-'));
const tagOf = (text: string): LiveTag | null => {
  const tag = parseLiveTag(`live:${text}`);
  return tag && { ...tag, source: decodeSource(tag.source) };
};

/** The opening marker for a block's tag. */
export const liveOpen = ({ source, stamp, by }: LiveTag): string => `<!-- golem:live ${encodeSource(source)}${by ? ` by=${by}` : ''}${stamp ? ` stamp=${stamp}` : ''} -->`;

/** The tag a line that is an opening marker on its own carries, or null. */
export function liveOpenTag(line: string): LiveTag | null {
  const m = OPEN.exec(line);
  return m ? tagOf(m[1]) : null;
}

/** The opening marker at `at` in a paragraph's text: its tag and where it ends, or null. */
export function liveOpenAt(text: string, at: number): { tag: LiveTag; end: number } | null {
  INLINE_OPEN.lastIndex = at;
  const m = INLINE_OPEN.exec(text);
  const tag = m && tagOf(m[1]);
  return tag ? { tag, end: at + m[0].length } : null;
}

/** Whether a line is a closing marker on its own. */
export const liveClose = (line: string): boolean => line.trim() === LIVE_CLOSE;
