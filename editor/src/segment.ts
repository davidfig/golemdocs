// SPDX-License-Identifier: MIT
/**
 * Text segmentation for caret movement and selection: CJK-aware word boundaries and grapheme clusters.
 *
 * Plain text (no CJK for words, nothing combinable for graphemes) never reaches Intl.Segmenter, so ordinary
 * English editing keeps its cheap code-unit paths. Segmenter results vary a little between ICU versions;
 * without Intl.Segmenter, words fall back to runs of the same script class.
 */

/** A word-like or non-word stretch of a paragraph's text (UTF-16 offsets). */
export interface Segment {
  start: number;
  end: number;
  /** A word (letters, digits) rather than punctuation or spaces. */
  word: boolean;
}

/** Han, kana (incl. half-width and extensions), Bopomofo and Hangul. */
const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿㇰ-ㇿｦ-ﾟ㄀-ㄯㆠ-ㆿ가-힯\u{20000}-\u{323af}]/u;

/** Anything that can join the code point before it (or after it) into one grapheme cluster. */
const COMBINING = /[\p{M}‍\u{1f3fb}-\u{1f3ff}\u{1f1e6}-\u{1f1ff}ᄀ-ᇿꥠ-꥿ힰ-퟿\u{e0020}-\u{e007f}]/u;

export const hasCjk = (text: string): boolean => CJK.test(text);
export const hasCombining = (text: string): boolean => COMBINING.test(text);

type Seg = { segment: string; index: number; isWordLike?: boolean };
interface SegmenterLike {
  segment(text: string): Iterable<Seg> & { containing(index: number): Seg | undefined };
}
type SegmenterCtor = new (locale?: string, options?: { granularity: 'word' | 'grapheme' }) => SegmenterLike;

const Ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
const wordSegmenter = Ctor ? new Ctor(undefined, { granularity: 'word' }) : null;
const graphemeSegmenter = Ctor ? new Ctor(undefined, { granularity: 'grapheme' }) : null;

/** Script class of a code point for the fallback: each run of one class is a word. */
function scriptClass(cp: number): string {
  if ((cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x20000 && cp <= 0x323af)) return 'han';
  if ((cp >= 0x3040 && cp <= 0x309f) || cp === 0x30fc) return 'hira'; // ー belongs to the surrounding kana in practice
  if ((cp >= 0x30a0 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff) || (cp >= 0xff66 && cp <= 0xff9f)) return 'kata';
  if ((cp >= 0x3100 && cp <= 0x312f) || (cp >= 0x31a0 && cp <= 0x31bf)) return 'bopomofo';
  if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff)) return 'hangul';
  const ch = String.fromCodePoint(cp);
  if (/\s/u.test(ch)) return 'space';
  if (/\p{N}/u.test(ch)) return 'digit';
  if (/[\p{L}_'’]/u.test(ch)) return 'latin';
  return 'other';
}

function fallbackWords(text: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < text.length) {
    const cls = scriptClass(text.codePointAt(i)!);
    let j = i + (text.codePointAt(i)! > 0xffff ? 2 : 1);
    if (cls !== 'other') {
      while (j < text.length) {
        const cp = text.codePointAt(j)!;
        // Marks stay with their base; otherwise a run ends at a class change.
        if (scriptClass(cp) !== cls && !/\p{M}/u.test(String.fromCodePoint(cp))) break;
        j += cp > 0xffff ? 2 : 1;
      }
    }
    out.push({ start: i, end: j, word: cls !== 'space' && cls !== 'other' });
    i = j;
  }
  return out;
}

const cache = new Map<string, Segment[]>();

/** Word segments of a paragraph's text, or null when it has no CJK (callers keep the plain rules). */
export function cjkWords(text: string): Segment[] | null {
  if (!CJK.test(text)) return null;
  let segments = cache.get(text);
  if (segments) return segments;
  if (wordSegmenter) {
    segments = [];
    for (const s of wordSegmenter.segment(text)) segments.push({ start: s.index, end: s.index + s.segment.length, word: !!s.isWordLike });
  } else segments = fallbackWords(text);
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(text, segments);
  return segments;
}

/** The segment holding a UTF-16 offset (offsets at the very end belong to no segment). */
export function segmentAt(segments: Segment[], offset: number): Segment | undefined {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid];
    if (offset < s.start) hi = mid - 1;
    else if (offset >= s.end) lo = mid + 1;
    else return s;
  }
  return undefined;
}

/** Whether an offset falls on a word boundary of CJK text. */
export function isWordBoundary(segments: Segment[], offset: number): boolean {
  const s = segmentAt(segments, offset);
  return !s || s.start === offset;
}

/**
 * The grapheme cluster around a UTF-16 offset as [start, end], or null when the text has nothing combinable
 * (or no Segmenter), in which case the caller's code point stepping is already right.
 */
export function graphemeAt(text: string, offset: number): [number, number] | null {
  if (!graphemeSegmenter || !COMBINING.test(text)) return null;
  const s = graphemeSegmenter.segment(text).containing(offset);
  return s ? [s.index, s.index + s.segment.length] : null;
}

/** A character inside a word. */
export const WORD = /[\p{L}\p{N}_'’]/u;
export const SPACE = /\s/u;
