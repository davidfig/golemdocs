// Markdown shortcuts as you type: "# " makes a heading, "- " a bullet, "**bold**" bold text.
//
// These only say what a typed line means; the layout worker applies it with the same commands
// the menus use, so the result is real headings, lists and marks, not the characters typed. A
// conversion is undone with Backspace right after it, which gives the typed characters back.

import { readTag, tagAddress } from '@golemdocs/docx';
import { readWikiLink } from '../formats/wikiLinks.ts';
import type { Action, Mark } from '../ui/actions.ts';

/** A line start that turned into formatting: the characters before the caret to remove, and what to apply. */
export interface BlockShortcut {
  remove: number;
  actions: Action[];
}

/** Marked text that is now complete: the markers and the text between them, as offsets in the paragraph. */
export interface InlineShortcut {
  /** Where the opening marker starts, and how long the markers are. */
  start: number;
  marker: number;
  mark: Mark;
}

export interface LinkShortcut {
  start: number;
  text: string;
  url: string;
}

/** What the paragraph is, as far as a shortcut cares. */
export interface LineContext {
  /** Already a heading, quote, code or other styled paragraph. */
  styled: boolean;
  /** Already in a list: bullets, numbers, check boxes. */
  listed: boolean;
}

const HEADING = /^(#{1,6}) $/;
const BULLET = /^[-*+] $/;
const NUMBER = /^1[.)] $/;
const QUOTE = /^> $/;
const TASK = /^\[( |x|X)\] $/;

/** The text typed so far on a line (up to the caret, ending with the space just typed) as a line start. */
export function blockShortcut(before: string, line: LineContext): BlockShortcut | null {
  if (!before.endsWith(' ')) return null;
  const remove = before.length;
  if (!line.styled && !line.listed) {
    const heading = HEADING.exec(before);
    if (heading) return { remove, actions: [{ kind: 'setStyle', style: `Heading ${heading[1].length}` }] };
    if (BULLET.test(before)) return { remove, actions: [{ kind: 'toggleList', list: 'bullet' }] };
    if (NUMBER.test(before)) return { remove, actions: [{ kind: 'toggleList', list: 'number' }] };
    if (QUOTE.test(before)) return { remove, actions: [{ kind: 'setStyle', style: 'Quote' }] };
  }
  // "[ ] " after a bullet ("- [ ] ") or on its own line makes a check box.
  const task = TASK.exec(before);
  if (task && !line.styled) return { remove, actions: [{ kind: 'toggleList', list: task[1] === ' ' ? 'task' : 'taskDone', force: true }] };
  return null;
}

const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const FENCE = /^```[\w+-]*$/;

/** What Enter does to a line that holds only this: a horizontal rule or a code block (as the characters typed up to the caret). */
export function lineShortcut(text: string, line: LineContext): 'rule' | 'code' | null {
  if (line.styled || line.listed) return null;
  if (RULE.test(text)) return 'rule';
  if (FENCE.test(text)) return 'code';
  return null;
}

// Opening and closing markers hug the text; the opening one follows a space or the start, so "2*3*4" and "snake_case_name" stay as typed.
const BOLD = /(?:^|[^\w*\\])(\*\*(?=[^\s*])(?:[^*]*[^\s*])?\*\*)$/;
const ITALIC_STAR = /(?:^|[^\w*\\])(\*(?=[^\s*])(?:[^*]*[^\s*])?\*)$/;
const ITALIC_UNDERSCORE = /(?:^|[^\w_\\])(_(?=[^\s_])(?:[^_]*[^\s_])?_)$/;
const STRIKE = /(?:^|[^\w~\\])(~~(?=[^\s~])(?:[^~]*[^\s~])?~~)$/;
const CODE = /(?:^|[^`\\])(`[^`]+`)$/;
const LINK = /(?:^|[^\\!])(\[([^\]\n]+)\]\(([^)\s]+)\))$/;

const INLINE: [RegExp, Mark, number][] = [
  [BOLD, 'bold', 2],
  [ITALIC_STAR, 'italic', 1],
  [ITALIC_UNDERSCORE, 'italic', 1],
  [STRIKE, 'strikethrough', 2],
  [CODE, 'code', 1],
];

/** The text before the caret, ending with the character just typed: does it finish a marked span? */
export function inlineShortcut(before: string): InlineShortcut | null {
  const last = before.charAt(before.length - 1);
  if (last !== '*' && last !== '_' && last !== '~' && last !== '`') return null;
  for (const [pattern, mark, marker] of INLINE) {
    const m = pattern.exec(before);
    if (m) return { start: before.length - m[1].length, marker, mark };
  }
  return null;
}

const WIKI_LINK = /(?:^|[^\\])(!?\[\[[^[\]\n]{1,400}\]\])$/;

/** The text before a space just typed ends with an Obsidian link: "[[Note]]", "[[Note#Heading]]" or "[[Note|label]]". */
export function wikiLinkShortcut(before: string): LinkShortcut | null {
  if (!before.endsWith(']]')) return null;
  const m = WIKI_LINK.exec(before);
  const link = m ? readWikiLink(m[1], 0) : null;
  return m && link && link.end === m[1].length ? { start: before.length - m[1].length, text: link.shown, url: link.address } : null;
}

const TAG_AT_END = /(?:^|[^\p{L}\p{N}\p{M}_&/#-])(#[\p{L}\p{N}\p{M}_/-]+)$/u;

/** The text before a space just typed ends with a tag ("#project", "#work/plans"): it becomes a link that searches for the tag. */
export function tagShortcut(before: string): LinkShortcut | null {
  const m = TAG_AT_END.exec(before);
  if (!m) return null;
  const start = before.length - m[1].length;
  // "[text](#section)" is a link to a heading, not a tag.
  if (before.slice(0, start).endsWith('](')) return null;
  const tag = readTag(before, start);
  // A tag ends at its last letter or digit: "#plan-" is not finished.
  return tag && tag.end === before.length ? { start, text: before.slice(start), url: tagAddress(tag.name) } : null;
}

const BARE_URL = /(?:^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"\]])$/i;

/** The text before a space just typed (or after a paste) ends with a web address: "https://example.com/page". */
export function urlShortcut(before: string): LinkShortcut | null {
  const m = BARE_URL.exec(before);
  return m ? { start: before.length - m[1].length, text: m[1], url: m[1] } : null;
}

/** The text before a space just typed ends with "[text](url)". */
export function linkShortcut(before: string): LinkShortcut | null {
  if (!before.endsWith(')')) return null;
  const m = LINK.exec(before);
  return m ? { start: before.length - m[1].length, text: m[2], url: m[3] } : null;
}
