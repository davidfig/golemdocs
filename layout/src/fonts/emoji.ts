// SPDX-License-Identifier: MIT
// Emoji in text: finding the sequences that draw as one color glyph (UTS #51), and which emoji page
// holds each. Emoji are drawn from color sprite atlases (scripts/fonts/emoji.ts), split into pages
// that load only for a document using one of their emoji, like the other font pages.

/** The font page group the emoji pages are in (ManifestFamily.page.group). */
export const EMOJI_GROUP = 'emoji';

const ZWJ = 0x200d;
const VS15 = 0xfe0e;
const VS16 = 0xfe0f;
const KEYCAP = 0x20e3;
const TAG_END = 0xe007f;

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const PRESENTATION = /\p{Emoji_Presentation}/u;

const isModifier = (cp: number) => cp >= 0x1f3fb && cp <= 0x1f3ff;
const isRegional = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff;
const isTag = (cp: number) => cp >= 0xe0020 && cp <= 0xe007e;
const isKeycapBase = (cp: number) => (cp >= 0x30 && cp <= 0x39) || cp === 0x23 || cp === 0x2a;
const units = (cp: number) => (cp > 0xffff ? 2 : 1);

const pictographic = new Map<number, boolean>();
const presentation = new Map<number, boolean>();
/** Whether a code point is Extended_Pictographic (cached: the regex is slow next to a map). */
function isPictographic(cp: number): boolean {
  if (cp < 0xa9) return false;
  let is = pictographic.get(cp);
  if (is === undefined) pictographic.set(cp, (is = PICTOGRAPHIC.test(String.fromCodePoint(cp))));
  return is;
}
function isPresentation(cp: number): boolean {
  let is = presentation.get(cp);
  if (is === undefined) presentation.set(cp, (is = PRESENTATION.test(String.fromCodePoint(cp))));
  return is;
}

/**
 * The length (UTF-16 units) of the emoji that starts at `i`, or 0 if no emoji starts there: a flag (a
 * pair of regional indicators), a keycap, or pictographs joined by zero-width joiners, each with its
 * variation selector, skin tone and tags. A pictograph that shows as text by default (☺, ❤, ↔) is an
 * emoji only when something asks for that (U+FE0F, a skin tone, a joiner), and U+FE0E keeps any as text.
 */
export function emojiAt(text: string, i: number): number {
  const first = text.charCodeAt(i);
  if (first < 0xa9) {
    if (!isKeycapBase(first)) return 0;
    let j = i + 1;
    if (text.charCodeAt(j) === VS16) j++;
    return text.charCodeAt(j) === KEYCAP ? j + 1 - i : 0;
  }
  const cp = text.codePointAt(i)!;
  // A skin tone on its own shows as a swatch.
  if (isModifier(cp)) return 2;
  if (isRegional(cp)) {
    const next = text.codePointAt(i + 2);
    return next !== undefined && isRegional(next) ? 4 : 2;
  }
  if (!isPictographic(cp)) return 0;
  let j = i;
  let elements = 0;
  let emoji = false;
  for (;;) {
    // One element: a pictograph, its presentation selector, skin tone and tags.
    const base = text.codePointAt(j)!;
    let k = j + units(base);
    let selector = 0;
    const next = text.charCodeAt(k);
    if (next === VS16 || next === VS15) {
      selector = next;
      k++;
    }
    if (selector === VS15 && elements === 0) return 0;
    const tone = text.codePointAt(k);
    if (tone !== undefined && isModifier(tone)) {
      k += 2;
      emoji = true;
    }
    let tags = k;
    while (tags < text.length && isTag(text.codePointAt(tags)!)) tags += 2;
    if (tags > k && text.codePointAt(tags) === TAG_END) {
      k = tags + 2;
      emoji = true;
    }
    if (selector === VS16 || isPresentation(base)) emoji = true;
    elements++;
    j = k;
    // Joined to another pictograph?
    if (text.charCodeAt(j) !== ZWJ) break;
    const after = text.codePointAt(j + 1);
    if (after === undefined || !isPictographic(after)) break;
    j++;
    emoji = true;
  }
  return emoji ? j - i : 0;
}

/** The code points of an emoji's text, without variation selectors: how the emoji pages name their glyphs. */
export function emojiSequence(text: string, from = 0, to = text.length): number[] {
  const out: number[] = [];
  for (let i = from; i < to; ) {
    const cp = text.codePointAt(i)!;
    if (cp !== VS16 && cp !== VS15) out.push(cp);
    i += units(cp);
  }
  return out;
}

/**
 * Which page an emoji is on, as a number its page's coverage holds: its first code point, offset by
 * its skin tone (each tone's sequences are pages of their own, so a document with one tone does not
 * fetch the other four).
 */
export function emojiPageKey(sequence: readonly number[]): number {
  const tone = sequence.find(isModifier);
  return sequence[0] + (tone === undefined || tone === sequence[0] ? 0 : (tone - 0x1f3fa) * 0x200000);
}

/** Adds the page keys of the emoji a string holds to a set. */
export function addEmoji(text: string, into: Set<number>): void {
  for (let i = 0; i < text.length; ) {
    const length = emojiAt(text, i);
    if (length) {
      const sequence = emojiSequence(text, i, i + length);
      into.add(emojiPageKey(sequence));
      // A sequence the pages may not have draws as its parts: they may be on other pages.
      for (let from = 0, j = 0; j <= sequence.length; j++) {
        if (j < sequence.length && sequence[j] !== ZWJ) continue;
        if (from > 0 || j < sequence.length) into.add(emojiPageKey(sequence.slice(from, j)));
        from = j + 1;
      }
      i += length;
    } else i++;
  }
}

/** Whether a string might hold an emoji (a fast test before the scan). */
export const MAYBE_EMOJI = /[©®‼-㊙\ud83c-\ud83e⃣]/;

/** Characters that take no room when no font draws them (joiners, variation selectors, tags). */
export function isInvisible(cp: number): boolean {
  return (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0020 && cp <= 0xe007f) || cp === 0x2060 || cp === 0xfeff;
}
