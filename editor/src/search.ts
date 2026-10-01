// Find and replace.
import { type CommandResult, NO_CHANGE } from './types.ts';
import { WORD } from './segment.ts';

import { paragraphText, type Paragraph } from '@golemdocs/docx';
import { type Operation, type Pos } from '@golemdocs/ops';
import { cjkWords, isWordBoundary } from './segment.ts';
import { EditorLinks } from './links.ts';

export abstract class EditorSearch extends EditorLinks {
  /** Where each match of `text` starts in a paragraph (model offsets), not overlapping. */
  protected matches(paragraph: Paragraph, text: string, matchCase: boolean, wholeWord = false): number[] {
    if (!text) return [];
    const original = paragraphText(paragraph);
    const haystack = matchCase ? original : original.toLowerCase();
    const needle = matchCase ? text : text.toLowerCase();
    // Lower-casing can change a string's length (İ): then offsets no longer line up, so skip it.
    if (haystack.length !== original.length) return [];
    const found: number[] = [];
    const cjk = wholeWord ? cjkWords(original) : null;
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
      // Whole words only: what's either side isn't part of a word.
      if (cjk) {
        if (isWordBoundary(cjk, at) && isWordBoundary(cjk, at + needle.length)) found.push(at);
      } else if (!wholeWord || (!WORD.test(original[at - 1] ?? ' ') && !WORD.test(original[at + needle.length] ?? ' '))) found.push(at);
    }
    return found;
  }

  protected find(text: string, matchCase: boolean, backward: boolean, wholeWord: boolean): boolean {
    const list = this.paragraphs();
    if (!text || !list.length) return false;
    const [start, end] = this.ordered();
    const from = this.indexOf(backward ? start.paragraph : end.paragraph);
    // Every paragraph once from the selection, then the one it began in again for matches before it.
    for (let step = 0; step <= list.length; step++) {
      const k = (backward ? from - step : from + step) % list.length;
      const paragraph = list[(k + list.length) % list.length];
      let offsets = this.matches(paragraph, text, matchCase, wholeWord);
      if (step === 0) offsets = offsets.filter((o) => (backward ? o + text.length <= start.offset : o >= end.offset));
      else if (step === list.length) offsets = offsets.filter((o) => (backward ? o + text.length > start.offset : o < end.offset));
      const at = backward ? offsets[offsets.length - 1] : offsets[0];
      if (at === undefined) continue;
      this.selection = { anchor: { paragraph, offset: at }, focus: { paragraph, offset: at + text.length } };
      return true;
    }
    return false;
  }

  protected replaceAll(text: string, replacement: string, matchCase: boolean, wholeWord: boolean): CommandResult {
    const ops: Operation[] = [];
    let count = 0;
    let after: Pos | null = null;
    // A selection that is one of the matches (Change All from the spelling check) stays put, after its replacement.
    const [start, end] = this.ordered();
    let staysAt: Pos | null = null;
    for (const paragraph of this.paragraphs()) {
      const id = this.replica.id(paragraph);
      const found = this.matches(paragraph, text, matchCase, wholeWord);
      if (found.length && !after) after = { paragraph: id, offset: found[0] + replacement.length };
      if (paragraph === start.paragraph && start.paragraph === end.paragraph) {
        const index = found.indexOf(start.offset);
        if (index >= 0 && end.offset === start.offset + text.length) staysAt = { paragraph: id, offset: start.offset + index * (replacement.length - text.length) + replacement.length };
      }
      // From the end, so earlier offsets stay valid as the text changes length.
      for (const at of found.reverse()) {
        // Inserted at the end of the match first, so the replacement looks like the last of the words it replaces.
        if (replacement) ops.push({ type: 'insertText', paragraph: id, offset: at + text.length, text: replacement });
        ops.push({ type: 'delete', paragraph: id, from: at, to: at + text.length });
        count++;
      }
    }
    if (!after) return { ...NO_CHANGE, replaced: 0 };
    after = staysAt ?? after;
    // The caret ends after the first replacement (or the selected one); the old selection's offsets may no longer hold.
    const change = this.replica.edit(ops, { before: this.selectionIds, after: { anchor: after, focus: after } });
    return { ...this.changed(change.applied, { anchor: after, focus: after }), replaced: count };
  }
}
