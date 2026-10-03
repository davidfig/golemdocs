// How a search result's text is shown: its #tags (which can be clicked) and the words searched for marked.

import { fold, readTag } from '@golemdocs/docx';

const CJK_START = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** `text` folded the way the index folds it (lower case, Latin accents dropped), with where each folded character came from in `text`. */
function foldedWithMap(text: string): { folded: string; start: number[]; end: number[] } {
  let folded = '';
  const start: number[] = [];
  const end: number[] = [];
  // A letter and its combining marks are folded together: dropping an accent needs the letter it is on.
  for (const m of text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const piece = fold(m[0]);
    for (let i = 0; i < piece.length; i++) {
      start.push(m.index);
      end.push(m.index + m[0].length);
    }
    folded += piece;
  }
  return { folded, start, end };
}

/** Where the words (as the index has them: folded) are in `text`, as ranges of `text`: accents and case are ignored, and a word has to start where a word does. */
function matchRanges(text: string, words: readonly string[]): [number, number][] {
  const wanted = words.filter(Boolean).map((w) => `${CJK_START.test(w) ? '' : '(?<![\\p{L}\\p{N}\\p{M}])'}${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  if (!wanted.length) return [];
  const { folded, start, end } = foldedWithMap(text);
  const ranges: [number, number][] = [];
  for (const m of folded.matchAll(new RegExp(wanted.join('|'), 'gu'))) {
    if (m[0]) ranges.push([start[m.index]!, end[m.index + m[0].length - 1]!]);
  }
  return ranges;
}

/** `text` as pieces: tags (`#plan`, clickable), words of the search (marked), and the rest. */
export function highlightPieces(text: string, words: readonly string[]): { text: string; kind: 'tag' | 'match' | 'plain' }[] {
  const pieces: { text: string; kind: 'tag' | 'match' | 'plain' }[] = [];
  const plain = (chunk: string) => {
    if (!chunk) return;
    let last = 0;
    for (const [from, to] of matchRanges(chunk, words)) {
      if (from < last) continue; // inside a match already shown
      if (from > last) pieces.push({ text: chunk.slice(last, from), kind: 'plain' });
      pieces.push({ text: chunk.slice(from, to), kind: 'match' });
      last = to;
    }
    if (last < chunk.length) pieces.push({ text: chunk.slice(last), kind: 'plain' });
  };
  let last = 0;
  for (let at = text.indexOf('#'); at >= 0; at = text.indexOf('#', at + 1)) {
    const tag = readTag(text, at);
    if (!tag) continue;
    plain(text.slice(last, at));
    pieces.push({ text: text.slice(at, tag.end), kind: 'tag' });
    last = tag.end;
    at = tag.end - 1;
  }
  plain(text.slice(last));
  return pieces;
}
