// SPDX-License-Identifier: MIT
// Tags: `#project` written in a document's text. A tag is an ordinary hyperlink whose address is `tag:`
// and its name (`tag:project`), like a link to another document is `doc:` and a title, so it is a
// link in every format and means the same wherever the document goes. In Markdown it is written
// `#project`. The search index reads tags straight from the text with `readTag`, so a `#tag` typed
// in any document counts, linked or not.

export const TAG_SCHEME = 'tag:';

/** The longest tag name that counts (characters). */
export const MAX_TAG_CHARS = 80;

/** What may be in a tag name: letters, digits, `_`, `-`, and `/` (a tag inside another: `#work/plans`). */
const NAME_CHAR = /[\p{L}\p{N}\p{M}_\-/]/u;
/** What may not come right before the `#`: a word (`C#`), another `#`, an entity or address (`&#39;`, `/page#top`). */
const BEFORE = /[\p{L}\p{N}\p{M}_&/#\-]/u;

/** The address of a link to the tag `name` (without the `#`). */
export function tagAddress(name: string): string {
  return `${TAG_SCHEME}${name}`;
}

/** The tag name (without the `#`) a `tag:` address names, or null when it is any other kind of address. */
export function parseTagAddress(url: string): string | null {
  if (!url.toLowerCase().startsWith(TAG_SCHEME)) return null;
  let rest = url.slice(TAG_SCHEME.length);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // Not escaped: as written.
  }
  rest = rest.replace(/^#/, '').trim();
  return rest && rest.length <= MAX_TAG_CHARS ? rest : null;
}

/** A tag name as tags are compared: case ignored (`#Plan` and `#plan` are one tag). */
export const normalizeTag = (name: string): string => name.normalize('NFC').toLocaleLowerCase();

/**
 * A tag starting at `at` in `text`, or null when there isn't one there: it has to start the text or follow a space
 * or punctuation (not a letter: `C#`), has to hold a letter (`#1` is a number, not a tag), and stops before a trailing
 * `-` or `/`. `name` is as written, without the `#`; `end` is where the tag stops.
 */
export function readTag(text: string, at: number): { name: string; end: number } | null {
  if (text[at] !== '#') return null;
  if (at > 0) {
    // Two code units back, so a letter outside the first plane is seen whole.
    const before = [...text.slice(Math.max(0, at - 2), at)].pop()!;
    if (BEFORE.test(before)) return null;
  }
  let end = at + 1;
  while (end < text.length && end - at - 1 < MAX_TAG_CHARS + 1) {
    const point = String.fromCodePoint(text.codePointAt(end)!);
    if (!NAME_CHAR.test(point)) break;
    end += point.length;
  }
  while (end > at + 1 && /[-/]/.test(text[end - 1]!)) end--;
  const name = text.slice(at + 1, end);
  if (!name || name.length > MAX_TAG_CHARS || !/\p{L}/u.test(name)) return null;
  return { name, end };
}

/** Every tag in `text`, as written, in order (a tag used twice is listed twice). */
export function tagsIn(text: string): string[] {
  const found: string[] = [];
  for (let at = text.indexOf('#'); at >= 0; at = text.indexOf('#', at + 1)) {
    const tag = readTag(text, at);
    if (tag) {
      found.push(tag.name);
      at = tag.end - 1;
    }
  }
  return found;
}
